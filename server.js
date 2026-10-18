const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const QRCode = require("qrcode");
const { Redis } = require("@upstash/redis");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_FILE = path.join(__dirname, "quiz-config.json");
const ADMIN_PASSWORD = process.env.QUIZ_ADMIN_PASSWORD || crypto.randomBytes(16).toString("hex");
const redisUrl =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const redisToken =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
if (Boolean(redisUrl) !== Boolean(redisToken)) {
  throw new Error("Set both Upstash Redis REST URL and token environment variables.");
}
if (process.env.VERCEL && (!redisUrl || !process.env.QUIZ_ADMIN_PASSWORD)) {
  throw new Error(
    "Vercel deployments require Upstash Redis credentials and QUIZ_ADMIN_PASSWORD environment variables.",
  );
}
const redis = redisUrl ? new Redis({ url: redisUrl, token: redisToken }) : null;
const REDIS_STATE_KEY = "realtime-quiz:state";
const REDIS_LOCK_KEY = "realtime-quiz:state-lock";
let defaultQuestions = [];
try {
  const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  if (Array.isArray(savedConfig.questions) && savedConfig.questions.length > 0) {
    defaultQuestions = savedConfig.questions;
  }
} catch {}

const MAX_QUESTIONS = 100;
const OPTION_COUNT = 4;

function normalizeQuestions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) {
    throw new Error(`A quiz must contain between 1 and ${MAX_QUESTIONS} questions.`);
  }
  return value.map((question, index) => {
    if (!question || typeof question !== "object") {
      throw new Error(`Question ${index + 1} is invalid.`);
    }
    const prompt = typeof question.prompt === "string" ? question.prompt.trim() : "";
    const options = Array.isArray(question.options)
      ? question.options.map((option) => (typeof option === "string" ? option.trim() : ""))
      : [];
    if (!prompt || prompt.length > 2000) {
      throw new Error(`Question ${index + 1} must have a prompt of 1 to 2000 characters.`);
    }
    if (
      options.length !== OPTION_COUNT ||
      options.some((option) => !option || option.length > 500)
    ) {
      throw new Error(`Question ${index + 1} must have four answers of 1 to 500 characters each.`);
    }
    if (!Number.isInteger(question.correct) || question.correct < 0 || question.correct >= OPTION_COUNT) {
      throw new Error(`Question ${index + 1} must have one correct answer selected.`);
    }
    const scenarioId = Number.isInteger(question.scenarioId)
      ? question.scenarioId
      : Math.floor(index / 4) + 1;
    const type = typeof question.type === "string" ? question.type.trim() : "apply";
    const typeLabel = typeof question.typeLabel === "string" && question.typeLabel.trim()
      ? question.typeLabel.trim()
      : (type.charAt(0).toUpperCase() + type.slice(1));

    return {
      id: question.id || index + 1,
      scenarioId,
      scenarioTitle: typeof question.scenarioTitle === "string" ? question.scenarioTitle.trim() : `Scenario ${scenarioId}`,
      scenarioText: typeof question.scenarioText === "string" ? question.scenarioText.trim() : "",
      scenarioSource: typeof question.scenarioSource === "string" ? question.scenarioSource.trim() : "",
      type,
      typeLabel,
      prompt,
      options,
      correct: question.correct,
      explanation: typeof question.explanation === "string" ? question.explanation.trim() : "",
      slides: Array.isArray(question.slides) ? question.slides.filter(Number.isInteger) : []
    };
  });
}

const participants = new Map();
const adminSessions = new Set();
let questions = defaultQuestions.map((question) => ({ ...question, options: [...question.options] }));
let phase = "lobby";
let startedAt = null;
let roundId = 1;
let sharedRequestQueue = Promise.resolve();
let configuredJoinUrl = process.env.QUIZ_PUBLIC_URL
  ? normalizeJoinUrl(process.env.QUIZ_PUBLIC_URL)
  : null;

