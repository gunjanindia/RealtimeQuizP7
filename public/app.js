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

async function request(path, options = {}) {
  const token = sessionStorage.getItem(adminTokenKey);
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && token) sessionStorage.removeItem(adminTokenKey);
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
  return data;
}

async function downloadScoresheet() {
  const token = sessionStorage.getItem(adminTokenKey);
  const response = await fetch("/api/results.csv", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const data = await response.json();
    if (response.status === 401 && token) sessionStorage.removeItem(adminTokenKey);
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
              <span class="leader-score">${player.score}<small> / 5</small></span>
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
        <div class="event-tag"><span class="status-dot ${state.phase === "live" ? "is-live" : ""}"></span>${phaseLabel(state.phase)}</div>
        <div class="topbar-actions">
          <button class="topbar-link-button" type="button" id="share-link">Copy join link <span>↗</span></button>
          <button class="admin-toggle" type="button" id="admin-toggle">${state.isAdmin ? "Admin tools" : "Admin"}</button>
        </div>
      </header>

      <main class="dashboard-main">
        <section class="intro">
          <div class="eyebrow"><span class="eyebrow-line"></span> THE ROOM IS YOURS</div>
          <h1>Let’s get<br /><span>quizzical.</span></h1>
          <p class="intro-copy">One room. Five questions. Bragging rights<br class="desktop-break" /> for the winner.</p>
          <div class="control-row">
            ${
              state.isAdmin
                ? `<div class="quiz-controls">
                    <button class="button button-primary" id="start-quiz" ${state.phase !== "lobby" ? "disabled" : ""}><span>Start quiz</span><span class="button-arrow">↗</span></button>
                    <button class="button button-end" id="end-quiz" ${state.phase !== "live" ? "disabled" : ""}><span>Wrap quiz</span><span class="button-arrow">■</span></button>
                    <button class="button button-reset" id="reset-quiz"><span>Reset quiz</span><span class="button-arrow">↻</span></button>
                  </div>`
                : `<span class="host-only-note">Host controls are admin-only</span>`
            }
            <span class="quiz-length"><span class="length-dot"></span>5 questions <i>·</i> ~2 min</span>
          </div>
        </section>

        <section class="dashboard-grid" aria-label="Live quiz dashboard">
          <article class="panel join-panel">
            <div class="panel-heading">
              <div><div class="eyebrow">GET IN THE GAME</div><h2>Scan to join</h2></div>
              <span class="qr-badge">QR CODE</span>
            </div>
            <a class="qr-frame" href="${joinHref}" aria-label="Join this quiz">
              <img src="/api/qr" alt="Scan to join the quiz" />
            </a>
            <p class="scan-hint">Point your camera here</p>
            <div class="join-url"><span>${escapeHtml(joinUrl.replace(/^https?:\/\//, ""))}</span><button type="button" id="copy-link">COPY LINK</button></div>
          </article>

          <article class="panel stats-panel">
            <div class="panel-heading">
              <div><div class="eyebrow">THE ROOM, RIGHT NOW</div><h2>Live stats</h2></div>
              <span class="live-indicator"><i></i> LIVE</span>
            </div>
            <div class="stat-list">
              <div class="stat-item">
                <div class="stat-icon people-icon">♧</div>
                <div class="stat-label">Players in the room<span>Ready to play</span></div>
                <div class="stat-number" id="player-count">${state.participantCount}<small> players</small></div>
              </div>
              <div class="stat-item">
                <div class="stat-icon answer-icon">↗</div>
                <div class="stat-label">Answers submitted<span>Across all questions</span></div>
                <div class="stat-number" id="answer-count">${state.submittedAnswers}<small> answers</small></div>
              </div>
              <div class="stat-item">
                <div class="stat-icon finish-icon">✳</div>
                <div class="stat-label">Players finished<span>Quiz completed</span></div>
                <div class="stat-number" id="finished-count">${state.completedCount}<small> / ${state.participantCount}</small></div>
              </div>
            </div>
            <div class="stats-foot"><span class="pulse-dot"></span> Updates automatically every second</div>
          </article>

          <article class="panel leaderboard-panel">
            <div class="panel-heading">
              <div><div class="eyebrow">THE ONES TO BEAT</div><h2>Leaderboard</h2></div>
              <span class="trophy">♜</span>
            </div>
            <div class="leader-list" id="leader-list">${leaderboard}</div>
            <div class="leader-footer">${state.phase === "ended" ? "FINAL RESULTS" : "RANKED BY SCORE, THEN TIME"} <span>✦</span></div>
          </article>
        </section>
        <section class="admin-panel" id="admin-panel" ${state.isAdmin ? "" : "hidden"}>
          ${
            state.isAdmin
              ? `<div class="admin-panel-heading"><div><div class="eyebrow">HOST SETTINGS</div><h2>Admin controls</h2></div><button class="text-button" type="button" id="admin-logout">Sign out</button></div>
                 <form class="admin-url-form" id="admin-url-form">
                   <label for="join-url-input">AUDIENCE JOIN URL</label>
                   <div class="admin-url-row"><input id="join-url-input" name="joinUrl" type="url" value="${escapeHtml(joinUrl)}" required /><button class="button button-primary" type="submit">Save URL</button></div>
                   <p>QR code and copied links update after saving. Include the full device-reachable address.</p>
                   <div class="form-error" id="admin-error" role="alert"></div>
                 </form>`
              : `<div class="admin-panel-heading"><div><div class="eyebrow">HOST ACCESS</div><h2>Admin sign in</h2></div></div>
                 <form class="admin-login-form" id="admin-login-form">
                   <label for="admin-password">ADMIN PASSCODE</label>
                   <div class="admin-url-row"><input id="admin-password" name="password" type="password" autocomplete="current-password" required /><button class="button button-primary" type="submit">Sign in</button></div>
                   <div class="form-error" id="admin-error" role="alert"></div>
                 </form>`
          }
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
    if (!confirmed) {
      return;
    }
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
    if (!confirmed) {
      return;
    }
    try {
      await request("/api/reset", { method: "POST", body: "{}" });
      await refreshDashboard();
      showToast("Quiz reset. The next round is ready.");
    } catch (error) {
      showToast(error.message);
    }
  });
  document.querySelector("#admin-toggle")?.addEventListener("click", () => {
    const panel = document.querySelector("#admin-panel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      (state.isAdmin
        ? document.querySelector("#join-url-input")
        : document.querySelector("#admin-password")
      )?.focus();
    }
  });
  document.querySelector("#admin-login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.querySelector("#admin-error");
    try {
      const formData = new FormData(event.currentTarget);
      const result = await request("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password: formData.get("password") }),
      });
      sessionStorage.setItem(adminTokenKey, result.token);
      await refreshDashboard();
      document.querySelector("#admin-panel").hidden = false;
    } catch (requestError) {
      error.textContent = requestError.message;
    }
  });
  document.querySelector("#admin-url-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.querySelector("#admin-error");
    try {
      const formData = new FormData(event.currentTarget);
      await request("/api/admin/join-url", {
        method: "POST",
        body: JSON.stringify({ joinUrl: formData.get("joinUrl") }),
      });
      showToast("Audience URL and QR code updated.");
      await refreshDashboard();
      document.querySelector("#admin-panel").hidden = false;
    } catch (requestError) {
      error.textContent = requestError.message;
    }
  });
  document.querySelector("#admin-logout")?.addEventListener("click", async () => {
    try {
      await request("/api/admin/logout", { method: "POST", body: "{}" });
    } catch (error) {
      showToast(error.message);
    } finally {
      sessionStorage.removeItem(adminTokenKey);
      await refreshDashboard();
    }
  });
  document.querySelector("#share-link")?.addEventListener("click", copyJoinLink);
  document.querySelector("#copy-link")?.addEventListener("click", copyJoinLink);
}

