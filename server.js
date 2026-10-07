const express = require("express");
const http = require("http");
const path = require("path");
const QUIZZES = require("./quizzes.json");
const SETTINGS = require("./setting.json");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

if (
  !SETTINGS.bossName ||
  !Number.isInteger(SETTINGS.maxHp) || SETTINGS.maxHp <= 0 ||
  !Number.isFinite(SETTINGS.damageFirstToLastRatio) || SETTINGS.damageFirstToLastRatio <= 1 ||
  !Array.isArray(SETTINGS.characters) || SETTINGS.characters.length === 0 ||
  !Number.isInteger(SETTINGS.attackQueue?.maxBatchSize) ||
  SETTINGS.attackQueue.maxBatchSize < 1 || SETTINGS.attackQueue.maxBatchSize > 4 ||
  !Number.isInteger(SETTINGS.attackQueue?.minDelayMs) || SETTINGS.attackQueue.minDelayMs < 0 ||
  !Number.isInteger(SETTINGS.attackQueue?.maxDelayMs) ||
  SETTINGS.attackQueue.maxDelayMs < SETTINGS.attackQueue.minDelayMs
) {
  throw new Error("setting.json의 게임 설정값을 확인해주세요.");
}

if (!Array.isArray(QUIZZES) || QUIZZES.length === 0) {
  throw new Error("quizzes.json에 문제가 한 개 이상 있어야 합니다.");
}

let previousTargetHp = SETTINGS.maxHp;
QUIZZES.forEach((quiz, index) => {
  if (
    quiz.round !== index + 1 ||
    !Number.isInteger(quiz.targetHp) ||
    quiz.targetHp < 1 ||
    quiz.targetHp > previousTargetHp ||
    !Array.isArray(quiz.options) ||
    quiz.options.length < 2 ||
    !Number.isInteger(quiz.answer) ||
    quiz.answer < 0 ||
    quiz.answer >= quiz.options.length
  ) {
    throw new Error(`quizzes.json ${index + 1}번 문제 설정을 확인해주세요.`);
  }
  previousTargetHp = quiz.targetHp;
});

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 80;

// --------------------------------------------------
// Express
// --------------------------------------------------

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------
// 게임 상태
// --------------------------------------------------

const gameState = {
  bossName: SETTINGS.bossName,

  maxHp: SETTINGS.maxHp,
  currentHp: SETTINGS.maxHp,

  currentRound: 0,
  roundStartingHp: SETTINGS.maxHp,
  lastCorrectDamage: 0,
  isStarted: false,
  gameOver: false,
  finalRoundComplete: false,
  answeredPlayers: new Set(),
  playerDamage: new Map(),

  // socket.id -> player
  players: new Map()
};

const attackQueue = [];
let attackQueueTimer = null;
let openingAttackPending = true;
let executionTimer = null;

function getProjectedHp() {
  const queuedDamage = attackQueue.reduce((sum, attack) => sum + attack.damage, 0);
  return Math.min(
    gameState.maxHp,
    Math.max(0, gameState.currentHp - queuedDamage)
  );
}

function formatDamage(damage) {
  return Number(damage).toLocaleString("ko-KR", {
    maximumFractionDigits: 2
  });
}

function calculateAttackDamage(targetHp, remainingPlayers) {
  const H0 = gameState.roundStartingHp;
  const T = targetHp;
  const B = Math.max(0, H0 - T);
  const projectedHp = getProjectedHp();
  const U = Math.min(B, Math.max(0, H0 - projectedHp));
  const R = Math.max(0, B - U);
  const N = Math.max(1, remainingPlayers);

  if (R === 0) {
    return 0;
  }

  const q = N === 1
    ? 0
    : Math.pow(1 / SETTINGS.damageFirstToLastRatio, 1 / (N - 1));
  let Wtotal = 0;
  for (let i = 0; i < N; i += 1) {
    Wtotal += Math.pow(q, i);
  }

  const Dweighted = R / Wtotal;
  const damageLimit = U === 0
    ? R
    : gameState.lastCorrectDamage * 0.999;

  return Math.max(0, Math.min(Dweighted, damageLimit, R));
}

function executeFinalBlow() {
  if (gameState.gameOver || !gameState.finalRoundComplete) {
    return;
  }

  const performers = [...gameState.playerDamage.values()];
  performers.sort((a, b) => b.damage - a.damage);
  const executor = performers[0];

  if (!executor) {
    return;
  }

  const finishingDamage = gameState.currentHp;
  gameState.currentHp = 0;
  gameState.gameOver = true;
  gameState.isStarted = false;

  io.emit("player_execution", {
    playerId: executor.playerId,
    nickname: executor.nickname,
    className: executor.className,
    character: executor.character,
    bossName: gameState.bossName,
    damage: finishingDamage
  });

  io.emit("boss_damaged", {
    damage: finishingDamage,
    currentHp: 0,
    maxHp: gameState.maxHp,
    attacker: executor.nickname,
    playerId: executor.playerId
  });

  broadcastAdminState();
  executionTimer = setTimeout(() => {
    io.emit("boss_defeated", {
      bossName: gameState.bossName,
      maxHp: gameState.maxHp,
      executor
    });
    executionTimer = null;
  }, 1700);
}

