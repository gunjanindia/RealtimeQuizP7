const adminApp = document.querySelector("#admin-app");
const toast = document.querySelector("#toast");
const adminTokenKey = "realtime-quiz-admin-token";
const letters = ["A", "B", "C", "D"];

let latestState = null;
let toastTimer;
let isSubmitting = false;
let editingQuestionIndex = null;

function getAdminToken() {
  const urlToken = new URLSearchParams(window.location.search).get("token");
  if (urlToken) {
    localStorage.setItem(adminTokenKey, urlToken);
    return urlToken;
  }
  return localStorage.getItem(adminTokenKey) || sessionStorage.getItem(adminTokenKey) || "";
}

function setAdminToken(token) {
  if (token) {
    localStorage.setItem(adminTokenKey, token);
    sessionStorage.setItem(adminTokenKey, token);
  } else {
    removeAdminToken();
  }
}

function removeAdminToken() {
  localStorage.removeItem(adminTokenKey);
  sessionStorage.removeItem(adminTokenKey);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
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
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
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
      if (response.status === 401 && token) {
        removeAdminToken();
      }
      throw new Error(data.error || "Something went wrong. Please try again.");
    }
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error("Request timed out. Please try again.");
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

function renderLoginView(errorMessage = "") {
  adminApp.innerHTML = `
    <div class="admin-shell">
      <header class="topbar">
        <a class="brand" href="/" aria-label="Quiz Night home">
          <span class="brand-mark">q<span>.</span></span>
          <span>quiz<span class="brand-light">night</span></span>
        </a>
        <span class="admin-pill-badge">ADMIN ACCESS</span>
        <div class="topbar-actions">
          <a class="topbar-link-button" href="/">View Live Board <span>↗</span></a>
        </div>
      </header>

      <main class="admin-login-wrapper">
        <div class="admin-login-box">
          <div class="admin-login-icon">🔒</div>
          <div class="eyebrow"><span class="eyebrow-line"></span> HOST AUTHENTICATION</div>
          <h1 class="admin-login-title">Admin Console</h1>
          <p class="admin-login-subtitle">
            Enter your host passcode to manage quiz questions, control live rounds, and download results.
          </p>

          <form class="admin-auth-form" id="admin-login-form">
            <label for="admin-password">ADMIN PASSCODE</label>
            <div class="admin-auth-input-wrap">
              <input
                id="admin-password"
                name="password"
                type="password"
                autocomplete="current-password"
                placeholder="Enter passcode"
                required
                autofocus
              />
            </div>
            <button class="button button-primary admin-submit-btn" type="submit">
              <span>Sign in to Admin</span>
              <span class="button-arrow">→</span>
            </button>
            <div class="form-error" id="admin-login-error" role="alert">${escapeHtml(errorMessage)}</div>
          </form>

          <div class="admin-login-hint">
            <span>ℹ</span> Passcode is set via <code>QUIZ_ADMIN_PASSWORD</code> or generated in server console on startup.
          </div>
        </div>
      </main>
    </div>`;

  document.querySelector("#admin-login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.querySelector("#admin-login-error");
    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") || "").trim();
    if (!password) return;

    try {
      const result = await request("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setAdminToken(result.token);
      showToast("Signed in as Admin.");
      await refreshAdmin();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message;
    }
  });
}

