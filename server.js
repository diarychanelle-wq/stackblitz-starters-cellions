const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Game State (Source of Truth)
let players = []; // { id, nickname, atp, lives, status }
let pendingQueue = []; // { playerId, nickname, answer }
let teacherSocketId = null; // Tracks the teacher so only they see secret answers

let currentPrompt = null;
let currentTurnIndex = 0;
let startPlayerIndex = 0;
let turnTimer = null;
let timeLeft = 0;
let questionDuration = 15;
let roundActive = false;

const EXTRA_LIFE_THRESHOLD = 200;

// Curriculum & Question Bank Units
const CURRICULUM = {
  "unit1": {
    name: "Unit 1: Cell Structure & Function",
    questions: [
      { prompt: "What organelle is known as the powerhouse of the cell?", duration: 15 },
      { prompt: "What is the jelly-like fluid that fills a cell called?", duration: 15 },
      { prompt: "Which structure controls what enters and exits the cell?", duration: 20 }
    ]
  },
  "unit2": {
    name: "Unit 2: Cell Energetics & Division",
    questions: [
      { prompt: "During which phase of mitosis do chromosomes line up at the equator?", duration: 20 },
      { prompt: "What molecule stores primary cellular energy?", duration: 15 },
      { prompt: "What pigment absorbs light energy in chloroplasts?", duration: 15 }
    ]
  }
};

function broadcastState() {
  // 1. Safe state for students (strips 'answer' text)
  const sanitizedQueue = pendingQueue.map(item => ({
    playerId: item.playerId,
    nickname: item.nickname
  }));

  const basePayload = {
    players,
    currentPrompt,
    currentTargetId: players[currentTurnIndex]?.id || null,
    timeLeft,
    roundActive
  };

  // Send sanitized state to everyone
  io.emit('state_update', {
    ...basePayload,
    pendingQueue: sanitizedQueue
  });

  // 2. Send full unredacted queue ONLY to the teacher's dashboard
  if (teacherSocketId) {
    io.to(teacherSocketId).emit('teacher_state_update', {
      ...basePayload,
      pendingQueue // Includes actual answer text for grading!
    });
  }
}

function advanceTurn() {
  clearInterval(turnTimer);

  const alivePlayers = players.filter(p => p.lives > 0);
  if (alivePlayers.length <= 1) {
    endGame(alivePlayers[0]);
    return;
  }

  // Move to next alive player
  let attempts = 0;
  do {
    currentTurnIndex = (currentTurnIndex + 1) % players.length;
    attempts++;
  } while (players[currentTurnIndex].lives <= 0 && attempts <= players.length);

  // Check if the hot potato made a full orbit back to the starting player
  if (currentTurnIndex === startPlayerIndex || attempts > players.length) {
    roundActive = false;
    currentPrompt = "Orbit complete! Waiting for teacher to finish grading...";
    broadcastState();
    return;
  }

  startTurnTimer();
  broadcastState(); // Crucial fix: tells the next player it's their turn!
}

function startTurnTimer() {
  if (!roundActive) return;
  if (turnTimer) clearInterval(turnTimer);

  timeLeft = questionDuration;

  turnTimer = setInterval(() => {
    if (!roundActive) {
      clearInterval(turnTimer);
      return;
    }

    timeLeft--;

    if (timeLeft <= 0) {
      // Time ran out! Penalize active player and pass the hot potato
      const timedOutPlayer = players[currentTurnIndex];
      if (timedOutPlayer) {
        timedOutPlayer.lives = Math.max(0, timedOutPlayer.lives - 1);
        timedOutPlayer.status = 'timed out (-1 life)';
      }
      advanceTurn();
    } else {
      broadcastState(); // Updates live countdown on screens
    }
  }, 1000); // Ticks every 1 second for accurate countdowns
}

function endGame(winner) {
  clearInterval(turnTimer);
  roundActive = false;
  timeLeft = 0;
  
  currentPrompt = winner 
    ? `🎉 Winner! ${winner.nickname} is the last cell standing!` 
    : `Round over! All cells perished.`;
  
  if (winner) {
    winner.atp += 150;
  }
  
  broadcastState();
}

