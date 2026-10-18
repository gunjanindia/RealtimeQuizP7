const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const isParticipant = new URLSearchParams(window.location.search).has("join");
const adminTokenKey = "realtime-quiz-admin-token";
const letters = ["A", "B", "C", "D"];
let latestState = null;
let participantId = localStorage.getItem("realtime-quiz-participant");
let participantName = localStorage.getItem("realtime-quiz-name") || "";
let participantRoundId = Number(localStorage.getItem("realtime-quiz-round-id"));
if (!Number.isSafeInteger(participantRoundId) || participantRoundId < 1) {
  participantRoundId = null;
}
let participantBusy = false;
let participantRefreshing = false;
let participantViewKey = null;
let toastTimer;
let busyWatchdogTimer = null;
let activePollController = null;

function setBusyState(busy) {
  participantBusy = busy;
  if (busyWatchdogTimer) {
    clearTimeout(busyWatchdogTimer);
    busyWatchdogTimer = null;
  }
  if (busy) {
    // 7s max watchdog: guarantees UI will NEVER stay stuck if anything hangs
    busyWatchdogTimer = setTimeout(() => {
      console.warn("Safety watchdog: resetting busy participant state");
      participantBusy = false;
      participantViewKey = null;
      hideQuestionLoader();
      enableAnswerButtons();
    }, 7000);
  }
}

function getAdminToken() {
  return localStorage.getItem(adminTokenKey) || sessionStorage.getItem(adminTokenKey) || "";
}

function removeAdminToken() {
  localStorage.removeItem(adminTokenKey);
  sessionStorage.removeItem(adminTokenKey);
}

async function request(path, options = {}) {
  const token = getAdminToken();
  const timeoutMs = options.timeout || 7000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let combinedSignal = controller.signal;
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException("Aborted", "AbortError");
    }
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(path, {
      ...options,
      signal: combinedSignal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    clearTimeout(timeoutId);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Invalid response received from server. Please try again.");
    }
    if (!response.ok) {
      if (response.status === 401 && token) removeAdminToken();
      throw new Error(data.error || "Something went wrong. Please try again.");
    }
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error("Request timed out. Please check your connection and try again.");
    }
    throw error;
  }
}