function questionEditorForm(question, index, disabled = false) {
  const isNew = typeof index !== "number";
  const scenarioNum = question.scenarioId || (isNew ? 1 : Math.floor(index / 4) + 1);
  const typeKey = (question.type || "apply").toLowerCase();

  const options = question.options
    .map(
      (option, optionIndex) => `
        <label class="question-option-field" for="question-${index}-option-${optionIndex}">
          <span>${letters[optionIndex]}</span>
          <textarea
            id="question-${index}-option-${optionIndex}"
            name="option${optionIndex}"
            rows="2"
            maxlength="500"
            placeholder="Option ${letters[optionIndex]} text"
            required
            ${disabled ? "disabled" : ""}
          >${escapeHtml(option)}</textarea>
        </label>`,
    )
    .join("");

  const correctOptions = question.options
    .map(
      (_, optionIndex) => `
        <label class="correct-option">
          <input
            type="radio"
            name="correct"
            value="${optionIndex}"
            ${question.correct === optionIndex ? "checked" : ""}
            required
            ${disabled ? "disabled" : ""}
          />
          <span>${letters[optionIndex]} is correct</span>
        </label>`,
    )
    .join("");

  return `
    <form class="question-editor-form" data-index="${index}">
      <div class="editor-grid-2">
        <div>
          <label class="question-prompt-label" for="question-${index}-scenarioId">SCENARIO NUMBER (1–6)</label>
          <input
            class="question-prompt-input"
            id="question-${index}-scenarioId"
            name="scenarioId"
            type="number"
            min="1"
            max="20"
            value="${scenarioNum}"
            required
            ${disabled ? "disabled" : ""}
          />
        </div>
        <div>
          <label class="question-prompt-label" for="question-${index}-type">QUESTION TYPE</label>
          <select
            class="question-prompt-input question-select"
            id="question-${index}-type"
            name="type"
            ${disabled ? "disabled" : ""}
          >
            <option value="apply" ${typeKey === "apply" ? "selected" : ""}>Apply (Practical Application)</option>
            <option value="law" ${typeKey === "law" ? "selected" : ""}>Law (Statutory Provisions)</option>
            <option value="evidence" ${typeKey === "evidence" ? "selected" : ""}>Evidence (Digital Trail)</option>
            <option value="precaution" ${typeKey === "precaution" ? "selected" : ""}>Precaution (Safeguards)</option>
          </select>
        </div>
      </div>

      <label class="question-prompt-label" for="question-${index}-scenarioTitle">SCENARIO TITLE</label>
      <input
        class="question-prompt-input"
        id="question-${index}-scenarioTitle"
        name="scenarioTitle"
        type="text"
        maxlength="250"
        value="${escapeHtml(question.scenarioTitle || "")}"
        placeholder="e.g. The refund that went elsewhere"
        required
        ${disabled ? "disabled" : ""}
      />

      <label class="question-prompt-label" for="question-${index}-scenarioText">SCENARIO CASE FACTS / NARRATIVE</label>
      <textarea
        class="question-prompt-input question-textarea"
        id="question-${index}-scenarioText"
        name="scenarioText"
        rows="3"
        maxlength="2000"
        placeholder="Detailed scenario facts..."
        required
        ${disabled ? "disabled" : ""}
      >${escapeHtml(question.scenarioText || "")}</textarea>

      <label class="question-prompt-label" for="question-${index}-scenarioSource">SCENARIO SOURCE / CITATION</label>
      <input
        class="question-prompt-input"
        id="question-${index}-scenarioSource"
        name="scenarioSource"
        type="text"
        maxlength="250"
        value="${escapeHtml(question.scenarioSource || "")}"
        placeholder="e.g. The Tribune, 14 July 2026 (Panchkula Cyber Crime Police)"
        ${disabled ? "disabled" : ""}
      />

      <label class="question-prompt-label" for="question-${index}-prompt">QUESTION PROMPT</label>
      <textarea
        class="question-prompt-input question-textarea"
        id="question-${index}-prompt"
        name="prompt"
        rows="2"
        maxlength="2000"
        placeholder="Question prompt..."
        required
        ${disabled ? "disabled" : ""}
      >${escapeHtml(question.prompt)}</textarea>

      <div class="question-option-grid">${options}</div>

      <fieldset class="correct-options">
        <legend>SELECT THE CORRECT ANSWER</legend>
        ${correctOptions}
      </fieldset>

      <label class="question-prompt-label" for="question-${index}-explanation">ANALYSIS & EXPLANATION</label>
      <textarea
        class="question-prompt-input question-textarea"
        id="question-${index}-explanation"
        name="explanation"
        rows="2"
        maxlength="1000"
        placeholder="Why this option is correct..."
        ${disabled ? "disabled" : ""}
      >${escapeHtml(question.explanation || "")}</textarea>

      <label class="question-prompt-label" for="question-${index}-slides">SLIDE REFERENCES (COMMA-SEPARATED)</label>
      <input
        class="question-prompt-input"
        id="question-${index}-slides"
        name="slides"
        type="text"
        maxlength="100"
        value="${escapeHtml(Array.isArray(question.slides) ? question.slides.join(", ") : "")}"
        placeholder="e.g. 3, 6, 30"
        ${disabled ? "disabled" : ""}
      />

      <div class="question-editor-buttons">
        <button class="button button-primary question-save-button" type="submit" ${disabled ? "disabled" : ""}>
          ${isNew ? "Add question" : "Save changes"}
        </button>
        ${
          !isNew
            ? `<button class="button button-secondary question-cancel-button" type="button" data-index="${index}">Cancel</button>`
            : ""
        }
      </div>
    </form>`;
}