function completeFinalRoundIfReady() {
  const finalRound = QUIZZES.length;
  if (
    gameState.currentRound !== finalRound ||
    gameState.finalRoundComplete ||
    gameState.players.size === 0
  ) {
    return;
  }

  const everyoneSolved = [...gameState.players.values()].every(player =>
    player.answeredRounds.has(finalRound)
  );
  if (!everyoneSolved) {
    return;
  }

  gameState.finalRoundComplete = true;
  gameState.isStarted = false;
  broadcastAdminState();

  if (attackQueue.length === 0) {
    if (attackQueueTimer !== null) {
      clearTimeout(attackQueueTimer);
      attackQueueTimer = null;
    }
    executeFinalBlow();
  }
}

function queuePlayerAttack(attack) {
  attackQueue.push(attack);
  if (attackQueueTimer === null) {
    processAttackQueue();
  }
}

function processAttackQueue() {
  if (attackQueue.length === 0) {
    attackQueueTimer = null;
    if (gameState.finalRoundComplete) {
      executeFinalBlow();
    }
    return;
  }

  const openingAttack = openingAttackPending;
  const batchSize = openingAttack
    ? 1
    : 1 + Math.floor(Math.random() * SETTINGS.attackQueue.maxBatchSize);
  const attacks = attackQueue.splice(0, batchSize);
  openingAttackPending = false;

  attacks.forEach((attack) => {
    const hpBeforeAttack = gameState.currentHp;
    gameState.currentHp = Math.max(
      attack.targetHp,
      gameState.currentHp - attack.damage
    );
    attack.damage = hpBeforeAttack - gameState.currentHp;
    attack.currentHp = gameState.currentHp;
    attack.maxHp = gameState.maxHp;

    const total = gameState.playerDamage.get(attack.playerId) || {
      playerId: attack.playerId,
      nickname: attack.nickname,
      className: attack.className,
      character: attack.character,
      damage: 0
    };
    total.damage += attack.damage;
    gameState.playerDamage.set(attack.playerId, total);

    io.emit("player_attack", {
      ...attack,
      openingAttack
    });

    io.emit("boss_damaged", {
      damage: attack.damage,
      currentHp: attack.currentHp,
      maxHp: attack.maxHp,
      attacker: attack.nickname,
      playerId: attack.playerId
    });
  });

  if (gameState.finalRoundComplete && attackQueue.length === 0) {
    executeFinalBlow();
    return;
  }

  const delayRange = SETTINGS.attackQueue.maxDelayMs - SETTINGS.attackQueue.minDelayMs + 1;
  const randomDelay = SETTINGS.attackQueue.minDelayMs + Math.floor(Math.random() * delayRange);
  attackQueueTimer = setTimeout(processAttackQueue, randomDelay);
}

function resetAttackQueue() {
  attackQueue.length = 0;
  if (attackQueueTimer !== null) {
    clearTimeout(attackQueueTimer);
    attackQueueTimer = null;
  }
  openingAttackPending = true;
}

// --------------------------------------------------
// 캐릭터 목록
// display.html에서 사용할 캐릭터
// --------------------------------------------------

// --------------------------------------------------
// 유틸리티
// --------------------------------------------------

function createPlayerList() {
  return Array.from(gameState.players.values()).map((player) => ({
    id: player.id,
    nickname: player.nickname,
    className: player.className,
    character: player.character
  }));
}

function broadcastPlayers() {
  const players = createPlayerList();

  io.emit("players_update", {
    players,
    count: players.length
  });

  io.emit("player_count_update", {
    count: players.length
  });
  broadcastAdminState();
}

function getAdminState() {
  return {
    playerCount: gameState.players.size,
    answeredCount: gameState.answeredPlayers.size,
    currentRound: gameState.currentRound,
    roundCount: QUIZZES.length,
    isStarted: gameState.isStarted,
    gameOver: gameState.gameOver
  };
}

function broadcastAdminState() {
  io.emit("admin_state", getAdminState());
}

// --------------------------------------------------
// 페이지
// --------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "player.html")
  );
});

app.get("/display", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "display.html")
  );
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// --------------------------------------------------
// QR 코드
// --------------------------------------------------