if (!redis) {
  try {
    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (savedConfig.joinUrl !== undefined) {
      if (typeof savedConfig.joinUrl !== "string") {
        throw new Error("Saved quiz configuration must contain a joinUrl string.");
      }
      configuredJoinUrl = configuredJoinUrl || normalizeJoinUrl(savedConfig.joinUrl);
    }
    if (savedConfig.questions !== undefined) {
      questions = normalizeQuestions(savedConfig.questions);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read ${CONFIG_FILE}: ${error.message}`);
    }
  }
}
questions = normalizeQuestions(questions);
const initialJoinUrl = configuredJoinUrl;

async function acquireStateLock() {
  const lockToken = crypto.randomBytes(24).toString("hex");
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const acquired = await redis.set(REDIS_LOCK_KEY, lockToken, { nx: true, px: 10_000 });
    if (acquired === "OK") return lockToken;
    const jitter = 25 + Math.floor(Math.random() * 35);
    await new Promise((resolve) => setTimeout(resolve, jitter));
  }
  throw new Error("Quiz state is busy. Please retry the request.");
}

async function releaseStateLock(lockToken) {
  await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    [REDIS_LOCK_KEY],
    [lockToken],
  );
}

async function loadSharedState() {
  const stored = await redis.get(REDIS_STATE_KEY);
  if (stored === null) {
    participants.clear();
    adminSessions.clear();
    phase = "lobby";
    startedAt = null;
    roundId = 1;
    configuredJoinUrl = initialJoinUrl;
    questions = normalizeQuestions(defaultQuestions);
    return;
  }
  const state = typeof stored === "string" ? JSON.parse(stored) : stored;
  if (
    !state ||
    !Array.isArray(state.participants) ||
    !Array.isArray(state.adminSessions) ||
    !["lobby", "live", "ended"].includes(state.phase) ||
    !Number.isSafeInteger(state.roundId)
  ) {
    throw new Error("Stored quiz state is invalid. Check the configured Upstash Redis database.");
  }
  participants.clear();
  for (const participant of state.participants) {
    participants.set(participant.id, participant);
  }
  adminSessions.clear();
  for (const token of state.adminSessions) {
    adminSessions.add(token);
  }
  phase = state.phase;
  startedAt = state.startedAt;
  roundId = state.roundId;
  configuredJoinUrl = state.configuredJoinUrl;
  questions = normalizeQuestions(state.questions || defaultQuestions);
}

async function saveSharedState() {
  await redis.set(
    REDIS_STATE_KEY,
    JSON.stringify({
      phase,
      startedAt,
      roundId,
      configuredJoinUrl,
      questions,
      participants: [...participants.values()],
      adminSessions: [...adminSessions],
    }),
  );
}

function json(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    const timeout = setTimeout(() => {
      reject(new Error("Request timed out reading body"));
      request.destroy();
    }, 10000);
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16_384) {
        clearTimeout(timeout);
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    request.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function getScore(participant) {
  return participant.answers.reduce(
    (score, answer, index) =>
      score + (answer === null ? 0 : answer === questions[index].correct ? 1 : 0),
    0,
  );
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function formatDuration(milliseconds) {
  const totalSeconds = milliseconds / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(3).padStart(6, "0");
  return `${minutes}:${seconds}`;
}

function getState(participantId, isAdmin = false, request) {
  const leaderboard = [...participants.values()]
    .filter((participant) => participant.completedAt !== null)
    .map((participant) => ({
      id: participant.id,
      name: participant.name,
      score: getScore(participant),
      completedAt: participant.completedAt,
    }))
    .sort((a, b) => b.score - a.score || a.completedAt - b.completedAt)
    .map(({ completedAt, ...participant }, index) => ({
      ...participant,
      rank: index + 1,
    }));

  const participant = participants.get(participantId);
  const isParticipantCompleted = Boolean(participant && participant.completedAt !== null);
  const showReviewDetails = isAdmin || phase === "ended" || isParticipantCompleted;

  const state = {
    phase,
    startedAt,
    roundId,
    joinUrl: getJoinUrl(request),
    isAdmin,
    quizTitle: "Presentation 3 — Cyber Fraud & the Money Trail: Scenario Quiz",
    quizSubtitle: "Law as on October 2026 · Reader v6 (56 slides) · 6 Scenarios · 24 Questions",
    timeMinutes: 10,
    questions: questions.map((q) => ({
      id: q.id,
      scenarioId: q.scenarioId,
      scenarioTitle: q.scenarioTitle,
      scenarioText: q.scenarioText,
      scenarioSource: q.scenarioSource,
      type: q.type,
      typeLabel: q.typeLabel,
      prompt: q.prompt,
      options: q.options,
      ...(showReviewDetails ? { correct: q.correct, explanation: q.explanation, slides: q.slides } : {}),
    })),
    participantCount: participants.size,
    submittedAnswers: [...participants.values()].reduce(
      (total, p) =>
        total + p.answers.filter((answer) => answer !== null).length,
      0,
    ),
    completedCount: leaderboard.length,
    leaderboard,
  };
  if (participant) {
    state.participant = {
      answers: participant.answers,
      completed: participant.completedAt !== null,
      score: getScore(participant),
      correctOptionIndexes:
        participant.completedAt !== null || phase === "ended"
          ? questions.map(({ correct }) => correct)
          : null,
    };
  }
  return state;
}

function getAdminToken(request) {
  const authorization = request.headers.authorization || "";
  const match = authorization.match(/^Bearer (.+)$/);
  return match ? match[1] : "";
}

function isAdminRequest(request) {
  return adminSessions.has(getAdminToken(request));
}

function getJoinUrl(request) {
  if (configuredJoinUrl) return configuredJoinUrl;
  const forwardedProto = request.headers["x-forwarded-proto"]
    ?.split(",")[0]
    .trim()
    .toLowerCase();
  const protocol =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : request.socket.encrypted
        ? "https"
        : "http";
  const host = request.headers.host;
  if (!host) {
    throw new Error("Cannot determine the public join URL: the request has no Host header.");
  }
  let origin;
  try {
    origin = new URL(`${protocol}://${host}`);
  } catch {
    throw new Error("Cannot determine the public join URL: the request Host header is invalid.");
  }
  return normalizeJoinUrl(`${origin.origin}/?join=1`);
}

function normalizeJoinUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Enter a valid full join URL.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Enter a valid full join URL, including http:// or https://.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Join URL must use http:// or https:// and cannot include credentials.");
  }
  parsed.searchParams.set("join", "1");
  parsed.hash = "";
  return parsed.toString();
}