function renderDashboard(state) {
  const joinUrl = state.joinUrl;
  const joinHref = escapeHtml(joinUrl);
  const questionsEnabled = state.phase === "lobby";

  const questionCards = state.questions
    .map((question, index) => {
      const isEditing = editingQuestionIndex === index;
      if (isEditing) {
        return `
          <article class="question-editor-card is-editing">
            <div class="question-editor-card-heading">
              <span class="question-card-number">EDITING #${String(index + 1).padStart(2, "0")}</span>
            </div>
            ${questionEditorForm(question, index, !questionsEnabled)}
          </article>`;
      }

      const scenarioNum = question.scenarioId || (Math.floor(index / 4) + 1);
      const typeKey = (question.type || "apply").toLowerCase();
      const optionsPreview = question.options
        .map(
          (opt, i) => `
            <div class="question-option-preview ${question.correct === i ? "is-correct" : ""}">
              <span class="opt-letter">${letters[i]}</span>
              <span class="opt-text">${escapeHtml(opt)}</span>
              ${question.correct === i ? `<span class="correct-badge">✓ CORRECT</span>` : ""}
            </div>`,
        )
        .join("");

      return `
        <article class="question-editor-card" data-card-index="${index}">
          <div class="question-editor-card-heading">
            <div class="question-heading-left">
              <div class="admin-q-tags">
                <span class="question-card-number">#${String(index + 1).padStart(2, "0")}</span>
                <span class="admin-scenario-pill">Scenario ${scenarioNum}</span>
                <span class="admin-type-pill admin-type-${typeKey}">${escapeHtml(question.typeLabel || typeKey.toUpperCase())}</span>
              </div>
              <h4 class="question-preview-title">${escapeHtml(question.prompt)}</h4>
              <div class="admin-scenario-context">
                <strong>Case:</strong> ${escapeHtml(question.scenarioTitle || `Scenario ${scenarioNum}`)}
              </div>
            </div>
            <div class="question-card-actions">
              <button
                class="text-button question-edit-btn"
                type="button"
                data-index="${index}"
                ${!questionsEnabled ? "disabled title='Question editing locked during quiz'" : ""}
              >
                Edit
              </button>
              <button
                class="text-button question-delete-button"
                type="button"
                data-index="${index}"
                ${!questionsEnabled || state.questions.length === 1 ? "disabled" : ""}
              >
                Delete
              </button>
            </div>
          </div>
          <div class="question-options-preview-grid">${optionsPreview}</div>
          ${question.explanation ? `
            <div class="admin-exp-preview">
              <span class="admin-exp-icon">💡</span>
              <span class="admin-exp-text"><strong>Analysis:</strong> ${escapeHtml(question.explanation)}</span>
              ${Array.isArray(question.slides) && question.slides.length ? `<span class="admin-slides-tag">Slides: ${question.slides.join(", ")}</span>` : ""}
            </div>` : ""}
        </article>`;
    })
    .join("");

  const leaderboardHtml = state.leaderboard.length
    ? state.leaderboard
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
        .join("")
    : `<div class="empty-state"><span class="empty-icon">✳</span><p>No players on the leaderboard yet.<br />Scores will appear as participants answer.</p></div>`;

  adminApp.innerHTML = `
    <div class="admin-shell">
      <header class="topbar">
        <div class="topbar-left">
          <a class="brand" href="/" aria-label="Quiz Night home">
            <span class="brand-mark">q<span>.</span></span>
            <span>quiz<span class="brand-light">night</span></span>
          </a>
          <span class="admin-pill-badge">ADMIN CONSOLE</span>
        </div>
        <div class="topbar-center">
          <div class="event-tag">
            <span class="status-dot ${state.phase === "live" ? "is-live" : ""}"></span>
            ${phaseLabel(state.phase)}
          </div>
          <span class="quiz-length"><span class="length-dot"></span>Round #${state.roundId}</span>
        </div>
        <div class="topbar-actions">
          <a class="topbar-link-button" href="/" target="_blank" rel="noopener">Open Live Screen <span>↗</span></a>
          <button class="topbar-link-button signout-btn" type="button" id="admin-logout">Sign out</button>
        </div>
      </header>

      <main class="admin-main">
        <section class="admin-hero-strip">
          <div class="admin-strip-info">
            <div class="eyebrow"><span class="eyebrow-line"></span> CONTROL CENTER</div>
            <h1 class="admin-strip-title">Quiz Management</h1>
            <p class="admin-strip-subtitle">Launch live rounds, configure questions, and manage audience access.</p>
          </div>
          <div class="admin-strip-actions">
            <div class="quiz-controls">
              <button class="button button-primary" id="start-quiz" ${state.phase !== "lobby" ? "disabled" : ""}>
                <span>Start quiz</span><span class="button-arrow">↗</span>
              </button>
              <button class="button button-end" id="end-quiz" ${state.phase !== "live" ? "disabled" : ""}>
                <span>Wrap quiz</span><span class="button-arrow">■</span>
              </button>
              <button class="button button-reset" id="reset-quiz">
                <span>Reset quiz</span><span class="button-arrow">↻</span>
              </button>
              <button class="button button-secondary download-btn" id="download-csv" type="button">
                <span>Scoresheet CSV</span><span class="button-arrow">↓</span>
              </button>
            </div>
          </div>
        </section>

        <div class="admin-layout-grid">
          <!-- Left Column: Room Settings & Live Stats -->
          <div class="admin-col-side">
            <!-- Room Settings -->
            <article class="panel admin-card">
              <div class="panel-heading">
                <div><div class="eyebrow">AUDIENCE JOIN SETTINGS</div><h2>Room & QR Code</h2></div>
                <span class="qr-badge">CONFIG</span>
              </div>
              <div class="admin-qr-preview">
                <a class="qr-frame admin-qr-frame" href="${joinHref}" target="_blank" rel="noopener">
                  <img src="/api/qr" alt="Audience Join QR Code" />
                </a>
              </div>
              <form class="admin-url-form" id="admin-url-form">
                <label for="join-url-input">AUDIENCE JOIN URL</label>
                <div class="admin-url-row">
                  <input id="join-url-input" name="joinUrl" type="url" value="${escapeHtml(joinUrl)}" required />
                  <button class="button button-primary" type="submit">Save URL</button>
                </div>
                <p>Include the device-reachable URL or IP. QR code and join links update automatically.</p>
                <div class="form-error" id="admin-url-error" role="alert"></div>
              </form>
              <div class="admin-url-copy-row">
                <button class="button button-secondary copy-full-btn" type="button" id="copy-join-link">
                  <span>Copy Audience Link</span><span>📋</span>
                </button>
              </div>
            </article>

            <!-- Live Monitor -->
            <article class="panel admin-card">
              <div class="panel-heading">
                <div><div class="eyebrow">LIVE MONITOR</div><h2>Participants</h2></div>
                <span class="live-indicator"><i></i> LIVE</span>
              </div>
              <div class="stat-list admin-stat-list">
                <div class="stat-item">
                  <div class="stat-icon people-icon">♧</div>
                  <div class="stat-label">In room</div>
                  <div class="stat-number" id="admin-player-count">${state.participantCount}</div>
                </div>
                <div class="stat-item">
                  <div class="stat-icon answer-icon">↗</div>
                  <div class="stat-label">Answers</div>
                  <div class="stat-number" id="admin-answer-count">${state.submittedAnswers}</div>
                </div>
                <div class="stat-item">
                  <div class="stat-icon finish-icon">✳</div>
                  <div class="stat-label">Finished</div>
                  <div class="stat-number" id="admin-finished-count">${state.completedCount}</div>
                </div>
              </div>
              <div class="admin-leaderboard-wrap">
                <div class="admin-section-subtitle">Top Scores (Real-time)</div>
                <div class="leader-list" id="admin-leader-list">${leaderboardHtml}</div>
              </div>
            </article>
          </div>

          <!-- Right Column: Question Bank & Management -->
          <div class="admin-col-main">
            <article class="panel admin-card question-manager-card">
              <div class="panel-heading">
                <div>
                  <div class="eyebrow">QUIZ CONTENT</div>
                  <h2>Question Bank (${state.questions.length} / 100)</h2>
                </div>
                <span class="status-pill ${questionsEnabled ? "is-active" : "is-locked"}">
                  ${questionsEnabled ? "Editable (Lobby)" : "Locked (Quiz Active)"}
                </span>
              </div>
              <p class="question-manager-note">
                ${
                  questionsEnabled
                    ? "Add or edit scenario-based questions before the quiz starts. Each question includes four multiple-choice options, scenario facts, legal rationale, and slide references."
                    : "Question editing is locked while a quiz is live or completed. Reset the quiz to edit questions."
                }
              </p>

              ${
                questionsEnabled && state.questions.length < 100
                  ? `<div class="admin-add-question-section">
                      <div class="admin-subheading">
                        <h3>+ Add New Question</h3>
                      </div>
                      <div class="question-editor-card question-add-card">
                        ${questionEditorForm({ scenarioId: 1, scenarioTitle: "", scenarioText: "", scenarioSource: "", type: "apply", prompt: "", options: ["", "", "", ""], correct: 0, explanation: "", slides: [] }, "new")}
                      </div>
                    </div>`
                  : ""
              }

              <div class="admin-subheading" style="margin-top: 24px;">
                <h3>Questions in Quiz (${state.questions.length})</h3>
              </div>
              <div class="question-editor-list">${questionCards}</div>
              <div class="form-error" id="question-error" role="alert"></div>
            </article>
          </div>
        </div>
      </main>
    </div>`;

  setupDashboardEvents(state);
}