app.get("/api/qr", async (req, res) => {
  try {
    const host =
      process.env.PUBLIC_URL ||
      `${req.protocol}://${req.get("host")}`;

    const playerUrl = `${host}/`;

    const qr = await QRCode.toDataURL(playerUrl, {
      width: 600,
      margin: 2
    });

    res.json({
      url: playerUrl,
      qr
    });

  } catch (error) {
    console.error("QR 생성 오류:", error);

    res.status(500).json({
      error: "QR 생성 실패"
    });
  }
});

// --------------------------------------------------
// 현재 게임 상태
// --------------------------------------------------

app.get("/api/state", (req, res) => {
  res.json({
    bossName: gameState.bossName,
    maxHp: gameState.maxHp,
    currentHp: gameState.currentHp,

    currentRound: gameState.currentRound,

    isStarted: gameState.isStarted,
    gameOver: gameState.gameOver,

    playerCount: gameState.players.size,
    answeredCount: gameState.answeredPlayers.size
  });
});

// --------------------------------------------------
// Socket.IO
// --------------------------------------------------

io.on("connection", (socket) => {

  console.log(`Socket 접속: ${socket.id}`);

  // -----------------------------------------------
  // 접속 즉시 현재 상태 전달
  // -----------------------------------------------

  socket.emit("game_state", {
    bossName: gameState.bossName,

    maxHp: gameState.maxHp,
    currentHp: gameState.currentHp,

    currentRound: gameState.currentRound,

    isStarted: gameState.isStarted,
    gameOver: gameState.gameOver,

    playerCount: gameState.players.size
  });

  // 현재 접속자 목록도 전달
  socket.emit("players_update", {
    players: createPlayerList(),
    count: gameState.players.size
  });
  socket.emit("admin_state", getAdminState());

  // -----------------------------------------------
  // 학생 입장
  // -----------------------------------------------

  socket.on("join", (data) => {

    const nickname =
      String(data?.nickname || "십자가 군병")
        .trim()
        .slice(0, 20);

    const className =
      String(data?.className || "")
        .trim()
        .slice(0, 20);

    if (!nickname) {

      socket.emit("join_error", {
        message: "이름을 입력해주세요."
      });

      return;
    }

    // 이미 입장한 socket이면 중복 등록 방지
    if (gameState.players.has(socket.id)) {

      socket.emit("join_success", {
        nickname,
        className
      });

      return;
    }

    // 랜덤 캐릭터
    const character =
      SETTINGS.characters[
        Math.floor(
          Math.random() * SETTINGS.characters.length
        )
      ];

    const player = {
      id: socket.id,

      nickname,
      className,

      character,

      // 현재 라운드 정답 처리 여부
      answeredRounds: new Set()
    };

    gameState.players.set(
      socket.id,
      player
    );

    console.log(
      `입장: ${nickname} / ${className} / ${character}`
    );

    // 학생에게 입장 성공
    socket.emit("join_success", {
      nickname,
      className
    });

    // 전체 화면에 플레이어 목록 전달
    broadcastPlayers();

    // ---------------------------------------------
    // 이미 게임 중이라면 현재 문제 전달
    // ---------------------------------------------

    if (
      gameState.isStarted &&
      gameState.currentRound > 0 &&
      !gameState.gameOver
    ) {

      const quiz =
        QUIZZES[
          gameState.currentRound - 1
        ];

      if (quiz) {

        socket.emit("new_question", {
          round: quiz.round,
          targetHp: quiz.targetHp,
          bossName: gameState.bossName,

          bossTalk: quiz.bossTalk,

          question: quiz.question,

          options: quiz.options
        });

      }
    }
  });

  // -----------------------------------------------
  // 라운드 시작
  // -----------------------------------------------

  socket.on("start_round", (data) => {

    const round =
      Number(data?.round);

    if (
      !Number.isInteger(round) ||
      round !== gameState.currentRound + 1 ||
      round > QUIZZES.length ||
      gameState.gameOver ||
      gameState.finalRoundComplete
    ) {
      return;
    }

    const quiz =
      QUIZZES[round - 1];

    gameState.roundStartingHp = getProjectedHp();
    gameState.lastCorrectDamage = 0;

    gameState.currentRound =
      round;

    gameState.answeredPlayers.clear();

    gameState.isStarted =
      true;

    gameState.gameOver =
      false;

    // 해당 라운드의 답안 기록 초기화
    for (
      const player of gameState.players.values()
    ) {

      player.answeredRounds.delete(
        round
      );

    }

    console.log(
      `========== ${round}라운드 시작 ==========`
    );

    // 모든 학생에게 문제 전달
    io.emit("new_question", {
      round: quiz.round,
      targetHp: quiz.targetHp,
      bossName: gameState.bossName,

      bossTalk: quiz.bossTalk,

      question: quiz.question,

      options: quiz.options
    });
    broadcastAdminState();

  });

  // -----------------------------------------------
  // 답안 제출
  // -----------------------------------------------

  socket.on("submit_answer", (data) => {

    if (
      !gameState.isStarted ||
      gameState.gameOver
    ) {
      return;
    }

    const round =
      Number(data?.round);

    const selected =
      Number(data?.selected);

    const player =
      gameState.players.get(
        socket.id
      );

    if (!player) {
      return;
    }

    // 현재 라운드인지 확인
    if (
      round !== gameState.currentRound
    ) {
      return;
    }

    const quiz =
      QUIZZES[round - 1];

    if (!quiz) {
      return;
    }

    // 보기 범위 검사
    if (
      !Number.isInteger(selected) ||
      selected < 0 ||
      selected >= quiz.options.length
    ) {
      return;
    }

    // ---------------------------------------------
    // 이미 해당 라운드에서 정답을 맞혔는지 확인
    // ---------------------------------------------

    if (
      player.answeredRounds.has(round)
    ) {

      socket.emit(
        "attack_result",
        {
          success: false,
          msg: "이미 타격에 성공했습니다!"
        }
      );

      return;
    }

    const remainingPlayersForDamage = Math.max(
      1,
      gameState.players.size - gameState.answeredPlayers.size
    );

    if (!gameState.answeredPlayers.has(player.id)) {
      gameState.answeredPlayers.add(player.id);
      broadcastAdminState();
    }

    // ---------------------------------------------
    // 오답
    // ---------------------------------------------

    if (
      selected !== quiz.answer
    ) {

      socket.emit(
        "attack_result",
        {
          success: false,

          msg:
            "방어막에 빗나갔습니다! 다시 조준하세요!"
        }
      );

      return;
    }

    // ---------------------------------------------
    // 정답
    // ---------------------------------------------

    player.answeredRounds.add(
      round
    );

    const damage = calculateAttackDamage(
      quiz.targetHp,
      remainingPlayersForDamage
    );
    gameState.lastCorrectDamage = damage;

    console.log(
      `⚔️ ${player.nickname} → -${formatDamage(damage)} HP`
    );

    // ---------------------------------------------
    // 핵심:
    // 누가 공격했는지 전체 display에 전달
    // ---------------------------------------------

    queuePlayerAttack({

      playerId: player.id,

      nickname: player.nickname,

      className: player.className,
      character: player.character,

      damage,
      targetHp: quiz.targetHp,
      round,

      currentHp:
        gameState.currentHp,

      maxHp:
        gameState.maxHp
    });

    io.emit("answer_correct", {
      nickname: player.nickname,
      className: player.className,
      damage
    });

    // 기존 boss_damaged 이벤트도 유지
    // 해당 학생에게 성공 메시지
    socket.emit(
      "attack_result",
      {
        success: true,

        msg: damage > 0
          ? `말씀의 검 적중! -${formatDamage(damage)} HP!`
          : "정답! 보스가 이번 문제의 목표 HP를 유지합니다."
      }
    );

    completeFinalRoundIfReady();

  });

  // -----------------------------------------------
  // 게임 리셋
  // -----------------------------------------------

  socket.on("reset_game", () => {

    resetAttackQueue();

    if (executionTimer !== null) {
      clearTimeout(executionTimer);
      executionTimer = null;
    }

    gameState.currentHp =
      gameState.maxHp;

    gameState.currentRound =
      0;

    gameState.roundStartingHp = gameState.maxHp;
    gameState.lastCorrectDamage = 0;

    gameState.isStarted =
      false;

    gameState.gameOver =
      false;

    gameState.finalRoundComplete = false;
    gameState.playerDamage.clear();

    gameState.answeredPlayers.clear();

    for (
      const player of gameState.players.values()
    ) {

      player.answeredRounds.clear();

    }

    io.emit(
      "game_reset",
      {
        maxHp:
          gameState.maxHp,

        currentHp:
          gameState.currentHp
      }
    );
    broadcastAdminState();

    console.log(
      "🔄 게임 리셋"
    );
  });

  // -----------------------------------------------
  // 연결 종료
  // -----------------------------------------------

  socket.on("disconnect", () => {

    const player =
      gameState.players.get(
        socket.id
      );

    if (player) {

      console.log(
        `퇴장: ${player.nickname}`
      );

    }

    gameState.players.delete(
      socket.id
    );

    gameState.answeredPlayers.delete(socket.id);

    // 퇴장한 뒤 전체 플레이어 목록 갱신
    broadcastPlayers();
    completeFinalRoundIfReady();

  });

});

// --------------------------------------------------
// 서버 시작
// --------------------------------------------------

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(`
========================================
⚔️ APOLLYON RAID SERVER
========================================

학생:
http://localhost:${PORT}/

프로젝터:
http://localhost:${PORT}/display

API:
http://localhost:${PORT}/api/state

QR:
http://localhost:${PORT}/api/qr

========================================
`);
  }
);
