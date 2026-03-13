// ============================================================
// Econ 111 MCQ Challenge — Application Logic
// ============================================================

(function () {
  "use strict";

  // ---- Decode question data (encoded to prevent easy extraction) ----
  const _raw = JSON.parse(atob(window._qd));
  const WEEKS = _raw.WEEKS;
  const LECTURES = _raw.LECTURES;
  delete window._qd;        // remove from global scope
  Object.freeze(WEEKS);     // prevent tampering

  // ---- State ----
  const state = {
    user: null,           // { email }
    currentQuiz: null,    // { week, questions, answers[], shuffledChoices[], currentIndex, startTime }
    scores: {},           // { week1: { best, attempts, lastAttempt }, ... }
    seenIds: [],          // question IDs already shown in previous quizzes
    timerInterval: null,
    timeRemaining: 0,
    pendingWeek: null,
  };

  // ---- DOM refs ----
  const $ = (id) => document.getElementById(id);

  // ---- Init ----
  function init() {
    loadLocalState();
    bindEvents();
    if (state.user) {
      loadScoresFromSheet();
      showDashboard();
    }
  }

  function loadLocalState() {
    try {
      const saved = localStorage.getItem("econ111_state");
      if (saved) {
        const data = JSON.parse(saved);
        state.user = data.user || null;
        state.scores = data.scores || {};
        state.seenIds = data.seenIds || [];
      }
    } catch (e) { /* ignore */ }
  }

  function saveLocalState() {
    localStorage.setItem("econ111_state", JSON.stringify({
      user: state.user,
      scores: state.scores,
      seenIds: state.seenIds,
    }));
  }

  // ---- Events ----
  function bindEvents() {
    $("btn-login").addEventListener("click", handleLogin);
    $("email-input").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });
    $("btn-logout").addEventListener("click", handleLogout);
    $("btn-leaderboard").addEventListener("click", () => showScreen("screen-leaderboard", renderLeaderboard));
    $("btn-prev").addEventListener("click", prevQuestion);
    $("btn-next").addEventListener("click", nextQuestion);
    $("btn-submit-quiz").addEventListener("click", submitQuiz);
    $("btn-review").addEventListener("click", toggleReview);
    $("btn-back-dashboard").addEventListener("click", showDashboard);
    $("btn-lb-back").addEventListener("click", showDashboard);
    $("btn-cancel-quiz").addEventListener("click", showDashboard);
    $("btn-start-quiz").addEventListener("click", () => {
      if (state.pendingWeek) startQuiz(state.pendingWeek);
    });

    // Leaderboard tabs
    document.querySelectorAll(".leaderboard-tabs .tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".leaderboard-tabs .tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        renderLeaderboard();
      });
    });

    $("week-select").addEventListener("change", renderLeaderboard);
  }

  // ---- Auth ----
  function handleLogin() {
    const email = $("email-input").value.trim().toLowerCase();
    const errEl = $("login-error");
    errEl.classList.add("hidden");

    if (!email || !email.includes("@")) {
      errEl.textContent = "Please enter a valid email address.";
      errEl.classList.remove("hidden");
      return;
    }

    if (CONFIG.requireApprovedEmail) {
      const approved = CONFIG.approvedEmails.map((e) => e.toLowerCase());
      if (!approved.includes(email)) {
        errEl.textContent = "This email is not on the approved student list.";
        errEl.classList.remove("hidden");
        return;
      }
    }

    state.user = { email };
    saveLocalState();
    loadScoresFromSheet();
    showDashboard();
  }

  function handleLogout() {
    clearTimer();
    state.user = null;
    state.currentQuiz = null;
    saveLocalState();
    $("user-info").classList.add("hidden");
    showScreen("screen-login");
    $("email-input").value = "";
  }

  // ---- Screen management ----
  function showScreen(id, callback) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $(id).classList.add("active");
    if (callback) callback();
    window.scrollTo(0, 0);
  }

  function showDashboard() {
    $("user-info").classList.remove("hidden");
    $("user-email").textContent = state.user.email;
    renderDashboard();
    showScreen("screen-dashboard");
  }

  // ---- Dashboard ----
  function renderDashboard() {
    const grid = $("weeks-grid");
    grid.innerHTML = "";

    const weekKeys = Object.keys(WEEKS).sort();
    let totalScore = 0;

    weekKeys.forEach((key) => {
      const weekNum = parseInt(key.replace("week", ""));
      const week = WEEKS[key];
      const isLocked = weekNum > CONFIG.currentWeek;
      const scoreData = state.scores[key];
      if (scoreData) totalScore += scoreData.best;

      const isAdmin = state.user && CONFIG.adminEmails && CONFIG.adminEmails.includes(state.user.email);
      const isCompleted = scoreData && scoreData.attempts > 0 && !isAdmin;

      const card = document.createElement("div");
      card.className = "week-card" + (isLocked ? " locked" : "") + (isCompleted ? " completed" : "");
      card.innerHTML = `
        <div class="week-number">Week ${weekNum} ${isCompleted ? '<span class="completed-badge">Completed</span>' : ""}</div>
        <div class="week-title">${week.title}</div>
        <div class="week-topics">${week.subtitle}</div>
        <div class="week-meta">
          <span>${isCompleted ? "Score:" : (scoreData && scoreData.attempts > 0 ? "Best:" : "Not attempted")}</span>
          ${scoreData && scoreData.attempts > 0 ? '<span class="best-score">' + scoreData.best + "/" + CONFIG.questionsPerQuiz + "</span>" : ""}
        </div>
        ${isLocked ? '<span class="lock-icon">&#x1f512;</span>' : ""}
      `;

      if (!isLocked && !isCompleted) {
        card.addEventListener("click", () => showPreQuiz(key));
      }
      grid.appendChild(card);
    });

    $("total-score").textContent = totalScore;
  }

  // ---- Pre-Quiz ----
  function showPreQuiz(weekKey) {
    const week = WEEKS[weekKey];
    if (!week) return;
    state.pendingWeek = weekKey;
    const weekNum = weekKey.replace("week", "");
    $("prequiz-title").textContent = "Week " + weekNum + ": " + week.title;
    showScreen("screen-prequiz");
  }

  // ---- Quiz ----
  function startQuiz(weekKey) {
    const week = WEEKS[weekKey];
    if (!week) return;

    // Combine questions from all lectures in this week
    const allQs = [];
    week.lectures.forEach((lecKey) => {
      if (LECTURES[lecKey]) {
        allQs.push(...LECTURES[lecKey].questions);
      }
    });

    // Exclude questions this student has already seen in previous weeks
    const seenSet = new Set(state.seenIds);
    const freshQs = allQs.filter((q) => !seenSet.has(q.id));
    const selected = selectQuestions(freshQs.length >= CONFIG.questionsPerQuiz ? freshQs : allQs, CONFIG.questionsPerQuiz);

    // Shuffle choices for each question and record the mapping
    const shuffledChoices = selected.map((q) => {
      const indices = q.choices.map((_, i) => i);
      shuffleArray(indices);
      return indices; // shuffled order: display[0] = original[indices[0]]
    });

    state.currentQuiz = {
      week: weekKey,
      title: week.title,
      questions: selected,
      shuffledChoices: shuffledChoices,
      answers: new Array(selected.length).fill(-1),
      currentIndex: 0,
      startTime: Date.now(),
    };

    state.timeRemaining = CONFIG.quizDuration;

    const weekNum = weekKey.replace("week", "");
    $("quiz-title").textContent = `Week ${weekNum}: ${week.title}`;

    showScreen("screen-quiz");
    showQuestion(0);
    startTimer();
  }

  function selectQuestions(pool, count) {
    // Try to pick balanced across difficulties
    const easy = pool.filter((q) => q.difficulty === "easy");
    const medium = pool.filter((q) => q.difficulty === "medium");
    const hard = pool.filter((q) => q.difficulty === "hard");

    shuffleArray(easy);
    shuffleArray(medium);
    shuffleArray(hard);

    const selected = [];
    const extreme = pool.filter((q) => q.difficulty === "extreme");
    shuffleArray(extreme);

    // Pick 4 easy, 5 medium, 4 hard, 2 extreme = 15
    const targets = [
      { arr: easy, n: 4 },
      { arr: medium, n: 5 },
      { arr: hard, n: 4 },
      { arr: extreme, n: 2 },
    ];

    targets.forEach(({ arr, n }) => {
      selected.push(...arr.slice(0, n));
    });

    // If we don't have enough, fill from remaining
    if (selected.length < count) {
      const usedIds = new Set(selected.map((q) => q.id));
      const remaining = pool.filter((q) => !usedIds.has(q.id));
      shuffleArray(remaining);
      selected.push(...remaining.slice(0, count - selected.length));
    }

    shuffleArray(selected);
    return selected.slice(0, count);
  }

  function showQuestion(index) {
    const quiz = state.currentQuiz;
    const q = quiz.questions[index];
    const shuffledIdx = quiz.shuffledChoices[index];

    quiz.currentIndex = index;

    // Progress
    $("quiz-progress").textContent = `Question ${index + 1} of ${quiz.questions.length}`;
    $("progress-fill").style.width = ((index + 1) / quiz.questions.length * 100) + "%";

    // Difficulty badge
    const badge = $("difficulty-badge");
    badge.textContent = q.difficulty;
    badge.className = "difficulty-badge " + q.difficulty;

    // Question text
    $("question-text").textContent = q.text;

    // Choices
    const container = $("choices-container");
    container.innerHTML = "";
    const letters = ["A", "B", "C", "D"];

    shuffledIdx.forEach((origIdx, displayIdx) => {
      const btn = document.createElement("button");
      btn.className = "choice-btn";
      if (quiz.answers[index] === origIdx) {
        btn.classList.add("selected");
      }
      btn.innerHTML = `
        <span class="choice-letter">${letters[displayIdx]}</span>
        <span class="choice-text">${q.choices[origIdx]}</span>
      `;
      btn.addEventListener("click", () => selectAnswer(origIdx, btn));
      container.appendChild(btn);
    });

    // Navigation buttons
    $("btn-prev").style.visibility = index === 0 ? "hidden" : "visible";
    if (index === quiz.questions.length - 1) {
      $("btn-next").classList.add("hidden");
      $("btn-submit-quiz").classList.remove("hidden");
    } else {
      $("btn-next").classList.remove("hidden");
      $("btn-submit-quiz").classList.add("hidden");
    }

    // Render math
    renderMath();
  }

  function selectAnswer(origIdx, btnEl) {
    state.currentQuiz.answers[state.currentQuiz.currentIndex] = origIdx;

    // Update visual
    document.querySelectorAll("#choices-container .choice-btn").forEach((b) => b.classList.remove("selected"));
    btnEl.classList.add("selected");
    const letterEl = btnEl.querySelector(".choice-letter");
    if (letterEl) {
      document.querySelectorAll("#choices-container .choice-letter").forEach((l) => {
        // Reset is handled by removing 'selected' above
      });
    }
  }

  function nextQuestion() {
    const quiz = state.currentQuiz;
    if (quiz.currentIndex < quiz.questions.length - 1) {
      showQuestion(quiz.currentIndex + 1);
    }
  }

  function prevQuestion() {
    const quiz = state.currentQuiz;
    if (quiz.currentIndex > 0) {
      showQuestion(quiz.currentIndex - 1);
    }
  }

  // ---- Timer ----
  function startTimer() {
    clearTimer();
    updateTimerDisplay();
    state.timerInterval = setInterval(() => {
      state.timeRemaining--;
      updateTimerDisplay();
      if (state.timeRemaining <= 0) {
        clearTimer();
        submitQuiz();
      }
    }, 1000);
  }

  function clearTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  function updateTimerDisplay() {
    const mins = Math.floor(state.timeRemaining / 60);
    const secs = state.timeRemaining % 60;
    const el = $("timer");
    el.textContent = mins.toString().padStart(2, "0") + ":" + secs.toString().padStart(2, "0");

    el.classList.remove("warning", "danger");
    if (state.timeRemaining <= 60) {
      el.classList.add("danger");
    } else if (state.timeRemaining <= 300) {
      el.classList.add("warning");
    }
  }

  // ---- Submit & Results ----
  function submitQuiz() {
    clearTimer();
    const quiz = state.currentQuiz;
    let correct = 0;

    quiz.questions.forEach((q, i) => {
      if (quiz.answers[i] === q.correct) correct++;
    });

    // Save score
    const weekKey = quiz.week;
    if (!state.scores[weekKey]) {
      state.scores[weekKey] = { best: 0, attempts: 0, lastAttempt: null };
    }
    const scoreData = state.scores[weekKey];
    scoreData.attempts++;
    scoreData.best = Math.max(scoreData.best, correct);
    scoreData.lastAttempt = new Date().toISOString();
    // Record seen question IDs so they won't repeat in future weeks
    quiz.questions.forEach((q) => {
      if (!state.seenIds.includes(q.id)) state.seenIds.push(q.id);
    });
    saveLocalState();
    saveScoreToSheet(weekKey, correct);

    // Show results
    $("result-score").textContent = correct;
    $("result-total").textContent = "/" + quiz.questions.length;
    $("score-message").textContent = getScoreMessage(correct, quiz.questions.length);
    $("review-container").classList.add("hidden");
    $("review-container").innerHTML = "";

    showScreen("screen-results");
  }

  function getScoreMessage(correct, total) {
    const pct = correct / total;
    if (pct === 1) return "Perfect score! Outstanding!";
    if (pct >= 0.8) return "Excellent work! Almost perfect!";
    if (pct >= 0.6) return "Good job! Keep practising!";
    if (pct >= 0.4) return "Not bad, but there is room for improvement.";
    return "Keep studying! Review the material and try again.";
  }

  function toggleReview() {
    const container = $("review-container");
    if (!container.classList.contains("hidden")) {
      container.classList.add("hidden");
      $("btn-review").textContent = "Review Answers";
      return;
    }

    $("btn-review").textContent = "Hide Review";
    container.innerHTML = "";
    const quiz = state.currentQuiz;
    const letters = ["A", "B", "C", "D"];

    quiz.questions.forEach((q, i) => {
      const userAnswer = quiz.answers[i];
      const isCorrect = userAnswer === q.correct;
      const shuffledIdx = quiz.shuffledChoices[i];

      let choicesHtml = "";
      shuffledIdx.forEach((origIdx, displayIdx) => {
        let cls = "";
        if (origIdx === q.correct) cls = "was-correct";
        else if (origIdx === userAnswer && !isCorrect) cls = "was-wrong";
        choicesHtml += `<div class="choice-line ${cls}">${letters[displayIdx]}. ${q.choices[origIdx]}</div>`;
      });

      const item = document.createElement("div");
      item.className = "review-item " + (isCorrect ? "correct" : "wrong");
      item.innerHTML = `
        <div class="review-header">
          <span>Question ${i + 1} <span class="difficulty-badge ${q.difficulty}" style="margin-left:8px">${q.difficulty}</span></span>
          <span class="review-status">${isCorrect ? "Correct" : (userAnswer === -1 ? "Unanswered" : "Wrong")}</span>
        </div>
        <div class="review-question">${q.text}</div>
        <div class="review-choices">${choicesHtml}</div>
        <div class="review-explanation">${q.explanation}</div>
      `;
      container.appendChild(item);
    });

    container.classList.remove("hidden");
    renderMath();
  }

  // ---- Leaderboard ----
  function renderLeaderboard() {
    const activeTab = document.querySelector(".leaderboard-tabs .tab.active").dataset.tab;
    const weekSelectContainer = $("week-select-container");
    const weekSelect = $("week-select");

    if (activeTab === "weekly") {
      weekSelectContainer.classList.remove("hidden");
      // Populate week selector
      weekSelect.innerHTML = "";
      const weekKeys = Object.keys(WEEKS).sort();
      weekKeys.forEach((key) => {
        const num = key.replace("week", "");
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = `Week ${num}: ${WEEKS[key].title}`;
        weekSelect.appendChild(opt);
      });
      renderWeeklyLeaderboard(weekSelect.value);
    } else {
      weekSelectContainer.classList.add("hidden");
      renderOverallLeaderboard();
    }
  }

  function renderOverallLeaderboard() {
    // Combine local data with Firebase data
    const entries = getLeaderboardEntries("overall");
    renderLeaderboardTable(entries);
  }

  function renderWeeklyLeaderboard(weekKey) {
    const entries = getLeaderboardEntries(weekKey);
    renderLeaderboardTable(entries);
  }

  function getLeaderboardEntries(mode) {
    // Start with local user's score
    const entries = [];
    const allScores = { ...leaderboardCache };

    // Add current user's scores
    if (state.user) {
      if (!allScores[state.user.email]) {
        allScores[state.user.email] = {};
      }
      Object.keys(state.scores).forEach((wk) => {
        if (!allScores[state.user.email][wk] || state.scores[wk].best > (allScores[state.user.email][wk] || 0)) {
          allScores[state.user.email] = allScores[state.user.email] || {};
          allScores[state.user.email][wk] = state.scores[wk].best;
        }
      });
    }

    // Build entries
    Object.keys(allScores).forEach((email) => {
      const data = allScores[email];
      let score = 0;

      if (mode === "overall") {
        Object.values(data).forEach((v) => { score += (typeof v === "number" ? v : 0); });
      } else {
        score = data[mode] || 0;
      }

      if (score > 0 || email === (state.user && state.user.email)) {
        entries.push({ email, score });
      }
    });

    entries.sort((a, b) => b.score - a.score);
    return entries;
  }

  function renderLeaderboardTable(entries) {
    const tbody = $("leaderboard-body");
    tbody.innerHTML = "";

    if (entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-light);padding:40px">No scores yet. Be the first!</td></tr>';
      return;
    }

    entries.forEach((entry, idx) => {
      const rank = idx + 1;
      const isCurrentUser = state.user && entry.email === state.user.email;
      const tr = document.createElement("tr");
      if (isCurrentUser) tr.classList.add("current-user");

      let rankHtml;
      if (rank <= 3) {
        rankHtml = `<span class="rank-badge rank-${rank}">${rank}</span>`;
      } else {
        rankHtml = `<span style="padding-left:8px">${rank}</span>`;
      }

      tr.innerHTML = `
        <td>${rankHtml}</td>
        <td>${entry.email}${isCurrentUser ? " (you)" : ""}</td>
        <td style="text-align:right;font-weight:600">${entry.score}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // ---- Google Sheets sync ----
  let leaderboardCache = {};

  function loadScoresFromSheet() {
    if (!CONFIG.sheetsApiUrl || !state.user) return;

    fetch(CONFIG.sheetsApiUrl)
      .then((r) => r.json())
      .then((json) => {
        if (json.status !== "ok") return;
        const allData = json.data;

        // Merge own scores (keep higher)
        const myData = allData[state.user.email];
        if (myData) {
          Object.keys(myData).forEach((wk) => {
            if (!state.scores[wk] || myData[wk] > state.scores[wk].best) {
              state.scores[wk] = {
                best: myData[wk],
                attempts: state.scores[wk] ? state.scores[wk].attempts : 1,
                lastAttempt: state.scores[wk] ? state.scores[wk].lastAttempt : null,
              };
            }
          });
          saveLocalState();
          renderDashboard();
        }

        // Populate leaderboard cache
        leaderboardCache = allData;
      })
      .catch((e) => console.warn("Sheet load failed:", e));
  }

  function saveScoreToSheet(weekKey, score) {
    if (!CONFIG.sheetsApiUrl || !state.user) return;
    const email = state.user.email;
    const scoreData = state.scores[weekKey];

    const params = new URLSearchParams({
      action: "save",
      email: email,
      weekKey: weekKey,
      best: scoreData.best,
      attempts: scoreData.attempts,
      lastAttempt: scoreData.lastAttempt,
    });

    fetch(CONFIG.sheetsApiUrl + "?" + params.toString())
      .then((r) => r.json())
      .then((json) => {
        if (json.status === "ok") {
          if (!leaderboardCache[email]) leaderboardCache[email] = {};
          leaderboardCache[email][weekKey] = scoreData.best;
        }
      })
      .catch((e) => console.warn("Sheet save failed:", e));
  }

  // ---- Helpers ----
  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function renderMath() {
    if (typeof renderMathInElement === "function") {
      renderMathInElement(document.body, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      });
    }
  }

  // ---- Boot ----
  document.addEventListener("DOMContentLoaded", init);
})();