function updateLiveStats(state) {
  const playerCount = document.querySelector("#admin-player-count");
  const answerCount = document.querySelector("#admin-answer-count");
  const finishedCount = document.querySelector("#admin-finished-count");
  if (playerCount) playerCount.textContent = String(state.participantCount);
  if (answerCount) answerCount.textContent = String(state.submittedAnswers);
  if (finishedCount) finishedCount.textContent = String(state.completedCount);

  const leaderList = document.querySelector("#admin-leader-list");
  if (leaderList && state.leaderboard.length) {
    leaderList.innerHTML = state.leaderboard
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

function setupDashboardEvents(state) {
  // Start quiz
  document.querySelector("#start-quiz")?.addEventListener("click", async () => {
    try {
      await request("/api/start", { method: "POST", body: "{}" });
      showToast("Quiz started! Players can now answer.");
      await refreshAdmin();
    } catch (error) {
      showToast(error.message);
    }
  });

  // End / Wrap quiz
  document.querySelector("#end-quiz")?.addEventListener("click", async () => {
    const confirmed = await confirmAction(
      "Wrap up this quiz?",
      "Players will no longer be able to submit answers. Final scores will be locked on the leaderboard.",
      "Wrap quiz",
    );
    if (!confirmed) return;

    try {
      await request("/api/end", { method: "POST", body: "{}" });
      await refreshAdmin();
      try {
        await downloadScoresheet();
        showToast("Quiz wrapped. Scoresheet downloaded.");
      } catch (err) {
        showToast(`Quiz wrapped, but scoresheet download failed: ${err.message}`);
      }
    } catch (error) {
      showToast(error.message);
    }
  });

  // Reset quiz
  document.querySelector("#reset-quiz")?.addEventListener("click", async () => {
    const confirmed = await confirmAction(
      "Reset this quiz?",
      "This clears all players, answers, and leaderboard scores, and returns the room to the lobby.",
      "Reset quiz",
    );
    if (!confirmed) return;

    try {
      await request("/api/reset", { method: "POST", body: "{}" });
      await refreshAdmin();
      showToast("Quiz reset. The lobby is ready for the next round.");
    } catch (error) {
      showToast(error.message);
    }
  });

  // Download CSV
  document.querySelector("#download-csv")?.addEventListener("click", async () => {
    try {
      await downloadScoresheet();
      showToast("Scoresheet CSV downloaded.");
    } catch (error) {
      showToast(error.message);
    }
  });

  // Join URL form
  document.querySelector("#admin-url-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.querySelector("#admin-url-error");
    try {
      const formData = new FormData(event.currentTarget);
      const joinUrl = String(formData.get("joinUrl") || "").trim();
      await request("/api/admin/join-url", {
        method: "POST",
        body: JSON.stringify({ joinUrl }),
      });
      showToast("Audience URL and QR code updated.");
      await refreshAdmin();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message;
    }
  });

  // Copy link buttons
  const copyJoinLink = async () => {
    const joinUrl = latestState?.joinUrl;
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      showToast("Audience join link copied to clipboard.");
    } catch {
      showToast(`Join at ${joinUrl}`);
    }
  };
  document.querySelector("#copy-join-link")?.addEventListener("click", copyJoinLink);

  // Sign out
  document.querySelector("#admin-logout")?.addEventListener("click", async () => {
    try {
      await request("/api/admin/logout", { method: "POST", body: "{}" });
    } catch {
      // ignore
    } finally {
      removeAdminToken();
      renderLoginView("You have been signed out.");
    }
  });

  // Edit question toggle button
  document.querySelectorAll(".question-edit-btn").forEach((button) => {
    button.addEventListener("click", () => {
      editingQuestionIndex = Number(button.dataset.index);
      renderDashboard(latestState);
    });
  });

  // Cancel question edit
  document.querySelectorAll(".question-cancel-button").forEach((button) => {
    button.addEventListener("click", () => {
      editingQuestionIndex = null;
      renderDashboard(latestState);
    });
  });

  // Question save forms (both add new and edit existing)
  document.querySelectorAll(".question-editor-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const index = event.currentTarget.dataset.index;
      const type = String(formData.get("type") || "apply").trim();
      const typeLabelsMap = {
        apply: "Apply",
        law: "Law",
        evidence: "Evidence",
        precaution: "Precaution",
      };

      const question = {
        scenarioId: Number(formData.get("scenarioId")) || (index !== "new" ? Math.floor(Number(index) / 4) + 1 : 1),
        scenarioTitle: String(formData.get("scenarioTitle") || "").trim(),
        scenarioText: String(formData.get("scenarioText") || "").trim(),
        scenarioSource: String(formData.get("scenarioSource") || "").trim(),
        type,
        typeLabel: typeLabelsMap[type] || (type.charAt(0).toUpperCase() + type.slice(1)),
        prompt: String(formData.get("prompt") || "").trim(),
        options: [0, 1, 2, 3].map((i) => String(formData.get(`option${i}`) || "").trim()),
        correct: Number(formData.get("correct")),
        explanation: String(formData.get("explanation") || "").trim(),
        slides: String(formData.get("slides") || "")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter(Number.isInteger),
      };

      try {
        await request("/api/admin/questions", {
          method: "POST",
          body: JSON.stringify({
            action: index === "new" ? "add" : "edit",
            ...(index !== "new" ? { index: Number(index) } : {}),
            question,
          }),
        });
        editingQuestionIndex = null;
        await refreshAdmin();
        showToast(index === "new" ? "Question added successfully." : "Question saved successfully.");
      } catch (error) {
        const errorEl = document.querySelector("#question-error");
        if (errorEl) errorEl.textContent = error.message;
        else showToast(error.message);
      }
    });
  });

  // Delete question button
  document.querySelectorAll(".question-delete-button").forEach((button) => {
    button.addEventListener("click", async () => {
      const index = Number(button.dataset.index);
      const confirmed = await confirmAction(
        "Delete this question?",
        "This question will be permanently removed from the quiz bank.",
        "Delete question",
      );
      if (!confirmed) return;

      try {
        await request("/api/admin/questions", {
          method: "POST",
          body: JSON.stringify({ action: "delete", index }),
        });
        if (editingQuestionIndex === index) editingQuestionIndex = null;
        await refreshAdmin();
        showToast("Question deleted.");
      } catch (error) {
        const errorEl = document.querySelector("#question-error");
        if (errorEl) errorEl.textContent = error.message;
        else showToast(error.message);
      }
    });
  });
}

