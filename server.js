const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const QUIZZES = require("./quizzes.json");
const SETTINGS = require("./setting.json");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

function isValidAudioSetting(audio) {
  return Boolean(audio) &&
    typeof audio.path === "string" &&
    typeof audio.loop === "boolean" &&
    (audio.path === "" || audio.path.toLowerCase() === "none" ||
      (path.basename(audio.path) === audio.path &&
        /^[a-z0-9][a-z0-9 ._-]*\.(mp3|ogg|wav|m4a|aac|flac|webm)$/i.test(audio.path)));
}

if (
  !SETTINGS.bossName ||
  !Number.isInteger(SETTINGS.maxHp) || SETTINGS.maxHp <= 0 ||
  !Number.isInteger(SETTINGS.timeLimitSeconds) || SETTINGS.timeLimitSeconds < 1 ||
  !Array.isArray(SETTINGS.bossImages) || SETTINGS.bossImages.length === 0 ||
  SETTINGS.bossImages.some(stage =>
    !Number.isInteger(stage.hp) || stage.hp < 0 || stage.hp > SETTINGS.maxHp ||
    typeof stage.image !== "string" || !stage.image || path.basename(stage.image) !== stage.image
  ) ||
  new Set(SETTINGS.bossImages.map(stage => stage.hp)).size !== SETTINGS.bossImages.length ||
  !isValidAudioSetting(SETTINGS.audio?.joining) ||
  !isValidAudioSetting(SETTINGS.audio?.execution) ||
  !SETTINGS.audio?.rounds || typeof SETTINGS.audio.rounds !== "object" ||
  !SETTINGS.audio?.volumes ||
  ["master", "bgm", "attack", "hit"].some(type =>
    !Number.isInteger(SETTINGS.audio.volumes[type]) ||
    SETTINGS.audio.volumes[type] < 0 || SETTINGS.audio.volumes[type] > 200
  ) ||
  !Number.isFinite(SETTINGS.damageMaxWeight) || SETTINGS.damageMaxWeight <= 0 ||
  !Number.isFinite(SETTINGS.damageMinWeight) || SETTINGS.damageMinWeight <= 0 ||
  SETTINGS.damageMinWeight > SETTINGS.damageMaxWeight ||
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
    !isValidAudioSetting(SETTINGS.audio?.rounds?.[String(quiz.round)]) ||
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

const PORT = process.env.PORT || 5000;

let currentAudio = null;
let audioRevision = Date.now();
const audioVolumes = Object.fromEntries(
  ["master", "bgm", "attack", "hit"].map(type => [type, SETTINGS.audio.volumes[type] / 100])
);

const AUDIO_EFFECT_EXTENSIONS = /\.(mp3|ogg|wav|m4a|aac|flac|webm)$/i;
const AUDIO_EFFECTS = Object.fromEntries(["attack", "hit"].map(type => {
  const directory = path.join(__dirname, "public", "assets", "audio", type);
  let files = [];
  try {
    files = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && AUDIO_EFFECT_EXTENSIONS.test(entry.name))
      .map(entry => entry.name);
  } catch (error) {
    console.warn(`Audio effect folder unavailable: ${type}`);
  }
  return [type, files];
}));

function emitRandomAudioEffect(type) {
  const files = AUDIO_EFFECTS[type] || [];
  if (!files.length) return;
  const file = files[Math.floor(Math.random() * files.length)];
  io.emit("audio_effect", { type, file });
}

function setAudio(audioSetting) {
  if (!audioSetting || audioSetting.path === "") return;
  currentAudio = audioSetting.path.toLowerCase() === "none"
    ? { path: "none", loop: false, revision: ++audioRevision }
    : { path: audioSetting.path, loop: audioSetting.loop, revision: ++audioRevision };
  io.emit("audio_change", currentAudio);
}

setAudio(SETTINGS.audio.joining);

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
  answerStats: new Map(),
  roundDamagePlan: null,
  executionRequested: false,
  playerDamage: new Map(),

  // socket.id -> player
  players: new Map()
};

const attackQueue = [];
let attackQueueTimer = null;
let openingAttackPending = true;
let executionTimer = null;
let roundTimer = null;
let roundDeadline = null;

function finishRoundOnTimeout(round) {
  if (!gameState.isStarted || gameState.currentRound !== round) return;
  const stats = gameState.answerStats.get(round);
  for (const player of gameState.players.values()) {
    if (player.answeredRounds.has(round)) continue;
    player.answeredRounds.add(round);
    gameState.answeredPlayers.add(player.id);
    stats?.wrong.push({ nickname: player.nickname, className: player.className, timeout: true });
    const recoveredDamage = gameState.roundDamagePlan?.slots.pop() || 0;
    if (gameState.roundDamagePlan) redistributeDamage(gameState.roundDamagePlan, recoveredDamage);
    io.to(player.id).emit("round_timeout");
  }
  gameState.isStarted = false;
  roundDeadline = null;
  roundTimer = null;
  io.emit("round_timeout", { round });
  broadcastAdminState();
  completeFinalRoundIfReady();
}