io.on('connection', (socket) => {
  // 0. Register Teacher Dashboard
  socket.on('register_teacher', () => {
    teacherSocketId = socket.id;
    broadcastState();
  });

  // 1. Join Game (Capped at 30 Players for a real classroom!)
  socket.on('join_game', (nickname) => {
    if (players.length >= 30) {
      socket.emit('error_msg', 'Petri dish is full (30/30 players)!');
      return;
    }
    players.push({
      id: socket.id,
      nickname: nickname || `Cell_${players.length + 1}`,
      atp: 0,
      lives: 3,
      status: 'waiting'
    });
    broadcastState();
  });

  // 2. Teacher Starts New Round
  socket.on('start_round', ({ unitKey, promptIndex, customPrompt, duration }) => {
    const alivePlayers = players.filter(p => p.lives > 0);
    if (alivePlayers.length === 0) return;

    if (pendingQueue.length > 0) {
      socket.emit('error_msg', 'Finish grading pending answers first!');
      return;
    }

    if (unitKey && CURRICULUM[unitKey] && promptIndex !== undefined) {
      const selectedQ = CURRICULUM[unitKey].questions[promptIndex];
      currentPrompt = selectedQ.prompt;
      questionDuration = selectedQ.duration;
    } else {
      currentPrompt = customPrompt || "Quick cell review!";
      questionDuration = parseInt(duration) || 15;
    }

    // Find the first ALIVE player to start the round (fixes dead-player start bug)
    const firstAliveIdx = players.findIndex(p => p.lives > 0);
    startPlayerIndex = firstAliveIdx !== -1 ? firstAliveIdx : 0;
    currentTurnIndex = startPlayerIndex;
    roundActive = true;

    players.forEach(p => { if (p.lives > 0) p.status = 'waiting'; });
    startTurnTimer();
    broadcastState();
  });

  // 3. Player Submits Answer -> Goes to Secret Pending Queue
  socket.on('submit_answer', (answerText) => {
    if (!roundActive) return;
    const activePlayer = players[currentTurnIndex];
    if (!activePlayer || activePlayer.id !== socket.id) return;

    activePlayer.status = 'pending';
    pendingQueue.push({
      playerId: activePlayer.id,
      nickname: activePlayer.nickname,
      answer: answerText
    });

    advanceTurn();
  });

  // 4. Teacher Grades Pending Answer
  socket.on('grade_answer', ({ playerId, gradeType }) => {
    const queueIdx = pendingQueue.findIndex(item => item.playerId === playerId);
    if (queueIdx === -1) return;

    const player = players.find(p => p.id === playerId);
    pendingQueue.splice(queueIdx, 1);

    if (player) {
      if (gradeType === 'WRONG') {
        player.lives = Math.max(0, player.lives - 1);
        player.status = 'wrong';
      } else {
        const atpAward = parseInt(gradeType) || 25; 
        const prevThreshold = Math.floor(player.atp / EXTRA_LIFE_THRESHOLD);
        player.atp += atpAward;
        const newThreshold = Math.floor(player.atp / EXTRA_LIFE_THRESHOLD);

        if (newThreshold > prevThreshold) {
          player.lives++;
        }
        player.status = `graded (+${atpAward} ATP)`;
      }
    }

    const alivePlayers = players.filter(p => p.lives > 0);
    if (alivePlayers.length <= 1) {
      endGame(alivePlayers[0]);
      return;
    }

    if (!roundActive && pendingQueue.length === 0) {
      currentPrompt = "All graded! Ready for next prompt.";
    }

    broadcastState();
  });

  // 5. Reset Game Handler
  socket.on('reset_game', () => {
    if (turnTimer) clearInterval(turnTimer);

    players.forEach(p => {
      p.lives = 3;
      p.atp = 0; // Also resets ATP for a fresh game
      p.status = 'waiting';
    });

    pendingQueue = [];
    roundActive = false;
    timeLeft = 0;
    currentTurnIndex = 0;
    startPlayerIndex = 0;
    currentPrompt = "Game reset! Teacher can select a unit and start.";

    broadcastState();
  });

  // Handle Disconnect Safely
  socket.on('disconnect', () => {
    if (socket.id === teacherSocketId) {
      teacherSocketId = null;
      return;
    }

    const disconnectedIdx = players.findIndex(p => p.id === socket.id);
    if (disconnectedIdx === -1) return;

    const wasActivePlayer = (disconnectedIdx === currentTurnIndex);
    players.splice(disconnectedIdx, 1);

    // Keep indexes aligned if someone earlier in the list left
    if (disconnectedIdx < currentTurnIndex) {
      currentTurnIndex = Math.max(0, currentTurnIndex - 1);
    }
    if (disconnectedIdx < startPlayerIndex) {
      startPlayerIndex = Math.max(0, startPlayerIndex - 1);
    }

    const alivePlayers = players.filter(p => p.lives > 0);
    if (roundActive && alivePlayers.length <= 1) {
      endGame(alivePlayers[0]);
    } else if (roundActive && wasActivePlayer) {
      // Adjust index back by 1 so advanceTurn() lands on the right next person
      currentTurnIndex = (currentTurnIndex - 1 + players.length) % players.length;
      advanceTurn();
    } else {
      broadcastState();
    }
  });
});

// Uses Glitch's dynamic port automatically, or 3003 locally
server.listen(3003, () => {
  console.log('Cellion prototype running at http://localhost:3003');
});