async function refreshAdmin() {
  const token = getAdminToken();
  if (!token) {
    if (!adminApp.querySelector(".admin-login-box")) {
      renderLoginView();
    }
    return;
  }

  try {
    const state = await request("/api/state");
    if (!state.isAdmin) {
      removeAdminToken();
      renderLoginView("Session expired. Please sign in again.");
      return;
    }

    const structureChanged =
      !latestState ||
      latestState.phase !== state.phase ||
      latestState.roundId !== state.roundId ||
      latestState.joinUrl !== state.joinUrl ||
      JSON.stringify(latestState.questions) !== JSON.stringify(state.questions);

    latestState = state;

    // If currently editing inline or focused on form input, only update stats
    const isTyping = document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
    if (!adminApp.querySelector(".admin-main") || (structureChanged && !isTyping && editingQuestionIndex === null)) {
      renderDashboard(state);
    } else {
      updateLiveStats(state);
    }
  } catch (error) {
    if (!getAdminToken()) {
      renderLoginView();
    } else {
      showToast(error.message);
    }
  }
}

// Initial bootstrap
refreshAdmin();

// Polling interval
window.setInterval(() => {
  if (document.visibilityState === "visible") {
    refreshAdmin().catch(() => {});
  }
}, 1200);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshAdmin();
});
