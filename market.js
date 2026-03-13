// ============================================================
// Market Survivor — Multiplayer Competitive Market Simulation
// ============================================================

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ---- A. MARKET CONFIG DEFAULTS ----
  const MARKET = {
    demandA: 100,
    demandB: 0.5,
    baseCostF: 20,
    baseCostC: 2,
    baseCostD: 0.1,
    costVariation: 0.15,
    maxRounds: 10,
    roundDuration: 60,
    maxQuantity: 50,
    bankruptcyThreshold: -3,
  };

  // ---- State ----
  const state = {
    email: null,
    gameId: null,
    gameCode: null,
    playerId: null,
    isInstructor: false,
    game: null,           // current game document snapshot
    players: [],          // array of player docs
    aiFirms: [],          // AI firm objects managed by game master
    myPlayer: null,       // this client's player doc
    submitted: false,
    timerInterval: null,
    chartDirty: true,
    selectedQuantity: 0,
  };

  let db = null;

  // ---- B. ECONOMICS ENGINE ----
  function totalCost(q, F, c, d) {
    return F + c * q + d * q * q;
  }

  function marginalCost(q, c, d) {
    return c + 2 * d * q;
  }

  function averageVariableCost(q, c, d) {
    return c + d * q;
  }

  function averageTotalCost(q, F, c, d) {
    if (q <= 0) return Infinity;
    return F / q + c + d * q;
  }

  function marketPrice(totalQ, A, B) {
    return Math.max(0, A - B * totalQ);
  }

  function profit(q, price, F, c, d) {
    return price * q - totalCost(q, F, c, d);
  }

  function optimalQuantity(price, c, d) {
    return Math.max(0, (price - c) / (2 * d));
  }

  // ---- C. CANVAS CHART RENDERER ----
  function drawChart() {
    const canvas = $("chart-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;

    // Chart area with margins
    const margin = { top: 30, right: 30, bottom: 50, left: 60 };
    const cw = W - margin.left - margin.right;
    const ch = H - margin.top - margin.bottom;

    // Scale parameters
    const maxQ = MARKET.maxQuantity + 5;
    const maxP = 120;

    function xPos(q) { return margin.left + (q / maxQ) * cw; }
    function yPos(p) { return margin.top + (1 - p / maxP) * ch; }

    // Clear
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = "#e8e8e8";
    ctx.lineWidth = 0.5;
    for (let p = 0; p <= maxP; p += 20) {
      ctx.beginPath();
      ctx.moveTo(margin.left, yPos(p));
      ctx.lineTo(W - margin.right, yPos(p));
      ctx.stroke();
    }
    for (let q = 0; q <= maxQ; q += 10) {
      ctx.beginPath();
      ctx.moveTo(xPos(q), margin.top);
      ctx.lineTo(xPos(q), H - margin.bottom);
      ctx.stroke();
    }

    // Axes
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, H - margin.bottom);
    ctx.lineTo(W - margin.right, H - margin.bottom);
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = "#333";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Quantity", margin.left + cw / 2, H - 8);

    ctx.save();
    ctx.translate(16, margin.top + ch / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Price / Cost ($)", 0, 0);
    ctx.restore();

    // Tick labels
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let q = 0; q <= maxQ; q += 10) {
      ctx.fillText(q.toString(), xPos(q), H - margin.bottom + 5);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let p = 0; p <= maxP; p += 20) {
      ctx.fillText(p.toString(), margin.left - 8, yPos(p));
    }

    // Get player cost params (or defaults)
    const p_c = state.myPlayer ? state.myPlayer.c : MARKET.baseCostC;
    const p_d = state.myPlayer ? state.myPlayer.d : MARKET.baseCostD;
    const p_F = state.myPlayer ? state.myPlayer.F : MARKET.baseCostF;

    // --- Demand curve (blue) ---
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let q = 0; q <= maxQ; q += 0.5) {
      var dp = Math.max(0, MARKET.demandA - MARKET.demandB * q);
      var px = xPos(q), py = yPos(dp);
      if (q === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // --- MC curve (red) ---
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let q = 0; q <= maxQ; q += 0.5) {
      var mc = marginalCost(q, p_c, p_d);
      if (mc > maxP) break;
      var px = xPos(q), py = yPos(mc);
      if (q === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // --- AVC curve (orange dashed) ---
    ctx.strokeStyle = "#ea580c";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (let q = 0; q <= maxQ; q += 0.5) {
      var avc = averageVariableCost(q, p_c, p_d);
      if (avc > maxP) break;
      var px = xPos(q), py = yPos(avc);
      if (q === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // --- ATC curve (purple) ---
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 2;
    ctx.beginPath();
    var atcStarted = false;
    for (let q = 1; q <= maxQ; q += 0.5) {
      var atc = averageTotalCost(q, p_F, p_c, p_d);
      if (atc > maxP) { if (atcStarted) break; else continue; }
      var px = xPos(q), py = yPos(atc);
      if (!atcStarted) { ctx.moveTo(px, py); atcStarted = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // --- Price line (green) ---
    var lastPrice = getLastPrice();
    if (lastPrice !== null) {
      ctx.strokeStyle = "#16a34a";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.moveTo(margin.left, yPos(lastPrice));
      ctx.lineTo(W - margin.right, yPos(lastPrice));
      ctx.stroke();
      ctx.setLineDash([]);

      // Price label
      ctx.fillStyle = "#16a34a";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText("P = " + lastPrice.toFixed(1), W - margin.right - 70, yPos(lastPrice) - 3);
    }

    // --- Selected quantity indicator + profit shading ---
    var sq = state.selectedQuantity;
    if (sq > 0 && lastPrice !== null) {
      var atcVal = averageTotalCost(sq, p_F, p_c, p_d);
      var priceY = yPos(lastPrice);
      var atcY = yPos(Math.min(atcVal, maxP));
      var qX = xPos(sq);

      // Profit/loss shading rectangle
      var rectLeft = xPos(0);
      var rectRight = qX;
      var topY = Math.min(priceY, atcY);
      var botY = Math.max(priceY, atcY);

      if (lastPrice >= atcVal) {
        ctx.fillStyle = "rgba(34, 197, 94, 0.18)"; // green for profit
      } else {
        ctx.fillStyle = "rgba(239, 68, 68, 0.18)"; // red for loss
      }
      ctx.fillRect(rectLeft, topY, rectRight - rectLeft, botY - topY);

      // Vertical line at q
      ctx.strokeStyle = "#6b7280";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(qX, margin.top);
      ctx.lineTo(qX, H - margin.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Dot at (q, price)
      ctx.fillStyle = "#16a34a";
      ctx.beginPath();
      ctx.arc(qX, priceY, 5, 0, 2 * Math.PI);
      ctx.fill();
    }

    // --- Legend ---
    var legendX = margin.left + 12;
    var legendY = margin.top + 10;
    var legendItems = [
      { color: "#2563eb", dash: false, label: "Demand (P = A - BQ)" },
      { color: "#dc2626", dash: false, label: "MC (c + 2dq)" },
      { color: "#ea580c", dash: true,  label: "AVC (c + dq)" },
      { color: "#7c3aed", dash: false, label: "ATC (F/q + c + dq)" },
    ];
    if (lastPrice !== null) {
      legendItems.push({ color: "#16a34a", dash: true, label: "Market Price" });
    }

    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    legendItems.forEach(function (item, i) {
      var ly = legendY + i * 18;
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      if (item.dash) ctx.setLineDash([5, 3]); else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(legendX, ly);
      ctx.lineTo(legendX + 24, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#333";
      ctx.fillText(item.label, legendX + 30, ly);
    });
  }

  function getLastPrice() {
    if (!state.game) return null;
    var rounds = state.game.rounds || [];
    if (rounds.length === 0) return null;
    return rounds[rounds.length - 1].price;
  }

  // ---- D. FIREBASE / FIRESTORE LAYER ----
  function initFirebase() {
    if (CONFIG.firebase && typeof firebase !== "undefined") {
      try {
        // Only initialize if not already done (app.js may have already called this)
        if (!firebase.apps.length) {
          firebase.initializeApp(CONFIG.firebase);
        }
        db = firebase.firestore();
      } catch (e) {
        console.warn("Firebase init failed:", e);
      }
    }
  }

  function generateGameCode() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    var code = "";
    for (var i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  function randomizeCostParams() {
    var v = MARKET.costVariation;
    return {
      F: MARKET.baseCostF * (1 + (Math.random() * 2 - 1) * v),
      c: MARKET.baseCostC * (1 + (Math.random() * 2 - 1) * v),
      d: MARKET.baseCostD * (1 + (Math.random() * 2 - 1) * v),
    };
  }

  async function createGame(email) {
    if (!db) throw new Error("Firebase required");
    var code = generateGameCode();
    var gameRef = db.collection("market_games").doc();
    await gameRef.set({
      code: code,
      createdBy: email,
      status: "lobby",
      currentRound: 0,
      rounds: [],
      aiFirms: [],
      roundDeadline: null,
      demandA: MARKET.demandA,
      demandB: MARKET.demandB,
      maxRounds: MARKET.maxRounds,
      roundDuration: MARKET.roundDuration,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    state.gameId = gameRef.id;
    state.gameCode = code;
    state.isInstructor = true;

    // Add instructor as a player too
    await joinGameInternal(email, gameRef.id);
    return code;
  }

  async function joinGame(email, gameCode) {
    if (!db) throw new Error("Firebase required");
    var snap = await db.collection("market_games")
      .where("code", "==", gameCode.toUpperCase())
      .limit(1)
      .get();
    if (snap.empty) throw new Error("Game not found. Check the code.");
    var doc = snap.docs[0];
    if (doc.data().status !== "lobby") throw new Error("Game already in progress.");
    state.gameId = doc.id;
    state.gameCode = gameCode.toUpperCase();
    state.isInstructor = (email === doc.data().createdBy);
    await joinGameInternal(email, doc.id);
  }

  async function joinGameInternal(email, gameId) {
    var playersRef = db.collection("market_games").doc(gameId).collection("players");
    // Check if already joined
    var existing = await playersRef.where("email", "==", email).limit(1).get();
    if (!existing.empty) {
      state.playerId = existing.docs[0].id;
      return;
    }
    var costs = randomizeCostParams();
    var playerRef = playersRef.doc();
    await playerRef.set({
      email: email,
      name: email.split("@")[0],
      F: costs.F,
      c: costs.c,
      d: costs.d,
      alive: true,
      cumulativeProfit: 0,
      submissions: {},
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    state.playerId = playerRef.id;
  }

  function listenToGame(gameId, callback) {
    return db.collection("market_games").doc(gameId).onSnapshot(function (doc) {
      callback(doc.data());
    });
  }

  function listenToPlayers(gameId, callback) {
    return db.collection("market_games").doc(gameId).collection("players")
      .onSnapshot(function (snap) {
        var players = [];
        snap.forEach(function (doc) {
          players.push({ id: doc.id, ...doc.data() });
        });
        callback(players);
      });
  }

  async function submitQuantity(round, quantity) {
    if (!db || !state.gameId || !state.playerId) return;
    var key = "submissions.round" + round;
    var update = {};
    update[key] = {
      quantity: quantity,
      submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection("market_games").doc(state.gameId)
      .collection("players").doc(state.playerId)
      .update(update);
  }

  async function startGame() {
    if (!db || !state.gameId) return;
    var deadline = Date.now() + MARKET.roundDuration * 1000;
    // Initialize AI firms
    var initialAI = [];
    for (var i = 0; i < 2; i++) {
      var costs = randomizeCostParams();
      initialAI.push({
        id: "ai_" + i,
        name: "AI Firm " + (i + 1),
        F: costs.F, c: costs.c, d: costs.d,
        alive: true,
        cumulativeProfit: 0,
        lastQuantity: 0,
      });
    }
    await db.collection("market_games").doc(state.gameId).update({
      status: "playing",
      currentRound: 1,
      roundDeadline: deadline,
      aiFirms: initialAI,
    });
  }

  async function publishRoundResults(results) {
    if (!db || !state.gameId) return;
    // Update game document with round results
    await db.collection("market_games").doc(state.gameId).update({
      rounds: firebase.firestore.FieldValue.arrayUnion(results.roundSummary),
      aiFirms: results.aiFirms,
    });
    // Update each player's doc
    var batch = db.batch();
    results.playerResults.forEach(function (pr) {
      var ref = db.collection("market_games").doc(state.gameId)
        .collection("players").doc(pr.id);
      batch.update(ref, {
        cumulativeProfit: pr.cumulativeProfit,
        alive: pr.alive,
      });
    });
    await batch.commit();
  }

  async function advanceToNextRound(nextRound) {
    if (!db || !state.gameId) return;
    var deadline = Date.now() + MARKET.roundDuration * 1000;
    await db.collection("market_games").doc(state.gameId).update({
      currentRound: nextRound,
      roundDeadline: deadline,
      status: "playing",
    });
  }

  async function setGameStatus(status) {
    if (!db || !state.gameId) return;
    await db.collection("market_games").doc(state.gameId).update({
      status: status,
    });
  }

  // ---- E. GAME MASTER LOGIC ----
  async function computeRoundResults() {
    var game = state.game;
    var round = game.currentRound;
    var rounds = game.rounds || [];
    var lastPrice = rounds.length > 0 ? rounds[rounds.length - 1].price : MARKET.demandA / 2;

    // Gather student submissions
    var playerResults = [];
    var totalQ = 0;

    state.players.forEach(function (p) {
      if (!p.alive) {
        playerResults.push({
          id: p.id, email: p.email, name: p.name,
          quantity: 0, revenue: 0, cost: 0, profit: 0,
          cumulativeProfit: p.cumulativeProfit, alive: false,
        });
        return;
      }
      var sub = p.submissions ? p.submissions["round" + round] : null;
      var q = sub ? sub.quantity : 0; // Default to 0 if not submitted
      totalQ += q;
      playerResults.push({
        id: p.id, email: p.email, name: p.name,
        quantity: q, F: p.F, c: p.c, d: p.d,
        cumulativeProfit: p.cumulativeProfit,
        alive: true,
      });
    });

    // AI firm quantities (naive expectations: use last round's price)
    var aiFirms = JSON.parse(JSON.stringify(game.aiFirms || []));
    aiFirms.forEach(function (ai) {
      if (!ai.alive) return;
      var q = Math.min(optimalQuantity(lastPrice, ai.c, ai.d), MARKET.maxQuantity);
      ai.lastQuantity = Math.round(q * 10) / 10;
      totalQ += ai.lastQuantity;
    });

    // Compute market price
    var price = marketPrice(totalQ, MARKET.demandA, MARKET.demandB);

    // Compute profits for students
    playerResults.forEach(function (pr) {
      if (!pr.alive && pr.quantity === 0) return;
      if (!pr.alive) return;
      var q = pr.quantity;
      var tc = totalCost(q, pr.F, pr.c, pr.d);
      var rev = price * q;
      var pi = rev - tc;
      pr.revenue = Math.round(rev * 100) / 100;
      pr.cost = Math.round(tc * 100) / 100;
      pr.profit = Math.round(pi * 100) / 100;
      pr.cumulativeProfit = Math.round((pr.cumulativeProfit + pi) * 100) / 100;

      // Bankruptcy check
      if (pr.cumulativeProfit < MARKET.bankruptcyThreshold * pr.F) {
        pr.alive = false;
      }
    });

    // Compute profits for AI firms
    var avgProfit = 0;
    var aliveAI = 0;
    aiFirms.forEach(function (ai) {
      if (!ai.alive) return;
      var q = ai.lastQuantity;
      var tc = totalCost(q, ai.F, ai.c, ai.d);
      var rev = price * q;
      var pi = rev - tc;
      ai.cumulativeProfit = Math.round((ai.cumulativeProfit + pi) * 100) / 100;
      avgProfit += pi;
      aliveAI++;

      if (ai.cumulativeProfit < MARKET.bankruptcyThreshold * ai.F) {
        ai.alive = false;
      }
    });

    if (aliveAI > 0) avgProfit /= aliveAI;

    // AI entry/exit
    var maxAI = Math.floor(MARKET.maxRounds / 2);
    var aliveAICount = aiFirms.filter(function (a) { return a.alive; }).length;
    if (avgProfit > 0 && aliveAICount < maxAI) {
      // Entry: add one AI firm
      var costs = randomizeCostParams();
      aiFirms.push({
        id: "ai_" + Date.now(),
        name: "AI Firm " + (aiFirms.length + 1),
        F: costs.F, c: costs.c, d: costs.d,
        alive: true, cumulativeProfit: 0, lastQuantity: 0,
      });
    } else if (avgProfit < -MARKET.baseCostF && aliveAICount > 0) {
      // Exit: remove one AI firm (most negative)
      var worst = null;
      aiFirms.forEach(function (ai) {
        if (!ai.alive) return;
        if (!worst || ai.cumulativeProfit < worst.cumulativeProfit) worst = ai;
      });
      if (worst) worst.alive = false;
    }

    var roundSummary = {
      round: round,
      price: Math.round(price * 100) / 100,
      totalQuantity: Math.round(totalQ * 100) / 100,
      numFirms: playerResults.filter(function (p) { return p.alive; }).length +
                aiFirms.filter(function (a) { return a.alive; }).length,
      avgProfit: Math.round(avgProfit * 100) / 100,
    };

    return { roundSummary: roundSummary, playerResults: playerResults, aiFirms: aiFirms };
  }

  // ---- F. AI FIRM MANAGER ----
  // AI logic is embedded in computeRoundResults above.
  // AI firms use naive expectations (last round price) and produce optimalQuantity.

  // ---- G. UI CONTROLLER ----
  function showScreen(id, callback) {
    document.querySelectorAll(".market-screen").forEach(function (s) {
      s.classList.remove("active");
    });
    var el = $(id);
    if (el) {
      el.classList.add("active");
      if (callback) callback();
    }
    window.scrollTo(0, 0);
  }

  function showError(msg) {
    var el = $("market-error");
    if (el) {
      el.textContent = msg;
      el.classList.remove("hidden");
      setTimeout(function () { el.classList.add("hidden"); }, 5000);
    }
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

  // --- Landing screen ---
  function bindLandingEvents() {
    var btnCreate = $("market-btn-create");
    var btnJoin = $("market-btn-join");
    var emailInput = $("market-email");
    var codeInput = $("market-code");

    if (btnCreate) btnCreate.addEventListener("click", async function () {
      var email = emailInput.value.trim().toLowerCase();
      if (!email || !email.includes("@")) { showError("Enter a valid email."); return; }
      if (!db) { showError("Firebase required for multiplayer."); return; }
      try {
        state.email = email;
        var code = await createGame(email);
        showLobby();
      } catch (e) {
        showError(e.message);
      }
    });

    if (btnJoin) btnJoin.addEventListener("click", async function () {
      var email = emailInput.value.trim().toLowerCase();
      var code = codeInput.value.trim().toUpperCase();
      if (!email || !email.includes("@")) { showError("Enter a valid email."); return; }
      if (!code || code.length < 4) { showError("Enter a valid game code."); return; }
      if (!db) { showError("Firebase required for multiplayer."); return; }
      try {
        state.email = email;
        await joinGame(email, code);
        showLobby();
      } catch (e) {
        showError(e.message);
      }
    });
  }

  // --- Lobby screen ---
  var unsubGame = null;
  var unsubPlayers = null;

  function showLobby() {
    showScreen("market-lobby");
    var codeEl = $("lobby-game-code");
    if (codeEl) codeEl.textContent = state.gameCode;

    var startBtn = $("lobby-btn-start");
    if (startBtn) {
      startBtn.classList.toggle("hidden", !state.isInstructor);
      startBtn.addEventListener("click", async function () {
        try {
          await startGame();
        } catch (e) {
          showError(e.message);
        }
      });
    }

    // Listen for game updates
    if (unsubGame) unsubGame();
    unsubGame = listenToGame(state.gameId, function (data) {
      state.game = data;
      if (data.status === "playing") {
        showRound();
      } else if (data.status === "between_rounds") {
        showBetweenRounds();
      } else if (data.status === "finished") {
        showFinished();
      }
    });

    // Listen for player updates
    if (unsubPlayers) unsubPlayers();
    unsubPlayers = listenToPlayers(state.gameId, function (players) {
      state.players = players;
      state.myPlayer = players.find(function (p) { return p.id === state.playerId; }) || null;
      renderLobbyPlayers();

      // If playing and game master, check if all submitted
      if (state.game && state.game.status === "playing" && state.isInstructor) {
        checkAllSubmitted();
      }
    });
  }

  function renderLobbyPlayers() {
    var list = $("lobby-player-list");
    if (!list) return;
    list.innerHTML = "";
    state.players.forEach(function (p) {
      var li = document.createElement("li");
      li.textContent = p.name + (p.email === state.email ? " (you)" : "");
      list.appendChild(li);
    });
    var countEl = $("lobby-player-count");
    if (countEl) countEl.textContent = state.players.length + " player(s)";
  }

  // --- Round screen ---
  function showRound() {
    state.submitted = false;
    showScreen("market-round");

    var game = state.game;
    var roundEl = $("round-number");
    if (roundEl) roundEl.textContent = "Round " + game.currentRound + " of " + MARKET.maxRounds;

    // Show cost function for this player
    renderCostInfo();

    // Set up quantity controls
    var slider = $("quantity-slider");
    var numInput = $("quantity-input");
    var profitDisplay = $("profit-preview");

    if (slider) {
      slider.max = MARKET.maxQuantity;
      slider.value = state.selectedQuantity;
    }
    if (numInput) {
      numInput.max = MARKET.maxQuantity;
      numInput.value = state.selectedQuantity;
    }

    // Sync slider ↔ number input
    if (slider) slider.addEventListener("input", function () {
      var q = parseInt(this.value) || 0;
      state.selectedQuantity = q;
      if (numInput) numInput.value = q;
      updateProfitPreview();
      drawChart();
    });
    if (numInput) numInput.addEventListener("input", function () {
      var q = Math.min(Math.max(0, parseInt(this.value) || 0), MARKET.maxQuantity);
      state.selectedQuantity = q;
      if (slider) slider.value = q;
      updateProfitPreview();
      drawChart();
    });

    // Submit button
    var submitBtn = $("round-btn-submit");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Quantity";
      submitBtn.onclick = async function () {
        try {
          await submitQuantity(game.currentRound, state.selectedQuantity);
          state.submitted = true;
          submitBtn.disabled = true;
          submitBtn.textContent = "Submitted — Waiting...";
        } catch (e) {
          showError("Submit failed: " + e.message);
        }
      };
    }

    // Start timer
    startRoundTimer();
    drawChart();
  }

  function renderCostInfo() {
    var el = $("cost-info");
    if (!el || !state.myPlayer) return;
    var p = state.myPlayer;
    var fStr = p.F.toFixed(1);
    var cStr = p.c.toFixed(2);
    var dStr = p.d.toFixed(3);
    el.innerHTML = "Your cost function: \\(TC = " + fStr + " + " + cStr + "q + " + dStr + "q^2\\)";
    renderMath();
  }

  function updateProfitPreview() {
    var el = $("profit-preview");
    if (!el || !state.myPlayer) return;
    var p = state.myPlayer;
    var q = state.selectedQuantity;
    var lp = getLastPrice();
    if (lp === null) {
      // First round: show cost only
      var tc = totalCost(q, p.F, p.c, p.d);
      el.innerHTML = "Cost: $" + tc.toFixed(2) + " | Price TBD (first round)";
      return;
    }
    var tc = totalCost(q, p.F, p.c, p.d);
    var rev = lp * q;
    var pi = rev - tc;
    var sign = pi >= 0 ? "+" : "";
    el.innerHTML = "At last price ($" + lp.toFixed(1) + "): Revenue $" + rev.toFixed(2) +
      " - Cost $" + tc.toFixed(2) + " = <strong style=\"color:" +
      (pi >= 0 ? "#16a34a" : "#dc2626") + "\">" + sign + pi.toFixed(2) + "</strong>";
  }

  // --- Timer ---
  function startRoundTimer() {
    clearRoundTimer();
    updateTimerDisplay();
    state.timerInterval = setInterval(function () {
      updateTimerDisplay();
    }, 1000);
  }

  function clearRoundTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  function updateTimerDisplay() {
    var el = $("round-timer");
    if (!el || !state.game || !state.game.roundDeadline) return;

    var remaining = Math.max(0, Math.ceil((state.game.roundDeadline - Date.now()) / 1000));
    var mins = Math.floor(remaining / 60);
    var secs = remaining % 60;
    el.textContent = mins.toString().padStart(2, "0") + ":" + secs.toString().padStart(2, "0");

    el.classList.remove("warning", "danger");
    if (remaining <= 10) el.classList.add("danger");
    else if (remaining <= 30) el.classList.add("warning");

    // Auto-submit when time expires
    if (remaining <= 0) {
      clearRoundTimer();
      if (!state.submitted) {
        state.selectedQuantity = 0;
        var submitBtn = $("round-btn-submit");
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = "Time expired";
        }
        submitQuantity(state.game.currentRound, 0).catch(function () {});
        state.submitted = true;
      }
      // If instructor, trigger round computation
      if (state.isInstructor) {
        setTimeout(function () { checkAllSubmitted(); }, 2000);
      }
    }
  }

  // --- Game master: check all submitted ---
  async function checkAllSubmitted() {
    if (!state.isInstructor || !state.game || state.game.status !== "playing") return;

    var round = state.game.currentRound;
    var deadline = state.game.roundDeadline || 0;
    var timeUp = Date.now() >= deadline;

    var alivePlayers = state.players.filter(function (p) { return p.alive; });
    var allSubmitted = alivePlayers.every(function (p) {
      return p.submissions && p.submissions["round" + round];
    });

    if (!allSubmitted && !timeUp) return;

    // Compute results
    try {
      var results = await computeRoundResults();
      await publishRoundResults(results);

      if (round >= MARKET.maxRounds) {
        await setGameStatus("finished");
      } else {
        await setGameStatus("between_rounds");
      }
    } catch (e) {
      showError("Error computing results: " + e.message);
    }
  }

  // --- Between rounds screen ---
  function showBetweenRounds() {
    clearRoundTimer();
    showScreen("market-between");

    var game = state.game;
    var rounds = game.rounds || [];
    var lastRound = rounds[rounds.length - 1];
    if (!lastRound) return;

    var summaryEl = $("between-summary");
    if (summaryEl) {
      summaryEl.innerHTML = "<h3>Round " + lastRound.round + " Results</h3>" +
        "<p>Market Price: <strong>$" + lastRound.price.toFixed(2) + "</strong> | " +
        "Total Quantity: " + lastRound.totalQuantity.toFixed(1) + " | " +
        "Active Firms: " + lastRound.numFirms + "</p>";
    }

    // Render player results table
    renderResultsTable();

    // Bankruptcy alerts
    if (state.myPlayer && !state.myPlayer.alive) {
      var alertEl = $("bankruptcy-alert");
      if (alertEl) {
        alertEl.textContent = "You have been eliminated (cumulative losses exceeded threshold).";
        alertEl.classList.remove("hidden");
      }
    }

    // Next round button (instructor only)
    var nextBtn = $("between-btn-next");
    if (nextBtn) {
      nextBtn.classList.toggle("hidden", !state.isInstructor);
      nextBtn.onclick = async function () {
        try {
          var nextRound = (game.currentRound || 1) + 1;
          if (nextRound > MARKET.maxRounds) {
            await setGameStatus("finished");
          } else {
            await advanceToNextRound(nextRound);
          }
        } catch (e) {
          showError(e.message);
        }
      };
    }

    drawChart();
  }

  function renderResultsTable() {
    var tbody = $("results-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    // Sort by cumulative profit descending
    var sorted = state.players.slice().sort(function (a, b) {
      return b.cumulativeProfit - a.cumulativeProfit;
    });

    sorted.forEach(function (p, idx) {
      var tr = document.createElement("tr");
      var isMe = p.id === state.playerId;
      if (isMe) tr.classList.add("highlight-row");
      if (!p.alive) tr.classList.add("eliminated-row");

      var round = state.game.currentRound;
      var sub = p.submissions ? p.submissions["round" + round] : null;
      var q = sub ? sub.quantity : 0;
      var rounds = state.game.rounds || [];
      var lastRound = rounds[rounds.length - 1];
      var price = lastRound ? lastRound.price : 0;
      var tc = totalCost(q, p.F, p.c, p.d);
      var pi = price * q - tc;

      tr.innerHTML =
        "<td>" + (idx + 1) + "</td>" +
        "<td>" + p.name + (isMe ? " (you)" : "") + (p.alive ? "" : " [OUT]") + "</td>" +
        "<td>" + q + "</td>" +
        "<td>$" + pi.toFixed(2) + "</td>" +
        "<td><strong>$" + p.cumulativeProfit.toFixed(2) + "</strong></td>";
      tbody.appendChild(tr);
    });

    // AI firms section
    var aiFirms = state.game.aiFirms || [];
    aiFirms.forEach(function (ai) {
      if (!ai.alive && ai.cumulativeProfit === 0) return;
      var tr = document.createElement("tr");
      tr.classList.add("ai-row");
      if (!ai.alive) tr.classList.add("eliminated-row");

      var q = ai.lastQuantity || 0;
      var rounds = state.game.rounds || [];
      var lastRound = rounds[rounds.length - 1];
      var price = lastRound ? lastRound.price : 0;
      var tc = totalCost(q, ai.F, ai.c, ai.d);
      var pi = price * q - tc;

      tr.innerHTML =
        "<td>-</td>" +
        "<td>" + ai.name + (ai.alive ? "" : " [OUT]") + "</td>" +
        "<td>" + q.toFixed(1) + "</td>" +
        "<td>$" + pi.toFixed(2) + "</td>" +
        "<td><strong>$" + ai.cumulativeProfit.toFixed(2) + "</strong></td>";
      tbody.appendChild(tr);
    });
  }

  // --- Finished screen ---
  function showFinished() {
    clearRoundTimer();
    showScreen("market-finished");
    renderLeaderboard();
  }

  function renderLeaderboard() {
    var tbody = $("leaderboard-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    // Combine students + AI, sort by cumulative profit
    var entries = [];
    state.players.forEach(function (p) {
      entries.push({
        name: p.name,
        email: p.email,
        cumulativeProfit: p.cumulativeProfit,
        alive: p.alive,
        isAI: false,
        isMe: p.id === state.playerId,
      });
    });
    (state.game.aiFirms || []).forEach(function (ai) {
      entries.push({
        name: ai.name,
        cumulativeProfit: ai.cumulativeProfit,
        alive: ai.alive,
        isAI: true,
        isMe: false,
      });
    });

    entries.sort(function (a, b) { return b.cumulativeProfit - a.cumulativeProfit; });

    entries.forEach(function (e, idx) {
      var tr = document.createElement("tr");
      if (e.isMe) tr.classList.add("highlight-row");
      if (e.isAI) tr.classList.add("ai-row");
      if (!e.alive) tr.classList.add("eliminated-row");

      var medal = "";
      if (idx === 0) medal = " \uD83E\uDD47";
      else if (idx === 1) medal = " \uD83E\uDD48";
      else if (idx === 2) medal = " \uD83E\uDD49";

      tr.innerHTML =
        "<td>" + (idx + 1) + medal + "</td>" +
        "<td>" + e.name + (e.isMe ? " (you)" : "") + (e.isAI ? " [AI]" : "") +
          (e.alive ? "" : " [eliminated]") + "</td>" +
        "<td><strong>$" + e.cumulativeProfit.toFixed(2) + "</strong></td>";
      tbody.appendChild(tr);
    });
  }

  // ---- H. TIMER ----
  // Timer logic is in startRoundTimer / updateTimerDisplay above.
  // Uses Firestore server timestamp via roundDeadline for synchronization.
  // Client computes remaining = roundDeadline - Date.now() and counts down.

  // ---- INIT ----
  function init() {
    initFirebase();

    if (!db) {
      var errEl = $("market-error");
      if (errEl) {
        errEl.textContent = "Firebase is required for Market Survivor. Configure it in config.js.";
        errEl.classList.remove("hidden");
      }
    }

    bindLandingEvents();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