async function downloadScoresheet() {
  const token = getAdminToken();
  const response = await fetch("/api/results.csv", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const data = await response.json();
    if (response.status === 401 && token) removeAdminToken();
    throw new Error(data.error || "Could not download the scoresheet.");
  }

  const fileUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = fileUrl;
  link.download = "quiz-scoresheet.csv";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

function confirmAction(title, message, confirmLabel) {
  let overlay = document.querySelector("#action-confirmation");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "action-confirmation";
    overlay.className = "confirmation-overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-message">
        <div class="confirmation-eyebrow">PLEASE CONFIRM</div>
        <h2 class="confirmation-title" id="confirmation-title"></h2>
        <p class="confirmation-message" id="confirmation-message"></p>
        <div class="confirmation-actions">
          <button class="button confirmation-cancel" type="button">Cancel</button>
          <button class="button confirmation-accept" type="button"></button>
        </div>
      </section>`;
    overlay.querySelector(".confirmation-cancel").addEventListener("click", () => overlay.completeConfirmation?.(false));
    overlay.querySelector(".confirmation-accept").addEventListener("click", () => overlay.completeConfirmation?.(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.completeConfirmation?.(false);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        overlay.completeConfirmation?.(false);
      }
    });
    document.body.append(overlay);
  }
  overlay.querySelector(".confirmation-title").textContent = title;
  overlay.querySelector(".confirmation-message").textContent = message;
  overlay.querySelector(".confirmation-accept").textContent = confirmLabel;
  return new Promise((resolve) => {
    overlay.completeConfirmation = (confirmed) => {
      overlay.hidden = true;
      overlay.completeConfirmation = null;
      resolve(confirmed);
    };
    overlay.hidden = false;
    overlay.querySelector(".confirmation-cancel").focus();
  });
}

function phaseLabel(phase) {
  return phase === "live" ? "Live now" : phase === "ended" ? "Quiz complete" : "Waiting to start";
}

function renderDashboard(state) {
  const joinUrl = state.joinUrl;
  const joinHref = escapeHtml(joinUrl);
  const leaderboard = state.leaderboard.length
    ? state.leaderboard
      .slice(0, 8)
      .map(
        (player) => `
            <div class="leader-row">
              <span class="leader-rank ${player.rank <= 3 ? "top-rank" : ""}">${String(player.rank).padStart(2, "0")}</span>
              <span class="leader-avatar">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span>
              <span class="leader-name">${escapeHtml(player.name)}</span>
              <span class="leader-score">${player.score}<small> / ${state.questions.length}</small></span>
            </div>`,
      )
      .join("")
    : `<div class="empty-state"><span class="empty-icon">✳</span><p>Your top players will<br />show up here.</p></div>`;

  app.innerHTML = `
    <div class="dashboard-shell">
      <header class="topbar">
        <a class="brand" href="/" aria-label="Quiz Night home">
          <span class="brand-mark">q<span>.</span></span>
          <span>quiz<span class="brand-light">night</span></span>
        </a>
        <div class="topbar-center">
          <div class="event-tag"><span class="status-dot ${state.phase === "live" ? "is-live" : ""}"></span>${phaseLabel(state.phase)}</div>
          <span class="quiz-length"><span class="length-dot"></span>${state.questions.length} questions</span>
        </div>
        <div class="topbar-actions">
          <button class="topbar-link-button" type="button" id="share-link">Copy join link <span>↗</span></button>
          <a class="topbar-link-button admin-portal-btn" href="/admin" id="admin-link">Admin <span>⚙</span></a>
        </div>
      </header>

      <main class="dashboard-main stage-mode">
        ${state.isAdmin
      ? `<div class="host-quick-bar">
                <div class="host-quick-info">
                  <span class="host-quick-badge">HOST MODE</span>
                  <span class="host-quick-round">Round #${state.roundId} · Live presenter controls</span>
                </div>
                <div class="quiz-controls">
                  <button class="button button-primary" id="start-quiz" ${state.phase !== "lobby" ? "disabled" : ""}><span>Start quiz</span><span class="button-arrow">↗</span></button>
                  <button class="button button-end" id="end-quiz" ${state.phase !== "live" ? "disabled" : ""}><span>Wrap quiz</span><span class="button-arrow">■</span></button>
                  <button class="button button-reset" id="reset-quiz"><span>Reset quiz</span><span class="button-arrow">↻</span></button>
                  <a class="button button-secondary host-admin-btn" href="/admin"><span>Admin Console</span><span class="button-arrow">→</span></a>
                </div>
              </div>`
      : ""
    }

        <!-- 1. LIVE STATS ON TOP -->
        <section class="stage-stats-bar" aria-label="Live quiz telemetry">
          <div class="stage-stat-item">
            <div class="stage-stat-icon people-icon">♧</div>
            <div class="stage-stat-content">
              <div class="stage-stat-label">PLAYERS IN ROOM</div>
              <div class="stage-stat-number" id="player-count">${state.participantCount}<small> players</small></div>
            </div>
          </div>

          <div class="stage-stat-divider"></div>

          <div class="stage-stat-item">
            <div class="stage-stat-icon answer-icon">↗</div>
            <div class="stage-stat-content">
              <div class="stage-stat-label">ANSWERS SUBMITTED</div>
              <div class="stage-stat-number" id="answer-count">${state.submittedAnswers}<small> answers</small></div>
            </div>
          </div>

          <div class="stage-stat-divider"></div>

          <div class="stage-stat-item">
            <div class="stage-stat-icon finish-icon">✳</div>
            <div class="stage-stat-content">
              <div class="stage-stat-label">PLAYERS COMPLETED</div>
              <div class="stage-stat-number" id="finished-count">${state.completedCount}<small> / ${state.participantCount}</small></div>
            </div>
          </div>

          <div class="stage-stat-divider"></div>

          <div class="stage-stat-item stage-stat-status">
            <div class="stage-stat-content">
              <div class="stage-stat-label">CURRENT PHASE</div>
              <div class="stage-status-badge">
                <span class="status-dot ${state.phase === "live" ? "is-live" : ""}"></span>
                <span id="stage-phase-label">${phaseLabel(state.phase)}</span>
              </div>
            </div>
            <div class="stage-pulse-note">
              <span class="pulse-dot"></span> Live updates
            </div>
          </div>
        </section>

        <!-- 2. MAIN STAGE: 75% BIG QR & 25% LEADERBOARD -->
        <section class="stage-main-grid" aria-label="Live quiz screen">
          <!-- 75% Screen: BIG QR CODE -->
          <article class="panel stage-qr-panel">
            <div class="stage-qr-header">
              <div class="stage-qr-eyebrow"><span class="eyebrow-line"></span> SCAN WITH YOUR PHONE CAMERA TO PLAY</div>
              <h2 class="stage-qr-title">Scan To Join The Quiz</h2>
              <p class="stage-qr-subtitle">Point your mobile camera at the QR code below. No app installation needed.</p>
            </div>

            <div class="stage-qr-center">
              <a class="stage-qr-frame" href="${joinHref}" target="_blank" rel="noopener" aria-label="Scan or click to join the quiz">
                <img src="/api/qr" alt="Scan to join the quiz" />
              </a>
              <div class="stage-qr-scan-badge">
                <span class="scan-camera-icon">📷</span>
                <span>POINT CAMERA TO SCAN</span>
              </div>
            </div>

            <div class="stage-join-bar">
              <div class="stage-join-info">
                <span class="stage-join-label">OR VISIT URL:</span>
                <span class="stage-join-url">${escapeHtml(joinUrl)}</span>
              </div>
              <button class="stage-copy-btn" type="button" id="copy-link">
                <span>COPY LINK</span>
                <span>📋</span>
              </button>
            </div>

            <div class="stage-qr-steps">
              <div class="stage-step"><span class="step-num">1</span> Open camera on phone</div>
              <div class="stage-step-arrow">→</div>
              <div class="stage-step"><span class="step-num">2</span> Tap link notification</div>
              <div class="stage-step-arrow">→</div>
              <div class="stage-step"><span class="step-num">3</span> Pick nickname & play</div>
            </div>
          </article>

          <!-- 25% Screen: LEADERBOARD -->
          <article class="panel stage-leaderboard-panel">
            <div class="panel-heading">
              <div>
                <div class="eyebrow">THE ONES TO BEAT</div>
                <h2>Leaderboard</h2>
              </div>
              <span class="trophy">♜</span>
            </div>
            <div class="leader-list stage-leader-list" id="leader-list">${leaderboard}</div>
            <div class="leader-footer">
              ${state.phase === "ended" ? "FINAL RESULTS 🏆" : "RANKED BY SCORE & TIME"}
              <span>✦</span>
            </div>
          </article>
        </section>

        <footer class="dashboard-footer"><span>MADE FOR THE MOMENT.</span><span>QUIZ NIGHT <i>©</i> 2026</span></footer>
      </main>
    </div>`;

  document.querySelector("#start-quiz")?.addEventListener("click", async () => {
    try {
      await request("/api/start", { method: "POST", body: "{}" });
      await refreshDashboard();
    } catch (error) {
      showToast(error.message);
    }
  });

  document.querySelector("#end-quiz")?.addEventListener("click", async () => {
    const confirmed = await confirmAction(
      "Wrap up this quiz?",
      "Players will no longer be able to submit answers. Final scores will be shown on the leaderboard.",
      "Wrap quiz",
    );
    if (!confirmed) return;
    try {
      await request("/api/end", { method: "POST", body: "{}" });
      await refreshDashboard();
      try {
        await downloadScoresheet();
        showToast("Quiz wrapped. Scoresheet downloaded.");
      } catch (error) {
        showToast(`Quiz wrapped, but the scoresheet could not be downloaded: ${error.message}`);
      }
    } catch (error) {
      showToast(error.message);
    }
  });

  document.querySelector("#reset-quiz")?.addEventListener("click", async () => {
    const confirmed = await confirmAction(
      "Reset this quiz?",
      "This clears all players, answers, and leaderboard results, then returns the quiz to the lobby.",
      "Reset quiz",
    );
    if (!confirmed) return;
    try {
      await request("/api/reset", { method: "POST", body: "{}" });
      await refreshDashboard();
      showToast("Quiz reset. The next round is ready.");
    } catch (error) {
      showToast(error.message);
    }
  });

  document.querySelector("#share-link")?.addEventListener("click", copyJoinLink);
  document.querySelector("#copy-link")?.addEventListener("click", copyJoinLink);
}

function updateDashboardStats(state) {
  const playerCount = document.querySelector("#player-count");
  const answerCount = document.querySelector("#answer-count");
  const finishedCount = document.querySelector("#finished-count");
  const phaseLabelEl = document.querySelector("#stage-phase-label");
  if (playerCount) playerCount.innerHTML = `${state.participantCount}<small> players</small>`;
  if (answerCount) answerCount.innerHTML = `${state.submittedAnswers}<small> answers</small>`;
  if (finishedCount) finishedCount.innerHTML = `${state.completedCount}<small> / ${state.participantCount}</small>`;
  if (phaseLabelEl) phaseLabelEl.textContent = phaseLabel(state.phase);
  const list = document.querySelector("#leader-list");
  if (list && state.leaderboard.length) {
    list.innerHTML = state.leaderboard
      .slice(0, 10)
      .map(
        (player) => `
          <div class="leader-row">
            <span class="leader-rank ${player.rank <= 3 ? "top-rank" : ""}">${String(player.rank).padStart(2, "0")}</span>
            <span class="leader-avatar">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span>
            <span class="leader-name">${escapeHtml(player.name)}</span>
            <span class="leader-score">${player.score}<small> / ${state.questions.length}</small></span>
          </div>`,
      )
      .join("");
  }
}

async function refreshDashboard() {
  const state = await request("/api/state");
  const dashboardChanged =
    latestState?.phase !== state.phase ||
    latestState?.isAdmin !== state.isAdmin ||
    latestState?.joinUrl !== state.joinUrl ||
    JSON.stringify(latestState?.questions) !== JSON.stringify(state.questions);
  latestState = state;
  if (!app.querySelector(".dashboard-shell") || dashboardChanged) renderDashboard(state);
  else updateDashboardStats(state);
}

function participantHeader(kicker, title) {
  return `
    <header class="participant-header">
      <a class="brand" href="/" aria-label="Quiz Night home">
        <span class="brand-mark">q<span>.</span></span>
        <span>quiz<span class="brand-light">night</span></span>
      </a>
      <span class="event-tag participant-tag"><span class="status-dot ${latestState?.phase === "live" ? "is-live" : ""}"></span>${kicker}</span>
    </header>
    <h1 class="participant-title">${title}</h1>`;
}

function renderJoinForm(message = "") {
  participantViewKey = "join";
  app.innerHTML = `
    <main class="participant-shell">
      ${participantHeader("AUDIENCE QUIZ", "You’re in.<br /><span>Let’s play.</span>")}
      <p class="participant-intro">Pick a name your friends will recognize.<br />The quiz will begin on the big screen.</p>
      <form class="join-form" id="join-form">
        <label for="player-name">YOUR NAME</label>
        <input id="player-name" name="name" type="text" maxlength="24" autocomplete="nickname" placeholder="e.g. Gunjan Kumar" value="${escapeHtml(participantName)}" required />
        <button class="button button-primary join-button" type="submit"><span>Join the room</span><span class="button-arrow">↗</span></button>
        <div class="form-error" role="alert">${escapeHtml(message)}</div>
      </form>
      <div class="participant-note"><span>✳</span> No downloads. Just good answers.</div>
    </main>`;
  document.querySelector("#join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name").trim();
    if (!name) return;
    participantName = name;
    participantId = participantId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    try {
      const result = await request("/api/join", {
        method: "POST",
        body: JSON.stringify({ id: participantId, name }),
      });
      localStorage.setItem("realtime-quiz-participant", participantId);
      localStorage.setItem("realtime-quiz-name", name);
      participantRoundId = result.state.roundId;
      localStorage.setItem("realtime-quiz-round-id", String(participantRoundId));
      latestState = result.state;
      renderParticipant(result.state);
    } catch (error) {
      document.querySelector(".form-error").textContent = error.message;
    }
  });
}

function showQuestionLoader({ isLastQuestion, nextQuestionNum, totalQuestions }) {
  const playingShell = app.querySelector(".playing-shell");
  if (!playingShell) return;

  const answerOptionsEl = playingShell.querySelector(".answer-options");
  if (answerOptionsEl) {
    answerOptionsEl.style.display = "none";
  }

  let loader = playingShell.querySelector("#question-loader");
  if (!loader) {
    loader = document.createElement("div");
    loader.id = "question-loader";
    loader.className = "question-loader-card";
    const note = playingShell.querySelector(".participant-note");
    if (note) {
      playingShell.insertBefore(loader, note);
    } else {
      playingShell.appendChild(loader);
    }
  }

  const kickerText = isLastQuestion ? "FINAL QUESTION" : "ANSWER RECORDED";
  const headlineText = isLastQuestion
    ? "Calculating your results…"
    : `Loading Question ${nextQuestionNum} of ${totalQuestions}…`;
  const glyph = isLastQuestion ? "★" : "⚡";

  loader.innerHTML = `
    <div class="loader-pulse-orbit">
      <div class="loader-spinner-ring"></div>
      <div class="loader-pulse-glyph">${glyph}</div>
    </div>
    <div class="loader-kicker">
      <span class="loader-kicker-dot"></span>
      <span>${kickerText}</span>
    </div>
    <div class="loader-headline">${headlineText}</div>
    <div class="loader-bar-wrap">
      <div class="loader-bar-fill"></div>
    </div>
  `;
  loader.style.display = "flex";
}

function hideQuestionLoader() {
  const playingShell = app.querySelector(".playing-shell");
  if (!playingShell) return;
  const loader = playingShell.querySelector("#question-loader");
  if (loader) {
    loader.remove();
  }
  const answerOptionsEl = playingShell.querySelector(".answer-options");
  if (answerOptionsEl) {
    answerOptionsEl.style.display = "";
  }
}

function enableAnswerButtons() {
  const buttons = app.querySelectorAll(".answer-option");
  buttons.forEach((btn) => {
    btn.disabled = false;
    btn.classList.remove("selected");
    btn.removeAttribute("aria-busy");
    const arrow = btn.querySelector(".option-arrow");
    if (arrow) arrow.textContent = "↗";
  });
}

async function submitAnswerWithRetry(questionIndex, optionIndex, maxRetries = 1) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await request("/api/answer", {
        method: "POST",
        body: JSON.stringify({ id: participantId, questionIndex, optionIndex }),
        timeout: 5000,
      });
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) throw err;
      // Brief 150ms delay before single quick retry if server was busy or network blip
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

function renderParticipant(state, force = false) {
  latestState = state;
  if (!participantId || !state.participant) {
    renderJoinForm();
    return;
  }
  const person = state.participant;
  const rank = state.leaderboard.find((player) => player.id === participantId)?.rank;
  const viewKey = JSON.stringify([
    state.phase,
    person.answers,
    person.completed,
    person.score,
    rank,
  ]);

  if (!force && viewKey === participantViewKey) {
    const stuckDisabled = app.querySelector(".answer-option:disabled");
    if (!stuckDisabled && !participantBusy) return;
  }
  participantViewKey = viewKey;

  const allAnswered =
    Array.isArray(person.answers) &&
    person.answers.length > 0 &&
    person.answers.every((ans) => ans !== null);

  if (person.completed || state.phase === "ended" || allAnswered) {
    renderParticipantResult(state);
    return;
  }

  if (state.phase === "lobby") {
    app.innerHTML = `
      <main class="participant-shell waiting-shell">
        ${participantHeader("YOU’RE IN THE ROOM", "Eyes up.<br /><span>It’s almost go time.</span>")}
        <div class="waiting-card"><div class="waiting-orbit"><span>✳</span></div><h2>Waiting for the host</h2><p>We’ll bring the first question<br />here as soon as it starts.</p><div class="waiting-pulse"><i></i><i></i><i></i></div></div>
        <div class="participant-note"><span>✳</span> You’re playing as <strong>${escapeHtml(participantName)}</strong></div>
      </main>`;
    return;
  }

  const index = person.answers.findIndex((answer) => answer === null);
  const questionIndex = index === -1 ? state.questions.length - 1 : index;
  const question = state.questions[questionIndex];
  if (!question) {
    renderParticipantResult(state);
    return;
  }
  const progress = Math.round((questionIndex / state.questions.length) * 100);
  app.innerHTML = `
    <main class="participant-shell playing-shell question-enter">
      ${participantHeader(`QUESTION ${String(questionIndex + 1).padStart(2, "0")} / ${String(state.questions.length).padStart(2, "0")}`, "")}
      <div class="quiz-progress"><span style="width:${progress}%"></span></div>
      <div class="question-meta"><span>QUESTION ${questionIndex + 1}</span><span>${state.questions.length - questionIndex} TO GO</span></div>
      <h1 class="question-title">${escapeHtml(question.prompt)}</h1>
      <div class="answer-options">
        ${question.options
      .map(
        (option, optionIndex) => `
              <button class="answer-option" type="button" data-option="${optionIndex}" aria-label="Answer ${letters[optionIndex]}: ${escapeHtml(option)}">
                <span class="option-letter">${letters[optionIndex]}</span><span>${escapeHtml(option)}</span><span class="option-arrow">↗</span>
              </button>`,
      )
      .join("")}
      </div>
      <div class="participant-note"><span>✳</span> Playing as <strong>${escapeHtml(participantName)}</strong></div>
    </main>`;

  app.querySelectorAll(".answer-option").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      const optionIndex = Number(button.dataset.option);
      if (Number.isInteger(optionIndex)) {
        submitAnswer(questionIndex, optionIndex);
      }
    });
  });
}

async function submitAnswer(questionIndex, optionIndex) {
  if (participantBusy) return;
  setBusyState(true);

  // Abort any active background poll immediately to prevent state collisions
  if (activePollController) {
    try {
      activePollController.abort();
    } catch { }
    activePollController = null;
  }

  const buttons = app.querySelectorAll(".answer-option");
  buttons.forEach((button) => {
    button.disabled = true;
    if (Number(button.dataset.option) === optionIndex) {
      button.classList.add("selected");
      button.setAttribute("aria-busy", "true");
    }
  });

  const totalQuestions = latestState?.questions?.length || 5;
  const isLastQuestion = questionIndex >= totalQuestions - 1;
  const nextQuestionNum = questionIndex + 2;

  // Show the fast loader between questions
  showQuestionLoader({ isLastQuestion, nextQuestionNum, totalQuestions });

  // Fast minimum transition time (380ms) for snappy, smooth feel
  const minTimer = new Promise((resolve) => setTimeout(resolve, 380));

  try {
    const result = await submitAnswerWithRetry(questionIndex, optionIndex);
    await minTimer;

    // Keep participantRoundId in sync
    if (result.state?.roundId) {
      participantRoundId = result.state.roundId;
      localStorage.setItem("realtime-quiz-round-id", String(participantRoundId));
    }

    setBusyState(false);
    renderParticipant(result.state, true);
  } catch (error) {
    console.error("Answer submission failed:", error);
    setBusyState(false);
    hideQuestionLoader();
    enableAnswerButtons();
    participantViewKey = null;

    if (error.message && error.message.includes("Join the quiz")) {
      showToast("Reconnecting to the quiz...");
      await refreshParticipant(true);
      return;
    }

    showToast(error.message || "Failed to submit answer. Please try again.");
  }
}

function renderParticipantResult(state) {
  const person = state.participant;
  const totalAnswered = person.answers.filter((answer) => answer !== null).length;
  const score = person.score;
  const review = state.questions
    .map((question, index) => {
      const answer = person.answers[index];
      const correct = person.correctOptionIndexes?.[index];
      const isCorrect = answer !== null && answer === correct;
      return `
        <div class="review-row">
          <span class="review-mark ${isCorrect ? "review-correct" : "review-wrong"}">${isCorrect ? "✓" : "×"}</span>
          <span class="review-question">${escapeHtml(question.prompt)}<small>${answer === null ? "Not answered" : `Your answer: ${escapeHtml(question.options[answer])}`}${!isCorrect && correct !== undefined ? ` · Correct: ${escapeHtml(question.options[correct])}` : ""}</small></span>
          <span class="review-points">${isCorrect ? "+1" : "0"}</span>
        </div>`;
    })
    .join("");
  const rank = state.leaderboard.find((player) => player.id === participantId)?.rank;
  app.innerHTML = `
    <main class="participant-shell result-shell">
      ${participantHeader("THAT’S A WRAP", `Nice work,<br /><span>${escapeHtml(participantName)}.</span>`)}
      <section class="result-score-card">
        <div class="score-spark">✳</div><span class="score-label">YOUR FINAL SCORE</span>
        <div class="score-value">${score}<span>/${state.questions.length}</span></div>
        <p>${totalAnswered === state.questions.length ? "Every answer is in. How’d you do?" : `You answered ${totalAnswered} of ${state.questions.length} questions.`}</p>
        ${state.phase === "ended" && rank ? `<div class="rank-ribbon">YOU PLACED <strong>#${rank}</strong></div>` : ""}
      </section>
      <section class="answer-review"><div class="review-heading"><span>YOUR ANSWERS</span><span>${score} CORRECT</span></div>${review}</section>
      <p class="result-wait">${state.phase === "ended" ? "Final leaderboard is on the big screen." : "Waiting for the host to reveal final results."}</p>
    </main>`;
}

async function refreshParticipant(force = false) {
  if (participantRefreshing) return;
  if (participantBusy && !force) return;
  participantRefreshing = true;

  if (activePollController) {
    try {
      activePollController.abort();
    } catch { }
  }
  activePollController = new AbortController();
  const currentController = activePollController;

  try {
    const id = localStorage.getItem("realtime-quiz-participant");
    if (!id) {
      if (!app.querySelector("#join-form")) renderJoinForm();
      return;
    }
    participantId = id;
    participantName = localStorage.getItem("realtime-quiz-name") || participantName;
    const state = await request(`/api/state?participantId=${encodeURIComponent(id)}`, {
      signal: currentController.signal,
      timeout: 4500,
    });

    if (participantBusy && !force) return;
    latestState = state;

    if (participantRoundId !== null && state.roundId !== participantRoundId) {
      participantRoundId = state.roundId;
      localStorage.setItem("realtime-quiz-round-id", String(participantRoundId));
      if (state.phase === "ended") {
        renderJoinForm("A new quiz round is ready. Rejoin when the host opens it.");
        return;
      }
      const result = await request("/api/join", {
        method: "POST",
        body: JSON.stringify({ id, name: participantName }),
        timeout: 4500,
      });
      latestState = result.state;
      renderParticipant(result.state, true);
      showToast("The quiz was reset. You’re back in the room.");
      return;
    }

    if (!state.participant && state.phase !== "ended" && participantName) {
      const result = await request("/api/join", {
        method: "POST",
        body: JSON.stringify({ id, name: participantName }),
        timeout: 4500,
      });
      participantRoundId = result.state.roundId;
      localStorage.setItem("realtime-quiz-round-id", String(participantRoundId));
      latestState = result.state;
      renderParticipant(result.state, true);
      return;
    }

    if (!state.participant) {
      const formError = app.querySelector(".form-error");
      if (formError) {
        if (state.phase === "ended") formError.textContent = "This quiz has ended.";
      } else {
        renderJoinForm(state.phase === "ended" ? "This quiz has ended." : "");
      }
      return;
    }

    participantRoundId = state.roundId;
    localStorage.setItem("realtime-quiz-round-id", String(participantRoundId));
    renderParticipant(state);
  } catch (error) {
    if (error.name !== "AbortError") {
      showToast(error.message);
    }
  } finally {
    participantRefreshing = false;
  }
}

async function copyJoinLink() {
  const joinUrl = latestState?.joinUrl;
  if (!joinUrl) return;
  try {
    await navigator.clipboard.writeText(joinUrl);
    showToast("Join link copied to clipboard.");
  } catch {
    showToast(`Join at ${joinUrl}`);
  }
}

if (isParticipant) {
  if (participantId) refreshParticipant();
  else renderJoinForm();
  window.setInterval(() => {
    if (!participantBusy && !participantRefreshing && document.visibilityState === "visible") {
      refreshParticipant();
    }
  }, 1200);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshParticipant();
  });
} else {
  refreshDashboard().catch((error) => showToast(error.message));
  window.setInterval(() => {
    if (document.visibilityState === "visible") refreshDashboard().catch((error) => showToast(error.message));
  }, 1000);
}