function updateDashboardStats(state) {
  const playerCount = document.querySelector("#player-count");
  const answerCount = document.querySelector("#answer-count");
  const finishedCount = document.querySelector("#finished-count");
  if (playerCount) playerCount.innerHTML = `${state.participantCount}<small> players</small>`;
  if (answerCount) answerCount.innerHTML = `${state.submittedAnswers}<small> answers</small>`;
  if (finishedCount) finishedCount.innerHTML = `${state.completedCount}<small> / ${state.participantCount}</small>`;
  const list = document.querySelector("#leader-list");
  if (list && state.leaderboard.length) {
    list.innerHTML = state.leaderboard
      .slice(0, 8)
      .map(
        (player) => `
          <div class="leader-row">
            <span class="leader-rank ${player.rank <= 3 ? "top-rank" : ""}">${String(player.rank).padStart(2, "0")}</span>
            <span class="leader-avatar">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span>
            <span class="leader-name">${escapeHtml(player.name)}</span>
            <span class="leader-score">${player.score}<small> / 5</small></span>
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
    latestState?.joinUrl !== state.joinUrl;
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
        <input id="player-name" name="name" type="text" maxlength="24" autocomplete="nickname" placeholder="e.g. Quiz Khalifa" value="${escapeHtml(participantName)}" required />
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

function renderParticipant(state) {
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
  if (viewKey === participantViewKey) return;
  participantViewKey = viewKey;
  if (person.completed || state.phase === "ended") {
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
  const progress = Math.round((questionIndex / state.questions.length) * 100);
  app.innerHTML = `
    <main class="participant-shell playing-shell">
      ${participantHeader(`QUESTION ${String(questionIndex + 1).padStart(2, "0")} / ${String(state.questions.length).padStart(2, "0")}`, "")}
      <div class="quiz-progress"><span style="width:${progress}%"></span></div>
      <div class="question-meta"><span>QUESTION ${questionIndex + 1}</span><span>${state.questions.length - questionIndex} TO GO</span></div>
      <h1 class="question-title">${escapeHtml(question.prompt)}</h1>
      <div class="answer-options">
        ${question.options
          .map(
            (option, optionIndex) => `
              <button class="answer-option" type="button" data-option="${optionIndex}" ${participantBusy ? "disabled" : ""} aria-label="Answer ${letters[optionIndex]}: ${escapeHtml(option)}">
                <span class="option-letter">${letters[optionIndex]}</span><span>${escapeHtml(option)}</span><span class="option-arrow">↗</span>
              </button>`,
          )
          .join("")}
      </div>
      <div class="participant-note"><span>✳</span> Playing as <strong>${escapeHtml(participantName)}</strong></div>
    </main>`;
  app.querySelectorAll(".answer-option").forEach((button) => {
    button.addEventListener("click", () => submitAnswer(questionIndex, Number(button.dataset.option)));
  });
}

async function submitAnswer(questionIndex, optionIndex) {
  if (participantBusy) return;
  participantBusy = true;
  const selectedButton = app.querySelector(`.answer-option[data-option="${optionIndex}"]`);
  app.querySelectorAll(".answer-option").forEach((button) => {
    button.disabled = true;
    if (Number(button.dataset.option) === optionIndex) button.classList.add("selected");
  });
  if (selectedButton) {
    selectedButton.setAttribute("aria-busy", "true");
    selectedButton.querySelector(".option-arrow").textContent = "…";
  }
  try {
    const result = await request("/api/answer", {
      method: "POST",
      body: JSON.stringify({ id: participantId, questionIndex, optionIndex }),
    });
    participantBusy = false;
    if (result.state.roundId !== participantRoundId) {
      await refreshParticipant();
      return;
    }
    renderParticipant(result.state);
  } catch (error) {
    participantBusy = false;
    showToast(error.message);
    await refreshParticipant();
  } finally {
    participantBusy = false;
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

async function refreshParticipant() {
  if (participantRefreshing) return;
  participantRefreshing = true;
  try {
    const id = localStorage.getItem("realtime-quiz-participant");
    if (!id) {
      if (!app.querySelector("#join-form")) renderJoinForm();
      return;
    }
    participantId = id;
    participantName = localStorage.getItem("realtime-quiz-name") || participantName;
    const state = await request(`/api/state?participantId=${encodeURIComponent(id)}`);
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
      });
      latestState = result.state;
      renderParticipant(result.state);
      showToast("The quiz was reset. You’re back in the room.");
      return;
    }

    if (!state.participant && state.phase !== "ended" && participantName) {
      const result = await request("/api/join", {
        method: "POST",
        body: JSON.stringify({ id, name: participantName }),
      });
      participantRoundId = result.state.roundId;
      localStorage.setItem("realtime-quiz-round-id", String(participantRoundId));
      latestState = result.state;
      renderParticipant(result.state);
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
    showToast(error.message);
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