async function saveLocalConfig(joinUrl, questionList) {
  if (redis) return;
  const temporaryFile = `${CONFIG_FILE}.tmp`;
  let baseConfig = {};
  try {
    baseConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {}
  const config = {
    ...baseConfig,
    ...(joinUrl ? { joinUrl } : {}),
    questions: questionList,
  };
  await fs.promises.writeFile(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
  await fs.promises.rename(temporaryFile, CONFIG_FILE);
}

async function saveJoinUrl(value) {
  const normalized = normalizeJoinUrl(value);
  await saveLocalConfig(normalized, questions);
  configuredJoinUrl = normalized;
}

async function updateQuestions(body) {
  if (phase !== "lobby") {
    return { status: 409, error: "Questions can only be changed while the quiz is in the lobby." };
  }

  let nextQuestions;
  if (body.action === "add") {
    if (questions.length >= MAX_QUESTIONS) {
      return { status: 400, error: `A quiz can contain at most ${MAX_QUESTIONS} questions.` };
    }
    try {
      nextQuestions = normalizeQuestions([...questions, body.question]);
    } catch (error) {
      return { status: 400, error: error.message };
    }
  } else if (body.action === "edit" || body.action === "delete") {
    if (!Number.isInteger(body.index) || body.index < 0 || body.index >= questions.length) {
      return { status: 400, error: "Choose a valid question to update." };
    }
    const updatedQuestions = [...questions];
    if (body.action === "edit") updatedQuestions[body.index] = body.question;
    else updatedQuestions.splice(body.index, 1);
    try {
      nextQuestions = normalizeQuestions(updatedQuestions);
    } catch (error) {
      return { status: 400, error: error.message };
    }
  } else {
    return { status: 400, error: "Choose add, edit, or delete for a question." };
  }

  await saveLocalConfig(configuredJoinUrl, nextQuestions);
  questions = nextQuestions;
  participants.forEach((participant) => {
    participant.answers = Array(questions.length).fill(null);
    participant.completedAt = null;
  });
  roundId += 1;
  return null;
}

function passwordsMatch(candidate) {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(ADMIN_PASSWORD);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function handleApiRequest(request, response, url) {
  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
    if (!passwordsMatch(body.password)) {
      return json(response, 401, { error: "Incorrect admin passcode." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.add(token);
    return json(response, 200, { token });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    adminSessions.delete(getAdminToken(request));
    return json(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    return json(
      response,
      200,
      getState(
        url.searchParams.get("participantId"),
        isAdminRequest(request),
        request,
      ),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/results.csv") {
    if (!isAdminRequest(request)) {
      return json(response, 401, { error: "Admin passcode required." });
    }
    if (phase !== "ended") {
      return json(response, 409, { error: "Wrap the quiz before downloading results." });
    }

    const rankedIds = getState(undefined, true, request).leaderboard.map(({ id }) => id);
    const rankedParticipants = rankedIds.map((id) => participants.get(id));
    const unrankedParticipants = [...participants.values()]
      .filter((participant) => participant.completedAt === null)
      .sort(
        (a, b) =>
          getScore(b) - getScore(a) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
    const orderedParticipants = [
      ...rankedParticipants,
      ...unrankedParticipants,
    ];
    const headers = [
      "Rank",
      "Name",
      "Status",
      ...questions.map(
        (question, index) =>
          `Q${index + 1} [Scenario ${question.scenarioId} · ${question.typeLabel || question.type}]: ${question.prompt}`,
      ),
      "Score",
      "Total time",
    ];
    const rows = orderedParticipants.map((participant, index) => {
      const completed = participant.completedAt !== null;
      const answers = participant.answers.map((answer, questionIndex) => {
        if (answer === null) return "Not answered";
        const answerText = questions[questionIndex].options[answer];
        return `${answerText} (${answer === questions[questionIndex].correct ? "Correct" : "Incorrect"})`;
      });
      return [
        completed ? index + 1 : "",
        participant.name,
        completed ? "Completed" : "Not completed",
        ...answers,
        getScore(participant),
        completed ? formatDuration(participant.completedAt - startedAt) : "Not completed",
      ];
    });
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="quiz-scoresheet.csv"',
      "Cache-Control": "no-store",
    });
    response.end(`\uFEFF${csv}`);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/qr") {
    try {
      const svg = await QRCode.toString(getJoinUrl(request), {
        type: "svg",
        width: 280,
        margin: 1,
        color: { dark: "#101523", light: "#ffffff" },
      });
      response.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(svg);
    } catch (error) {
      console.error("Could not generate the join QR code:", error);
      json(response, 500, { error: "Could not generate the join QR code." });
    }
    return;
  }

  if (request.method !== "POST") {
    return json(response, 405, { error: "Method not allowed." });
  }

  if (
    ["/api/start", "/api/end", "/api/reset", "/api/admin/join-url", "/api/admin/questions"].includes(url.pathname) &&
    !isAdminRequest(request)
  ) {
    return json(response, 401, { error: "Admin passcode required." });
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return json(response, 400, { error: error.message });
  }

  if (url.pathname === "/api/admin/questions") {
    const error = await updateQuestions(body);
    if (error) return json(response, error.status, { error: error.error });
    return json(response, 200, getState(undefined, true, request));
  }

  if (url.pathname === "/api/join") {
    if (phase === "ended") {
      return json(response, 409, { error: "This quiz has ended." });
    }
    const id = typeof body.id === "string" ? body.id.slice(0, 80) : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 24) : "";
    if (!id || !name) {
      return json(response, 400, { error: "Enter a name to join the quiz." });
    }
    if (!participants.has(id)) {
      participants.set(id, {
        id,
        name,
        answers: Array(questions.length).fill(null),
        completedAt: null,
      });
    } else {
      participants.get(id).name = name;
    }
    return json(response, 200, {
      participantId: id,
      state: getState(id, isAdminRequest(request), request),
    });
  }

  if (url.pathname === "/api/start") {
    if (phase !== "lobby") {
      return json(response, 409, { error: "The quiz has already started." });
    }
    phase = "live";
    startedAt = Date.now();
    return json(response, 200, getState(undefined, true, request));
  }

  if (url.pathname === "/api/end") {
    if (phase !== "live") {
      return json(response, 409, { error: "There is no live quiz to end." });
    }
    phase = "ended";
    return json(response, 200, getState(undefined, true, request));
  }

  if (url.pathname === "/api/reset") {
    participants.clear();
    phase = "lobby";
    startedAt = null;
    roundId += 1;
    return json(response, 200, getState(undefined, true, request));
  }

  if (url.pathname === "/api/admin/join-url") {
    try {
      await saveJoinUrl(body.joinUrl);
    } catch (error) {
      if (error.message.startsWith("Enter a valid") || error.message.startsWith("Join URL")) {
        return json(response, 400, { error: error.message });
      }
      throw error;
    }
    return json(response, 200, getState(undefined, true, request));
  }

  if (url.pathname === "/api/answer") {
    const participant = participants.get(body.id);
    if (!participant) {
      return json(response, 404, { error: "Join the quiz before submitting an answer." });
    }
    if (phase !== "live") {
      return json(response, 409, { error: "The quiz is not accepting answers right now." });
    }
    const { questionIndex, optionIndex } = body;
    if (
      !Number.isInteger(questionIndex) ||
      questionIndex < 0 ||
      questionIndex >= questions.length ||
      !Number.isInteger(optionIndex) ||
      optionIndex < 0 ||
      optionIndex >= questions[questionIndex].options.length
    ) {
      return json(response, 400, { error: "Choose a valid answer." });
    }
    participant.answers[questionIndex] = optionIndex;
    if (participant.answers.every((answer) => answer !== null)) {
      participant.completedAt = participant.completedAt || Date.now();
    }
    return json(response, 200, {
      score: getScore(participant),
      correctAnswers: participant.answers.map((answer, index) =>
        answer === null ? null : answer === questions[index].correct,
      ),
      state: getState(body.id, isAdminRequest(request), request),
    });
  }

  return json(response, 404, { error: "Not found." });
}

async function handleApi(request, response, url) {
  if (!redis) return handleApiRequest(request, response, url);

  let releaseLocalQueue;
  const previousLocalRequest = sharedRequestQueue;
  sharedRequestQueue = new Promise((resolve) => {
    releaseLocalQueue = resolve;
  });
  await previousLocalRequest;

  const mutatingRequest = request.method === "POST";
  let lockToken;
  try {
    if (mutatingRequest) lockToken = await acquireStateLock();
    await loadSharedState();
    let responseStatus = 200;
    let responseHeaders;
    let responseBody;
    let responseEnded = false;
    const bufferedResponse = mutatingRequest
      ? new Proxy(response, {
          get(target, property) {
            if (property === "writeHead") {
              return (status, headers) => {
                responseStatus = status;
                responseHeaders = headers;
                return response;
              };
            }
            if (property === "end") {
              return (body) => {
                responseBody = body;
                responseEnded = true;
                return response;
              };
            }
            return Reflect.get(target, property, target);
          },
        })
      : response;
    await handleApiRequest(request, bufferedResponse, url);
    if (mutatingRequest) await saveSharedState();
    if (lockToken) {
      await releaseStateLock(lockToken);
      lockToken = null;
    }
    if (responseEnded) {
      response.writeHead(responseStatus, responseHeaders);
      response.end(responseBody);
    }
  } finally {
    if (lockToken) await releaseStateLock(lockToken);
    releaseLocalQueue();
  }
}

function serveFile(request, response, pathname) {
  let requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  if (requestedPath === "/admin" || requestedPath === "/admin/") {
    requestedPath = "/admin.html";
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Could not read file");
      return;
    }
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(contents);
  });
}

async function vercelHandler(request, response) {
  try {
    const protocol = request.headers["x-forwarded-proto"] || "https";
    const host = request.headers.host || process.env.VERCEL_URL || "localhost";
    const url = new URL(request.url || "/", `${protocol.split(",")[0]}://${host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("Method not allowed");
      return;
    }

    let requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    if (requestedPath === "/admin" || requestedPath === "/admin/") {
      requestedPath = "/admin.html";
    }
    const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
    if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    let contents;
    try {
      contents = await fs.promises.readFile(filePath);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Could not read file");
      return;
    }
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(contents);
  } catch (error) {
    console.error("Request failed:", error);
    if (!response.headersSent) {
      json(response, 500, { error: "An unexpected server error occurred." });
    }
  }
}

if (require.main === module) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      handleApi(request, response, url).catch((error) => {
        console.error("Request failed:", error);
        if (!response.headersSent) {
          json(response, 500, { error: "An unexpected server error occurred." });
        }
      });
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("Method not allowed");
      return;
    }
    serveFile(request, response, url.pathname);
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Quiz dashboard: http://localhost:${PORT}`);
    console.log(
      configuredJoinUrl
        ? `Configured audience URL: ${configuredJoinUrl}`
        : "Audience QR uses the host/domain used to open the dashboard.",
    );
    if (!process.env.QUIZ_ADMIN_PASSWORD) {
      console.log(`Generated admin passcode (visible only in this server console): ${ADMIN_PASSWORD}`);
    }
  });
}

module.exports = vercelHandler;
module.exports.handleApi = handleApi;
