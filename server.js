const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const rooms = {};

io.on('connection', (socket) => {
  console.log(`🟢 Connected: ${socket.id}`);

  socket.on('create-room', ({ roomCode, maxPlayers }) => {
    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        hostId: socket.id,
        players: [],
        questions: [],
        currentIndex: 0,
        answeredPlayers: new Set(),
        timer: null,
        countdownInterval: null,
        quizStarted: false,
        maxPlayers: maxPlayers || 10,
      };
      console.log(`📦 Room ${roomCode} created with max ${rooms[roomCode].maxPlayers} players.`);
    }
    socket.join(roomCode);
    socket.emit('room-created', roomCode);
  });

  socket.on('join-room', ({ name, roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('room-error', { message: 'Room does not exist.' });
      return;
    }

    if (socket.id === room.hostId) return;

    room.players = room.players.filter(p => io.sockets.sockets.get(p.id));

    if (room.players.length >= room.maxPlayers) {
      socket.emit('room-full', { message: 'Room is full.' });
      return;
    }

    const duplicate = room.players.some(p => p.name.toLowerCase().trim() === name.toLowerCase().trim());
    if (duplicate) {
      socket.emit('room-error', { message: 'Name already taken.' });
      return;
    }

    const newPlayer = { id: socket.id, name, score: 0 };
    room.players.push(newPlayer);
    socket.join(roomCode);
    console.log(`👤 ${name} joined room ${roomCode}`);

    io.to(roomCode).emit('lobby-update', {
      players: room.players,
      maxPlayers: room.maxPlayers,
    });
  });

  socket.on('send-multiple-questions', ({ roomCode, questions }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.questions = questions.map(q => ({
      ...q,
      correct: q.correct?.trim() || 'N/A',
    }));
    room.currentIndex = 0;
  });

  socket.on('start-quiz', (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.quizStarted = true;
    startNextQuestion(roomCode);
  });

  socket.on('answer', ({ option, roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    const question = room.questions[room.currentIndex];
    if (!player || !question || room.answeredPlayers.has(socket.id)) return;

    room.answeredPlayers.add(socket.id);

    const isCorrect = option.trim().toLowerCase() === question.correct.trim().toLowerCase();
    if (isCorrect) {
      const now = Date.now();
      const timeTaken = (now - room.questionStartTime) / 1000;
      const timeLeft = question.timeLimit - timeTaken;

      let score = 0;
      if (!room.firstCorrectAnswered) {
        score = 1000;
        room.firstCorrectAnswered = true;
      } else {
        score = Math.floor(500+ (timeLeft / question.timeLimit) * 500);
      }

      player.score += score;
    }

    if (room.answeredPlayers.size === room.players.length) {
      clearTimeout(room.timer);
      clearInterval(room.countdownInterval);

      io.to(roomCode).emit('all-answered', {
        correct: question.correct
      });

      setTimeout(() => {
        endCurrentQuestion(roomCode);
      }, 2500);
    }
  });

  socket.on('kick-player', ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== playerId);
    io.to(roomCode).emit('lobby-update', {
      players: room.players,
      maxPlayers: room.maxPlayers
    });

    io.to(playerId).emit('kicked');
    io.sockets.sockets.get(playerId)?.disconnect(true);
  });

  socket.on('end-quiz', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    clearTimeout(room.timer);
    clearInterval(room.countdownInterval);

    const top5 = [...room.players].sort((a, b) => b.score - a.score).slice(0, 5);
    io.to(roomCode).emit('final-leaderboard', top5);
    io.to(roomCode).emit('quiz-end');

    delete rooms[roomCode];
  });

  socket.on('disconnect', () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      if (!room) continue;

      if (room.hostId === socket.id) {
        console.log(`❌ Host disconnected. Deleting room ${roomCode}`);
        delete rooms[roomCode];
        continue;
      }

      const wasPlayer = room.players.find(p => p.id === socket.id);
      if (wasPlayer) {
        room.players = room.players.filter(p => p.id !== socket.id);
        room.answeredPlayers.delete(socket.id);

        io.to(roomCode).emit('lobby-update', {
          players: room.players,
          maxPlayers: room.maxPlayers
        });
      }
    }

    console.log(`🔴 Disconnected: ${socket.id}`);
  });
});

// Question flow
function startNextQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.currentIndex >= room.questions.length) {
    const sorted = [...room.players].sort((a, b) => b.score - a.score).slice(0, 5);
    io.to(roomCode).emit('final-leaderboard', sorted);
    io.to(roomCode).emit('quiz-end');
    console.log(`🏁 Quiz ended for room ${roomCode}`);
    return;
  }

  const question = room.questions[room.currentIndex];
  room.answeredPlayers = new Set();
  room.firstCorrectAnswered = false;
  room.questionStartTime = Date.now();

  io.to(roomCode).emit('question', question);
  console.log(`🟡 Q${room.currentIndex + 1}: ${question.text}`);

  let timeLeft = question.timeLimit || 15;

  room.countdownInterval = setInterval(() => {
    timeLeft--;
    io.to(roomCode).emit('time-left', timeLeft);
    if (timeLeft <= 0) clearInterval(room.countdownInterval);
  }, 1000);

  room.timer = setTimeout(() => {
    clearInterval(room.countdownInterval);
    io.to(roomCode).emit('all-answered', {
      correct: question.correct || 'N/A'
    });

    setTimeout(() => {
      endCurrentQuestion(roomCode);
    }, 2500);
  }, timeLeft * 1000);
}

function endCurrentQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  io.to(roomCode).emit('question-ended');

  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  io.to(roomCode).emit('leaderboard', sorted);

  room.currentIndex++;
  setTimeout(() => startNextQuestion(roomCode), 5000);
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
