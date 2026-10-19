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
          <span class="quiz-length"><span class="length-dot"></span>${state.quizSubtitle ? escapeHtml(state.quizSubtitle) : `${state.questions.length} Questions`}</span>
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
              <div class="stage-qr-eyebrow"><span class="eyebrow-line"></span> ${escapeHtml((state.quizTitle || "PRESENTATION 3 · CYBER FRAUD & THE MONEY TRAIL").toUpperCase())}</div>
              <h2 class="stage-qr-title">Scan To Join The Quiz</h2>
              <p class="stage-qr-subtitle">${escapeHtml(state.quizSubtitle || `Law as on October 2026 · Reader v7 (110 slides) · ${state.questions.length} Questions`)}</p>
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
  const scenarioQuestions = state.questions.filter(
    (q) => (q.scenarioId || q.scenarioTitle) === (question.scenarioId || question.scenarioTitle)
  );
  const qInScenario = scenarioQuestions.findIndex((q) => q.id === question.id) + 1;
  const totalInScenario = scenarioQuestions.length || 1;
  const isDirect = question.section === "direct" || !question.scenarioText;
  const caseScenarios = state.questions.filter((q) => q.scenarioText && q.section !== "direct");
  const uniqueCaseIds = [...new Set(caseScenarios.map((q) => q.scenarioId || q.scenarioTitle))];
  const caseNum = uniqueCaseIds.indexOf(question.scenarioId || question.scenarioTitle) + 1;
  const scenarioNum = question.scenarioId || (caseNum > 0 ? caseNum : 1);

  const typeKey = (question.type || "apply").toLowerCase();
  const typeIcons = {
    apply: "🎯",
    law: "⚖️",
    evidence: "🔍",
    precaution: "🛡️",
  };
  const typeLabels = {
    apply: "APPLY · Practical Application",
    law: "LAW · Statutory Provisions & Offences",
    evidence: "EVIDENCE · Digital Trail & Proof",
    precaution: "PRECAUTION · Safeguards & Red Flags",
  };
  const typeIcon = typeIcons[typeKey] || "📋";
  const typeBadgeText = typeLabels[typeKey] || (question.typeLabel || typeKey.toUpperCase());

  app.innerHTML = `
    <main class="participant-shell playing-shell scenario-mode question-enter">
      ${participantHeader(`Q ${String(questionIndex + 1).padStart(2, "0")} / ${String(state.questions.length).padStart(2, "0")}`, "")}
      <div class="quiz-progress"><span style="width:${progress}%"></span></div>

      <div class="scenario-tracker-bar">
        <div class="tracker-left">
          ${isDirect ? `
            <span class="scenario-pill direct-pill">DIRECT QUESTIONS</span>
            <span class="sub-q-pill">Question ${qInScenario} of ${totalInScenario}</span>
          ` : `
            <span class="scenario-pill">CASE STUDY ${caseNum > 0 ? caseNum : scenarioNum} OF ${uniqueCaseIds.length || 2}</span>
            <span class="sub-q-pill">Question ${qInScenario} of ${totalInScenario}</span>
          `}
        </div>
        <div class="tracker-right">
          <span class="type-pill type-pill-${typeKey}">${typeIcon} ${escapeHtml(typeBadgeText)}</span>
        </div>
      </div>

      <!-- SCENARIO CASE BRIEFING DOSSIER (Rendered for case studies) -->
      ${question.scenarioText ? `
      <section class="scenario-dossier-card" aria-label="Scenario briefing facts">
        <div class="scenario-dossier-top">
          <div class="scenario-dossier-title-wrap">
            <span class="scenario-dossier-icon">📁</span>
            <div>
              <div class="scenario-dossier-eyebrow">CASE BRIEFING #${caseNum > 0 ? caseNum : scenarioNum}</div>
              <h2 class="scenario-dossier-title">${escapeHtml(question.scenarioTitle || `Case Study ${scenarioNum}`)}</h2>
            </div>
          </div>
        </div>
        <div class="scenario-dossier-body">
          <p class="scenario-dossier-text">${escapeHtml(question.scenarioText)}</p>
        </div>
        ${question.scenarioSource ? `
          <div class="scenario-dossier-source">
            <span class="source-pin">📌</span>
            <span>Source: <strong>${escapeHtml(question.scenarioSource)}</strong></span>
          </div>` : ""}
      </section>` : ""}

      <!-- QUESTION PROMPT & OPTIONS -->
      <section class="question-action-card">
        <div class="question-action-header">
          <div class="question-action-eyebrow">QUESTION ${questionIndex + 1} OF ${state.questions.length}</div>
          <h1 class="scenario-question-title">${escapeHtml(question.prompt)}</h1>
        </div>

        <div class="answer-options scenario-options">
          ${question.options
            .map(
              (option, optionIndex) => `
                <button class="answer-option scenario-option" type="button" data-option="${optionIndex}" aria-label="Answer ${letters[optionIndex]}: ${escapeHtml(option)}">
                  <span class="option-letter">${letters[optionIndex]}</span>
                  <span class="option-text">${escapeHtml(option)}</span>
                  <span class="option-arrow">↗</span>
                </button>`,
            )
            .join("")}
        </div>
      </section>

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

  const totalQuestions = latestState?.questions?.length || 18;
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
  const rank = state.leaderboard.find((player) => player.id === participantId)?.rank;
  const pct = Math.round((score / state.questions.length) * 100);

  let performanceTitle = "Investigative Trainee";
  let performanceDesc = "Review cyber crime statutory provisions and audit trail records.";
  if (pct >= 85) {
    performanceTitle = "Cyber Fraud Master Investigator 🏆";
    performanceDesc = "Exceptional mastery of cyber crime law, money trails, and audit evidence!";
  } else if (pct >= 70) {
    performanceTitle = "Senior Fraud Analyst ⭐";
    performanceDesc = "Strong command of money trail analysis, mule networks, and departmental safeguards.";
  } else if (pct >= 50) {
    performanceTitle = "Competent Legal & Tax Analyst 🛡️";
    performanceDesc = "Good understanding of core principles, with room to refine evidence nuances.";
  }

  const review = state.questions
    .map((question, index) => {
      const answer = person.answers[index];
      const correct = person.correctOptionIndexes?.[index];
      const isCorrect = answer !== null && answer === correct;
      const scenarioQuestions = state.questions.filter(
        (q) => (q.scenarioId || q.scenarioTitle) === (question.scenarioId || question.scenarioTitle)
      );
      const qInScenario = scenarioQuestions.findIndex((q) => q.id === question.id) + 1;
      const isDirect = question.section === "direct" || !question.scenarioText;
      const scenarioTag = isDirect ? `Direct Question ${qInScenario}` : `Case Study ${question.scenarioId || 1} · Q${qInScenario}`;
      const typeKey = (question.type || "apply").toLowerCase();
      const hasExplanation = Boolean(question.explanation);
      const hasSlides = Array.isArray(question.slides) && question.slides.length > 0;

      return `
        <article class="review-scenario-card ${isCorrect ? "is-review-correct" : "is-review-wrong"}">
          <div class="review-card-top">
            <div class="review-tags">
              <span class="review-scenario-tag">${scenarioTag}</span>
              <span class="review-type-tag review-type-${typeKey}">${escapeHtml(question.typeLabel || typeKey.toUpperCase())}</span>
              <span class="review-overall-tag">#${index + 1}</span>
            </div>
            <span class="review-points-badge ${isCorrect ? "points-correct" : "points-wrong"}">
              ${isCorrect ? "✓ +1 POINT" : "× 0 POINTS"}
            </span>
          </div>

          ${question.scenarioTitle ? `
          <div class="review-scenario-ref-bar">
            <span>📁 ${escapeHtml(question.scenarioTitle)}</span>
          </div>` : ""}

          <h4 class="review-prompt">${escapeHtml(question.prompt)}</h4>

          <div class="review-answers-box">
            <div class="review-ans-item ${isCorrect ? "is-user-correct" : "is-user-wrong"}">
              <span class="review-ans-label">Your Answer:</span>
              <span class="review-ans-text">${answer === null ? "Not answered" : `<strong>[${letters[answer]}]</strong> ${escapeHtml(question.options[answer])}`}</span>
            </div>
            ${!isCorrect && correct !== undefined ? `
              <div class="review-ans-item is-correct-answer">
                <span class="review-ans-label">Correct Answer:</span>
                <span class="review-ans-text"><strong>[${letters[correct]}]</strong> ${escapeHtml(question.options[correct])}</span>
              </div>` : ""}
          </div>

          ${hasExplanation ? `
            <div class="review-explanation-box">
              <div class="review-exp-header">
                <span class="review-exp-icon">💡</span>
                <strong>Legal & Investigative Rationale:</strong>
              </div>
              <p class="review-exp-text">${escapeHtml(question.explanation)}</p>
            </div>` : ""}

          ${hasSlides ? `
            <div class="review-slides-ref">
              <span class="slides-icon">📖</span>
              <span>Presentation Reader Reference: <strong>Slide ${question.slides.join(", Slide ")}</strong></span>
            </div>` : ""}
        </article>`;
    })
    .join("");

  app.innerHTML = `
    <main class="participant-shell result-shell scenario-result-shell">
      ${participantHeader("ASSESSMENT SUMMARY", `Results for<br /><span>${escapeHtml(participantName)}.</span>`)}
      
      <section class="result-score-card">
        <div class="score-spark">✳</div>
        <span class="score-label">FINAL SCORE</span>
        <div class="score-value">${score}<span>/${state.questions.length}</span></div>
        <div class="score-pct-badge">${pct}% Accuracy</div>
        <div class="performance-title">${performanceTitle}</div>
        <p class="performance-desc">${performanceDesc}</p>
        <p class="answered-summary">${totalAnswered === state.questions.length ? `All ${state.questions.length} questions completed.` : `Answered ${totalAnswered} of ${state.questions.length} questions.`}</p>
        ${state.phase === "ended" && rank ? `<div class="rank-ribbon">YOU PLACED <strong>#${rank} ON THE BOARD</strong></div>` : ""}
      </section>

      <section class="answer-review">
        <div class="review-heading">
          <div>
            <span>QUESTION BY QUESTION ANALYSIS</span>
            <h2>Detailed Review (${score}/${state.questions.length} Correct)</h2>
          </div>
          <span class="review-score-pill">${pct}%</span>
        </div>
        <div class="review-cards-list">${review}</div>
      </section>

      <p class="result-wait">${state.phase === "ended" ? "Final leaderboard is on the presenter screen." : "Waiting for the presenter to wrap up the round."}</p>
      <div class="participant-note"><span>✳</span> Played as <strong>${escapeHtml(participantName)}</strong></div>
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