function getProjectedHp() {
  const queuedDamage = attackQueue.reduce((sum, attack) => sum + attack.damage, 0);
  return Math.min(
    gameState.maxHp,
    Math.max(0, gameState.currentHp - queuedDamage)
  );
}

function getDamageRanking() {
  return [...gameState.playerDamage.values()]
    .sort((a, b) => b.damage - a.damage)
    .slice(0, 10)
    .map(({ playerId, nickname, className, damage }) => ({ playerId, nickname, className, damage }));
}

function formatDamage(damage) {
  return Number(damage).toLocaleString("ko-KR", {
    maximumFractionDigits: 2
  });
}

function getDamageWeight(rankIndex, participantCount) {
  const N = participantCount - 1;
  if (N <= 0) return SETTINGS.damageMaxWeight;
  return SETTINGS.damageMinWeight +
    (SETTINGS.damageMaxWeight - SETTINGS.damageMinWeight) *
    ((N - rankIndex) / (N + rankIndex));
}

function createRoundDamagePlan(targetHp, participantCount) {
  const totalDamage = Math.max(0, gameState.roundStartingHp - targetHp);
  const weights = Array.from({ length: participantCount }, (_, rankIndex) =>
    getDamageWeight(rankIndex, participantCount)
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  return {
    // 앞 배열부터 정답자에게 배정되고 뒤 배열부터 오답자가 회수합니다.
    slots: weights.map(weight => totalWeight ? totalDamage * weight / totalWeight : 0),
    lastCorrectDamage: null
  };
}

function redistributeDamage(plan, amount) {
  let remaining = amount;
  while (remaining > 0.000001 && plan.slots.length > 0) {
    const count = plan.slots.length;
    const weights = Array.from({ length: count }, (_, rankIndex) =>
      getDamageWeight(rankIndex, count)
    );
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
    let distributed = 0;

    plan.slots.forEach((slot, index) => {
      const share = remaining * weights[index] / weightTotal;
      const capacity = plan.lastCorrectDamage === null
        ? share
        : Math.max(0, plan.lastCorrectDamage - slot);
      const added = Math.min(share, capacity);
      plan.slots[index] += added;
      distributed += added;
    });

    if (distributed <= 0.000001) break;
    remaining -= distributed;
  }
}

function executeFinalBlow() {
  if (
    gameState.gameOver ||
    !gameState.executionRequested ||
    attackQueue.length > 0
  ) {
    return;
  }

  const performers = [...gameState.playerDamage.values()];
  performers.sort((a, b) => b.damage - a.damage);
  const executor = performers[0];

  const finishingDamage = gameState.currentHp;
  setAudio(SETTINGS.audio.execution);
  if (executor) {
    executor.damage += finishingDamage;
    gameState.playerDamage.set(executor.playerId, executor);
  }
  gameState.currentHp = 0;
  gameState.gameOver = true;
  gameState.isStarted = false;
  gameState.executionRequested = false;

  if (executor) {
    emitRandomAudioEffect("attack");
    io.emit("player_execution", {
      playerId: executor.playerId,
      nickname: executor.nickname,
      className: executor.className,
      character: executor.character,
      bossName: gameState.bossName,
      damage: finishingDamage
    });
  }

  emitRandomAudioEffect("hit");
  io.emit("boss_damaged", {
    damage: finishingDamage,
    currentHp: 0,
    maxHp: gameState.maxHp,
    attacker: executor?.nickname,
    playerId: executor?.playerId
  });
  if (executor) io.emit("damage_ranking", getDamageRanking());

  broadcastAdminState();
  executionTimer = setTimeout(() => {
    io.emit("boss_defeated", {
      bossName: gameState.bossName,
      maxHp: gameState.maxHp,
      executor: executor || null
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
    if (gameState.executionRequested) {
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
    io.emit("damage_ranking", getDamageRanking());

    emitRandomAudioEffect("attack");
    io.emit("player_attack", {
      ...attack,
      openingAttack
    });

    emitRandomAudioEffect("hit");
    io.emit("boss_damaged", {
      damage: attack.damage,
      currentHp: attack.currentHp,
      maxHp: attack.maxHp,
      attacker: attack.nickname,
      playerId: attack.playerId
    });
  });

  if (
    gameState.executionRequested &&
    attackQueue.length === 0
  ) {
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
  const answerStats = QUIZZES.map((quiz) => {
    const stats = gameState.answerStats.get(quiz.round) || { correct: [], wrong: [] };
    const totalCount = stats.correct.length + stats.wrong.length;
    return {
      round: quiz.round,
      correctCount: stats.correct.length,
      wrongCount: stats.wrong.length,
      accuracy: totalCount
        ? Math.round(stats.correct.length / totalCount * 100)
        : 0
    };
  });
  return {
    playerCount: gameState.players.size,
    answeredCount: gameState.answeredPlayers.size,
    currentRound: gameState.currentRound,
    isStarted: gameState.isStarted,
    roundDeadline,
    roundCount: QUIZZES.length,
    gameOver: gameState.gameOver,
    finalRoundComplete: gameState.finalRoundComplete,
    executionRequested: gameState.executionRequested,
    answerStats
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
    bossImages: SETTINGS.bossImages,

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
    bossImages: SETTINGS.bossImages,

    currentRound: gameState.currentRound,
    isStarted: gameState.isStarted,
    roundDeadline,
    timeLimitSeconds: SETTINGS.timeLimitSeconds,
    gameOver: gameState.gameOver,

    playerCount: gameState.players.size
  });

  // 현재 접속자 목록도 전달
  socket.emit("players_update", {
    players: createPlayerList(),
    count: gameState.players.size
  });
  socket.emit("admin_state", getAdminState());
  socket.emit("damage_ranking", getDamageRanking());
  if (currentAudio) socket.emit("audio_change", currentAudio);
  socket.emit("audio_volumes", audioVolumes);

  socket.on("set_audio_volume", data => {
    const type = data?.type;
    const volume = Number(data?.volume);
    if (!Object.hasOwn(audioVolumes, type) || !Number.isFinite(volume) || volume < 0 || volume > 2) return;
    audioVolumes[type] = volume;
    io.emit("audio_volumes", audioVolumes);
  });

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
          timeLimitSeconds: SETTINGS.timeLimitSeconds,
          deadline: roundDeadline,
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

    setAudio(SETTINGS.audio.rounds[String(round)]);

    if (roundTimer !== null) clearTimeout(roundTimer);
    roundDeadline = Date.now() + SETTINGS.timeLimitSeconds * 1000;
    roundTimer = setTimeout(() => finishRoundOnTimeout(round), SETTINGS.timeLimitSeconds * 1000);

    gameState.roundStartingHp = getProjectedHp();
    gameState.lastCorrectDamage = 0;
    gameState.roundDamagePlan = createRoundDamagePlan(
      quiz.targetHp,
      gameState.players.size
    );

    gameState.currentRound =
      round;

    gameState.answeredPlayers.clear();
    gameState.answerStats.set(round, { correct: [], wrong: [] });

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
      timeLimitSeconds: SETTINGS.timeLimitSeconds,
      deadline: roundDeadline,
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
    // 라운드당 한 번만 답을 제출할 수 있습니다.
    // ---------------------------------------------

    if (
      player.answeredRounds.has(round)
    ) {

      socket.emit(
        "attack_result",
        {
          success: false,
          msg: "이미 답을 제출했습니다. 이번 라운드에는 다시 고를 수 없습니다."
        }
      );

      return;
    }

    gameState.answeredPlayers.add(player.id);
    player.answeredRounds.add(round);
    const roundStats = gameState.answerStats.get(round);

    // ---------------------------------------------
    // 오답
    // ---------------------------------------------

    if (
      selected !== quiz.answer
    ) {

      roundStats?.wrong.push({ nickname: player.nickname, className: player.className });
      const recoveredDamage = gameState.roundDamagePlan?.slots.pop() || 0;
      if (gameState.roundDamagePlan) {
        redistributeDamage(gameState.roundDamagePlan, recoveredDamage);
      }
      broadcastAdminState();

      socket.emit(
        "attack_result",
        {
          success: false,

          msg:
            "공격 실패! 오답을 제출해 이번 라운드에는 다시 고를 수 없습니다."
        }
      );

      completeFinalRoundIfReady();
      return;
    }

    // ---------------------------------------------
    // 정답
    // ---------------------------------------------

    roundStats?.correct.push({ nickname: player.nickname, className: player.className });
    broadcastAdminState();

    const damage = gameState.roundDamagePlan?.slots.shift() || 0;
    if (gameState.roundDamagePlan) {
      gameState.roundDamagePlan.lastCorrectDamage = damage;
    }
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

  socket.on("execute_final_blow", () => {
    if (
      gameState.gameOver ||
      gameState.executionRequested
    ) {
      return;
    }

    gameState.executionRequested = true;
    gameState.isStarted = false;
    if (roundTimer !== null) {
      clearTimeout(roundTimer);
      roundTimer = null;
    }
    roundDeadline = null;
    if (attackQueue.length === 0) {
      if (attackQueueTimer !== null) {
        clearTimeout(attackQueueTimer);
        attackQueueTimer = null;
      }
      executeFinalBlow();
    }
    broadcastAdminState();
  });

  socket.on("reset_game", () => {

    setAudio(SETTINGS.audio.joining);

    if (roundTimer !== null) {
      clearTimeout(roundTimer);
      roundTimer = null;
    }
    roundDeadline = null;

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
    gameState.executionRequested = false;
    gameState.roundDamagePlan = null;
    gameState.playerDamage.clear();
    io.emit("damage_ranking", []);

    gameState.answeredPlayers.clear();
    gameState.answerStats.clear();

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
