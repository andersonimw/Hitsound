
// Previne crash por erros não tratados
process.on('uncaughtException', function(err) {
  console.error('[CRASH EVITADO] uncaughtException:', err.message);
});
process.on('unhandledRejection', function(reason) {
  console.error('[CRASH EVITADO] unhandledRejection:', reason);
});
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

// Conectar ao MongoDB
mongoose.connect(process.env.MONGODB_URI).then(() => {
  console.log('MongoDB conectado!');
}).catch(e => console.log('Erro MongoDB:', e.message));

// Schema do ranking
const playSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  count: { type: Number, default: 0 },
  month: String
});
const Play = mongoose.model('Play', playSchema);

// Schema de usuário
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  userName: { type: String, unique: true, lowercase: true, trim: true },
  displayName: String,
  photo: String,
  friends: [String],
  friendRequests: [String],
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Salas de sessão ao vivo
// Schema para salas de sessao ao vivo
const jamRoomSchema = new mongoose.Schema({
  roomId: { type: String, unique: true },
  hostName: String,
  currentTrack: mongoose.Schema.Types.Mixed,
  queue: { type: Array, default: [] },
  updatedAt: { type: Date, default: Date.now }
});
const JamRoom = mongoose.model('JamRoom', jamRoomSchema);

const jamRooms = {};

io.on('connection', function(socket) {
  // Criar sala
  socket.on('jam:create', async function(data) {
    const roomId = Math.random().toString(36).substr(2,6).toUpperCase();
    jamRooms[roomId] = {
      host: socket.id,
      hostName: data.userName || 'Anonimo',
      users: [{ id: socket.id, name: data.userName || 'Anonimo' }],
      currentTrack: null,
      queue: []
    };
    socket.join(roomId);
    socket.emit('jam:created', { roomId });
    try { await JamRoom.create({ roomId, hostName: data.userName||'Anonimo', queue: [], currentTrack: null }); } catch(e) {}
    console.log('[JAM] Sala criada:', roomId);
  });

  // Entrar na sala
  socket.on('jam:join', async function(data) {
    var room = jamRooms[data.roomId];
    if (!room) {
      try {
        var dbRoom = await JamRoom.findOne({ roomId: data.roomId });
        if (dbRoom) {
          jamRooms[data.roomId] = {
            host: socket.id,
            hostName: dbRoom.hostName,
            users: [],
            currentTrack: dbRoom.currentTrack||null,
            queue: dbRoom.queue||[]
          };
          room = jamRooms[data.roomId];
        }
      } catch(e) {}
    }
    if (!room) { socket.emit('jam:error', { msg: 'Sala nao encontrada.' }); return; }
    if (room.users.length >= 5) { socket.emit('jam:error', { msg: 'Sala cheia (max. 5).' }); return; }
    room.users.push({ id: socket.id, name: data.userName || 'Anonimo' });
    socket.join(data.roomId);
    socket.emit('jam:joined', { roomId: data.roomId, room });
    io.to(data.roomId).emit('jam:users', { users: room.users });
    if (room.currentTrack) socket.emit('jam:sync', { track: room.currentTrack });
    if (room.queue && room.queue.length) socket.emit('jam:queue-update', { queue: room.queue });
    if (room.queue && room.queue.length) socket.emit('jam:queue-update', { queue: room.queue });
    console.log('[JAM] Usuario entrou:', data.roomId);
  });

  // Tocar música
  socket.on('jam:play', async function(data) {
    const room = jamRooms[data.roomId];
    if (!room) return;
    room.currentTrack = data.track;
    io.to(data.roomId).emit('jam:sync', { track: data.track });
    try { await JamRoom.findOneAndUpdate({ roomId: data.roomId }, { currentTrack: data.track, updatedAt: new Date() }); } catch(e) {}
  });

  // Adicionar à fila
  socket.on('jam:queue', async function(data) {
    const room = jamRooms[data.roomId];
    if (!room) return;
    room.queue.push(data.track);
    io.to(data.roomId).emit('jam:queue-update', { queue: room.queue });
    try { await JamRoom.findOneAndUpdate({ roomId: data.roomId }, { queue: room.queue, updatedAt: new Date() }); } catch(e) {}
  });

  // Desconectar
  socket.on('disconnect', async function() {
    for (var roomId in jamRooms) {
      var room = jamRooms[roomId];
      room.users = room.users.filter(function(u) { return u.id !== socket.id; });
      if (room.users.length === 0) {
        delete jamRooms[roomId];
        // NAO apaga do MongoDB — sala persiste para reconexao
        console.log('[JAM] Sala vazia em memoria (persiste no MongoDB):', roomId);
      } else {
        io.to(roomId).emit('jam:users', { users: room.users });
      }
    }
  });

  // Reconexao explicita — usuario volta para sala salva no localStorage
  socket.on('jam:reconnect', async function(data) {
    if (!data.roomId) return;
    var room = jamRooms[data.roomId];
    if (!room) {
      try {
        var dbRoom = await JamRoom.findOne({ roomId: data.roomId });
        if (dbRoom) {
          jamRooms[data.roomId] = {
            host: socket.id,
            hostName: dbRoom.hostName,
            users: [],
            currentTrack: dbRoom.currentTrack || null,
            queue: dbRoom.queue || []
          };
          room = jamRooms[data.roomId];
        }
      } catch(e) {}
    }
    if (!room) {
      socket.emit('jam:error', { msg: 'Sala nao encontrada. Sessao encerrada.' });
      return;
    }
    var userName = data.userName || 'Anonimo';
    var jaEsta = room.users.find(function(u) { return u.name === userName; });
    if (!jaEsta) {
      if (room.users.length >= 5) { socket.emit('jam:error', { msg: 'Sala cheia (max. 5).' }); return; }
      room.users.push({ id: socket.id, name: userName });
    } else {
      jaEsta.id = socket.id;
    }
    socket.join(data.roomId);
    socket.emit('jam:joined', { roomId: data.roomId, room });
    io.to(data.roomId).emit('jam:users', { users: room.users });
    if (room.currentTrack) socket.emit('jam:sync', { track: room.currentTrack });
    if (room.queue && room.queue.length) socket.emit('jam:queue-update', { queue: room.queue });
    console.log('[JAM] Reconexao:', data.roomId, userName);
  });

// Limpar salas antigas do MongoDB (mais de 24h sem atividade)
setInterval(async function() {
  try {
    var ontem = new Date(Date.now() - 24*60*60*1000);
    await JamRoom.deleteMany({ updatedAt: { $lt: ontem } });
  } catch(e) {}
}, 60*60*1000);
});
const PORT = process.env.PORT || 3000;
const LASTFM_KEY = process.env.LASTFM_API_KEY || "";

const ytCacheSchema = new mongoose.Schema({
  query: { type: String, index: true, unique: true },
  ytId: String,
  thumb: String,
  title: String,
  cachedAt: { type: Date, default: Date.now, expires: 604800 }
});
const YtCache = mongoose.models.YtCache || mongoose.model('YtCache', ytCacheSchema);

const genreCacheSchema = new mongoose.Schema({
  genre: { type: String, index: true, unique: true },
  items: [{ name: String, artist: String, ytId: String, thumb: String }],
  cachedAt: { type: Date, default: Date.now, expires: 604800 }
});
const GenreCache = mongoose.models.GenreCache || mongoose.model('GenreCache', genreCacheSchema);

const YT_KEYS = [
  process.env.YOUTUBE_API_KEY,
  process.env.YOUTUBE_API_KEY2,
  process.env.YOUTUBE_API_KEY3,
  process.env.YOUTUBE_API_KEY4,
  process.env.YOUTUBE_API_KEY5,
  process.env.YOUTUBE_API_KEY6,
  process.env.YOUTUBE_API_KEY7,
  process.env.YOUTUBE_API_KEY8,
  process.env.YOUTUBE_API_KEY9,
  process.env.YOUTUBE_API_KEY10,
  process.env.YOUTUBE_API_KEY11,
  process.env.YOUTUBE_API_KEY12,
  process.env.YOUTUBE_API_KEY13,
  process.env.YOUTUBE_API_KEY14,
  process.env.YOUTUBE_API_KEY15,
  process.env.YOUTUBE_API_KEY16,
  process.env.YOUTUBE_API_KEY17,
  process.env.YOUTUBE_API_KEY18,
  process.env.YOUTUBE_API_KEY19,
  process.env.YOUTUBE_API_KEY20,
  process.env.YOUTUBE_API_KEY21,
  process.env.YOUTUBE_API_KEY22,
  process.env.YOUTUBE_API_KEY23,
  process.env.YOUTUBE_API_KEY24,
  process.env.YOUTUBE_API_KEY25,
  process.env.YOUTUBE_API_KEY26,
  process.env.YOUTUBE_API_KEY27,
  process.env.YOUTUBE_API_KEY28,
  process.env.YOUTUBE_API_KEY29,
  process.env.YOUTUBE_API_KEY30,
  process.env.YOUTUBE_API_KEY31,
  process.env.YOUTUBE_API_KEY32,
  process.env.YOUTUBE_API_KEY33,
  process.env.YOUTUBE_API_KEY34,
  process.env.YOUTUBE_API_KEY35,
  process.env.YOUTUBE_API_KEY36,
  process.env.YOUTUBE_API_KEY37,
  process.env.YOUTUBE_API_KEY38,
  process.env.YOUTUBE_API_KEY39,
  process.env.YOUTUBE_API_KEY40,
  process.env.YOUTUBE_API_KEY41,
  process.env.YOUTUBE_API_KEY42,
  process.env.YOUTUBE_API_KEY43,
  process.env.YOUTUBE_API_KEY44,
  process.env.YOUTUBE_API_KEY45,
  process.env.YOUTUBE_API_KEY46,
  process.env.YOUTUBE_API_KEY47,
  process.env.YOUTUBE_API_KEY48,
  process.env.YOUTUBE_API_KEY49,
  process.env.YOUTUBE_API_KEY50,
  process.env.YOUTUBE_API_KEY51,
  process.env.YOUTUBE_API_KEY52,
  process.env.YOUTUBE_API_KEY53,
  process.env.YOUTUBE_API_KEY54,
  process.env.YOUTUBE_API_KEY55,
  process.env.YOUTUBE_API_KEY56,
  process.env.YOUTUBE_API_KEY57,
  process.env.YOUTUBE_API_KEY58,
  process.env.YOUTUBE_API_KEY59,
  process.env.YOUTUBE_API_KEY60,
  process.env.YOUTUBE_API_KEY61,
  process.env.YOUTUBE_API_KEY62,
  process.env.YOUTUBE_API_KEY63,
  process.env.YOUTUBE_API_KEY64,
  process.env.YOUTUBE_API_KEY65,
  process.env.YOUTUBE_API_KEY66,
  process.env.YOUTUBE_API_KEY67,
  process.env.YOUTUBE_API_KEY68,
  process.env.YOUTUBE_API_KEY69,
  process.env.YOUTUBE_API_KEY70,
  process.env.YOUTUBE_API_KEY71,
  process.env.YOUTUBE_API_KEY72,
  process.env.YOUTUBE_API_KEY73,
  process.env.YOUTUBE_API_KEY74,
  process.env.YOUTUBE_API_KEY75,
  process.env.YOUTUBE_API_KEY76,
  process.env.YOUTUBE_API_KEY77,
  process.env.YOUTUBE_API_KEY78,
  process.env.YOUTUBE_API_KEY79,
  process.env.YOUTUBE_API_KEY80,
  process.env.YOUTUBE_API_KEY81,
  process.env.YOUTUBE_API_KEY82,
  process.env.YOUTUBE_API_KEY83,
  process.env.YOUTUBE_API_KEY84,
  process.env.YOUTUBE_API_KEY85,
  process.env.YOUTUBE_API_KEY86,
  process.env.YOUTUBE_API_KEY87,
  process.env.YOUTUBE_API_KEY88,
  process.env.YOUTUBE_API_KEY89,
  process.env.YOUTUBE_API_KEY90,
  process.env.YOUTUBE_API_KEY91,
  process.env.YOUTUBE_API_KEY92,
  process.env.YOUTUBE_API_KEY93,
  process.env.YOUTUBE_API_KEY94,
  process.env.YOUTUBE_API_KEY95,
  process.env.YOUTUBE_API_KEY96,
  process.env.YOUTUBE_API_KEY97,
  process.env.YOUTUBE_API_KEY98,
  process.env.YOUTUBE_API_KEY99,
  process.env.YOUTUBE_API_KEY100,
  process.env.YOUTUBE_API_KEY101,
  process.env.YOUTUBE_API_KEY102,
  process.env.YOUTUBE_API_KEY103,
  process.env.YOUTUBE_API_KEY104,
  process.env.YOUTUBE_API_KEY105,
  process.env.YOUTUBE_API_KEY106,
  process.env.YOUTUBE_API_KEY107,
  process.env.YOUTUBE_API_KEY108,
  process.env.YOUTUBE_API_KEY109,
  process.env.YOUTUBE_API_KEY110,
  process.env.YOUTUBE_API_KEY111,
  process.env.YOUTUBE_API_KEY112,
  process.env.YOUTUBE_API_KEY113,
  process.env.YOUTUBE_API_KEY114,
  process.env.YOUTUBE_API_KEY115,
  process.env.YOUTUBE_API_KEY116,
  process.env.YOUTUBE_API_KEY117,
  process.env.YOUTUBE_API_KEY118,
  process.env.YOUTUBE_API_KEY119,
  process.env.YOUTUBE_API_KEY120,
  process.env.YOUTUBE_API_KEY121,
  process.env.YOUTUBE_API_KEY122,
  process.env.YOUTUBE_API_KEY123,
  process.env.YOUTUBE_API_KEY124,
  process.env.YOUTUBE_API_KEY125,
  process.env.YOUTUBE_API_KEY126,
  process.env.YOUTUBE_API_KEY127,
  process.env.YOUTUBE_API_KEY128,
  process.env.YOUTUBE_API_KEY129,
  process.env.YOUTUBE_API_KEY130,
  process.env.YOUTUBE_API_KEY131,
  process.env.YOUTUBE_API_KEY132,
  process.env.YOUTUBE_API_KEY133,
  process.env.YOUTUBE_API_KEY134,
  process.env.YOUTUBE_API_KEY135,
  process.env.YOUTUBE_API_KEY136,
  process.env.YOUTUBE_API_KEY137,
  process.env.YOUTUBE_API_KEY138,
  process.env.YOUTUBE_API_KEY139,
  process.env.YOUTUBE_API_KEY140,
  process.env.YOUTUBE_API_KEY141,
  process.env.YOUTUBE_API_KEY142,
  process.env.YOUTUBE_API_KEY143,
  process.env.YOUTUBE_API_KEY144,
  process.env.YOUTUBE_API_KEY145,
  process.env.YOUTUBE_API_KEY146,
  process.env.YOUTUBE_API_KEY147,
  process.env.YOUTUBE_API_KEY148,
  process.env.YOUTUBE_API_KEY149,
  process.env.YOUTUBE_API_KEY150,
  process.env.YOUTUBE_API_KEY151,
  process.env.YOUTUBE_API_KEY152,
  process.env.YOUTUBE_API_KEY153,
  process.env.YOUTUBE_API_KEY154,
  process.env.YOUTUBE_API_KEY155,
  process.env.YOUTUBE_API_KEY156,
  process.env.YOUTUBE_API_KEY157,
  process.env.YOUTUBE_API_KEY158,
  process.env.YOUTUBE_API_KEY159,
  process.env.YOUTUBE_API_KEY160,
  process.env.YOUTUBE_API_KEY161,
  process.env.YOUTUBE_API_KEY162,
  process.env.YOUTUBE_API_KEY163,
  process.env.YOUTUBE_API_KEY164,
  process.env.YOUTUBE_API_KEY165,
  process.env.YOUTUBE_API_KEY166,
  process.env.YOUTUBE_API_KEY167,
  process.env.YOUTUBE_API_KEY168,
  process.env.YOUTUBE_API_KEY169,
  process.env.YOUTUBE_API_KEY170,
  process.env.YOUTUBE_API_KEY171,
  process.env.YOUTUBE_API_KEY172,
  process.env.YOUTUBE_API_KEY173,
  process.env.YOUTUBE_API_KEY174,
  process.env.YOUTUBE_API_KEY175,
  process.env.YOUTUBE_API_KEY176,
  process.env.YOUTUBE_API_KEY177,
  process.env.YOUTUBE_API_KEY178,
  process.env.YOUTUBE_API_KEY179,
  process.env.YOUTUBE_API_KEY180,
  process.env.YOUTUBE_API_KEY181,
  process.env.YOUTUBE_API_KEY182,
  process.env.YOUTUBE_API_KEY183,
  process.env.YOUTUBE_API_KEY184,
  process.env.YOUTUBE_API_KEY185,
  process.env.YOUTUBE_API_KEY186,
  process.env.YOUTUBE_API_KEY187,
  process.env.YOUTUBE_API_KEY188,
  process.env.YOUTUBE_API_KEY189,
  process.env.YOUTUBE_API_KEY190,
  process.env.YOUTUBE_API_KEY191,
  process.env.YOUTUBE_API_KEY192,
  process.env.YOUTUBE_API_KEY193,
  process.env.YOUTUBE_API_KEY194,
  process.env.YOUTUBE_API_KEY195,
  process.env.YOUTUBE_API_KEY196,
  process.env.YOUTUBE_API_KEY197,
  process.env.YOUTUBE_API_KEY198,
  process.env.YOUTUBE_API_KEY199,
  process.env.YOUTUBE_API_KEY200,
  process.env.YOUTUBE_API_KEY201,
  process.env.YOUTUBE_API_KEY202,
  process.env.YOUTUBE_API_KEY203,
  process.env.YOUTUBE_API_KEY204,
  process.env.YOUTUBE_API_KEY205,
  process.env.YOUTUBE_API_KEY206,
  process.env.YOUTUBE_API_KEY207,
  process.env.YOUTUBE_API_KEY208,
  process.env.YOUTUBE_API_KEY209,
  process.env.YOUTUBE_API_KEY210,
  process.env.YOUTUBE_API_KEY211,
  process.env.YOUTUBE_API_KEY212,
  process.env.YOUTUBE_API_KEY213,
  process.env.YOUTUBE_API_KEY214,
  process.env.YOUTUBE_API_KEY215,
  process.env.YOUTUBE_API_KEY216,
  process.env.YOUTUBE_API_KEY217,
  process.env.YOUTUBE_API_KEY218,
  process.env.YOUTUBE_API_KEY219,
  process.env.YOUTUBE_API_KEY220,
  process.env.YOUTUBE_API_KEY221,
  process.env.YOUTUBE_API_KEY222,
  process.env.YOUTUBE_API_KEY223,
  process.env.YOUTUBE_API_KEY224,
  process.env.YOUTUBE_API_KEY225,
  process.env.YOUTUBE_API_KEY226,
  process.env.YOUTUBE_API_KEY227,
  process.env.YOUTUBE_API_KEY228,
  process.env.YOUTUBE_API_KEY229,
  process.env.YOUTUBE_API_KEY230,
  process.env.YOUTUBE_API_KEY231,
  process.env.YOUTUBE_API_KEY232,
  process.env.YOUTUBE_API_KEY233,
  process.env.YOUTUBE_API_KEY234,
  process.env.YOUTUBE_API_KEY235,
  process.env.YOUTUBE_API_KEY236,
  process.env.YOUTUBE_API_KEY237,
  process.env.YOUTUBE_API_KEY238,
  process.env.YOUTUBE_API_KEY239,
  process.env.YOUTUBE_API_KEY240,
  process.env.YOUTUBE_API_KEY241,
  process.env.YOUTUBE_API_KEY242,
  process.env.YOUTUBE_API_KEY243,
  process.env.YOUTUBE_API_KEY244,
  process.env.YOUTUBE_API_KEY245,
  process.env.YOUTUBE_API_KEY246,
  process.env.YOUTUBE_API_KEY247,
  process.env.YOUTUBE_API_KEY248,
  process.env.YOUTUBE_API_KEY249,
  process.env.YOUTUBE_API_KEY250,
  process.env.YOUTUBE_API_KEY251,
  process.env.YOUTUBE_API_KEY252,
  process.env.YOUTUBE_API_KEY253,
  process.env.YOUTUBE_API_KEY254,
  process.env.YOUTUBE_API_KEY255,
  process.env.YOUTUBE_API_KEY256,
  process.env.YOUTUBE_API_KEY257,
  process.env.YOUTUBE_API_KEY258,
  process.env.YOUTUBE_API_KEY259,
  process.env.YOUTUBE_API_KEY260,
  process.env.YOUTUBE_API_KEY261,
  process.env.YOUTUBE_API_KEY262,
  process.env.YOUTUBE_API_KEY263,
  process.env.YOUTUBE_API_KEY264,
  process.env.YOUTUBE_API_KEY265,
  process.env.YOUTUBE_API_KEY266,
  process.env.YOUTUBE_API_KEY267,
  process.env.YOUTUBE_API_KEY268,
  process.env.YOUTUBE_API_KEY269,
  process.env.YOUTUBE_API_KEY270,
  process.env.YOUTUBE_API_KEY271,
  process.env.YOUTUBE_API_KEY272,
  process.env.YOUTUBE_API_KEY273,
  process.env.YOUTUBE_API_KEY274,
  process.env.YOUTUBE_API_KEY275,
  process.env.YOUTUBE_API_KEY276,
  process.env.YOUTUBE_API_KEY277,
  process.env.YOUTUBE_API_KEY278,
  process.env.YOUTUBE_API_KEY279,
  process.env.YOUTUBE_API_KEY280,
  process.env.YOUTUBE_API_KEY281,
  process.env.YOUTUBE_API_KEY282,
  process.env.YOUTUBE_API_KEY283,
  process.env.YOUTUBE_API_KEY284,
  process.env.YOUTUBE_API_KEY285,
  process.env.YOUTUBE_API_KEY286,
  process.env.YOUTUBE_API_KEY287,
  process.env.YOUTUBE_API_KEY288,
  process.env.YOUTUBE_API_KEY289,
  process.env.YOUTUBE_API_KEY290,
  process.env.YOUTUBE_API_KEY291,
  process.env.YOUTUBE_API_KEY292,
  process.env.YOUTUBE_API_KEY293,
  process.env.YOUTUBE_API_KEY294,
  process.env.YOUTUBE_API_KEY295,
  process.env.YOUTUBE_API_KEY296,
  process.env.YOUTUBE_API_KEY297,
  process.env.YOUTUBE_API_KEY298,
  process.env.YOUTUBE_API_KEY299,
  process.env.YOUTUBE_API_KEY300,
  process.env.YOUTUBE_API_KEY301,
  process.env.YOUTUBE_API_KEY302,
  process.env.YOUTUBE_API_KEY303,
  process.env.YOUTUBE_API_KEY304,
  process.env.YOUTUBE_API_KEY305,
  process.env.YOUTUBE_API_KEY306,
  process.env.YOUTUBE_API_KEY307,
  process.env.YOUTUBE_API_KEY308,
  process.env.YOUTUBE_API_KEY309,
  process.env.YOUTUBE_API_KEY310,
  process.env.YOUTUBE_API_KEY311,
  process.env.YOUTUBE_API_KEY312,
  process.env.YOUTUBE_API_KEY313,
  process.env.YOUTUBE_API_KEY314,
  process.env.YOUTUBE_API_KEY315,
  process.env.YOUTUBE_API_KEY316,
  process.env.YOUTUBE_API_KEY317,
  process.env.YOUTUBE_API_KEY318,
  process.env.YOUTUBE_API_KEY319,
  process.env.YOUTUBE_API_KEY320,
  process.env.YOUTUBE_API_KEY321,
  process.env.YOUTUBE_API_KEY322,
  process.env.YOUTUBE_API_KEY323,
  process.env.YOUTUBE_API_KEY324,
  process.env.YOUTUBE_API_KEY325,
  process.env.YOUTUBE_API_KEY326,
  process.env.YOUTUBE_API_KEY327,
  process.env.YOUTUBE_API_KEY328,
  process.env.YOUTUBE_API_KEY329,
  process.env.YOUTUBE_API_KEY330,
  process.env.YOUTUBE_API_KEY331,
  process.env.YOUTUBE_API_KEY332,
  process.env.YOUTUBE_API_KEY333,
  process.env.YOUTUBE_API_KEY334,
  process.env.YOUTUBE_API_KEY335,
  process.env.YOUTUBE_API_KEY336,
  process.env.YOUTUBE_API_KEY337,
  process.env.YOUTUBE_API_KEY338,
  process.env.YOUTUBE_API_KEY339,
  process.env.YOUTUBE_API_KEY340,
  process.env.YOUTUBE_API_KEY341,
  process.env.YOUTUBE_API_KEY342,
  process.env.YOUTUBE_API_KEY343,
  process.env.YOUTUBE_API_KEY344,
  process.env.YOUTUBE_API_KEY345,
  process.env.YOUTUBE_API_KEY346,
  process.env.YOUTUBE_API_KEY347,
  process.env.YOUTUBE_API_KEY348,
  process.env.YOUTUBE_API_KEY349,
  process.env.YOUTUBE_API_KEY350,
  process.env.YOUTUBE_API_KEY351,
  process.env.YOUTUBE_API_KEY352,
  process.env.YOUTUBE_API_KEY353,
  process.env.YOUTUBE_API_KEY354,
  process.env.YOUTUBE_API_KEY355,
  process.env.YOUTUBE_API_KEY356,
  process.env.YOUTUBE_API_KEY357,
  process.env.YOUTUBE_API_KEY358,
  process.env.YOUTUBE_API_KEY359,
  process.env.YOUTUBE_API_KEY360,
  process.env.YOUTUBE_API_KEY361,
  process.env.YOUTUBE_API_KEY362,
  process.env.YOUTUBE_API_KEY363,
  process.env.YOUTUBE_API_KEY364,
  process.env.YOUTUBE_API_KEY365,
  process.env.YOUTUBE_API_KEY366,
  process.env.YOUTUBE_API_KEY367,
  process.env.YOUTUBE_API_KEY368,
  process.env.YOUTUBE_API_KEY369,
  process.env.YOUTUBE_API_KEY370,
  process.env.YOUTUBE_API_KEY371,
  process.env.YOUTUBE_API_KEY372,
  process.env.YOUTUBE_API_KEY373,
  process.env.YOUTUBE_API_KEY374,
  process.env.YOUTUBE_API_KEY375,
  process.env.YOUTUBE_API_KEY376,
  process.env.YOUTUBE_API_KEY377,
  process.env.YOUTUBE_API_KEY378,
  process.env.YOUTUBE_API_KEY379,
  process.env.YOUTUBE_API_KEY380,
  process.env.YOUTUBE_API_KEY381,
  process.env.YOUTUBE_API_KEY382,
  process.env.YOUTUBE_API_KEY383,
  process.env.YOUTUBE_API_KEY384,
  process.env.YOUTUBE_API_KEY385,
  process.env.YOUTUBE_API_KEY386,
  process.env.YOUTUBE_API_KEY387,
  process.env.YOUTUBE_API_KEY388,
  process.env.YOUTUBE_API_KEY389,
  process.env.YOUTUBE_API_KEY390,
  process.env.YOUTUBE_API_KEY391,
  process.env.YOUTUBE_API_KEY392,
  process.env.YOUTUBE_API_KEY393,
  process.env.YOUTUBE_API_KEY394,
  process.env.YOUTUBE_API_KEY395,
  process.env.YOUTUBE_API_KEY396,
  process.env.YOUTUBE_API_KEY397,
  process.env.YOUTUBE_API_KEY398,
  process.env.YOUTUBE_API_KEY399,
  process.env.YOUTUBE_API_KEY400,
  process.env.YOUTUBE_API_KEY401,
  process.env.YOUTUBE_API_KEY402,
  process.env.YOUTUBE_API_KEY403,
  process.env.YOUTUBE_API_KEY404,
  process.env.YOUTUBE_API_KEY405,
  process.env.YOUTUBE_API_KEY406,
  process.env.YOUTUBE_API_KEY407,
  process.env.YOUTUBE_API_KEY408,
  process.env.YOUTUBE_API_KEY409,
  process.env.YOUTUBE_API_KEY410,
  process.env.YOUTUBE_API_KEY411,
  process.env.YOUTUBE_API_KEY412,
  process.env.YOUTUBE_API_KEY413,
  process.env.YOUTUBE_API_KEY414,
  process.env.YOUTUBE_API_KEY415,
  process.env.YOUTUBE_API_KEY416,
  process.env.YOUTUBE_API_KEY417,
  process.env.YOUTUBE_API_KEY418,
  process.env.YOUTUBE_API_KEY419,
  process.env.YOUTUBE_API_KEY420,
  process.env.YOUTUBE_API_KEY421,
  process.env.YOUTUBE_API_KEY422,
  process.env.YOUTUBE_API_KEY423,
  process.env.YOUTUBE_API_KEY424,
  process.env.YOUTUBE_API_KEY425,
  process.env.YOUTUBE_API_KEY426,
  process.env.YOUTUBE_API_KEY427,
  process.env.YOUTUBE_API_KEY428,
  process.env.YOUTUBE_API_KEY429,
  process.env.YOUTUBE_API_KEY430,
  process.env.YOUTUBE_API_KEY431,
  process.env.YOUTUBE_API_KEY432,
  process.env.YOUTUBE_API_KEY433,
  process.env.YOUTUBE_API_KEY434,
  process.env.YOUTUBE_API_KEY435,
  process.env.YOUTUBE_API_KEY436,
  process.env.YOUTUBE_API_KEY437,
  process.env.YOUTUBE_API_KEY438,
  process.env.YOUTUBE_API_KEY439,
  process.env.YOUTUBE_API_KEY440,
  process.env.YOUTUBE_API_KEY441,
  process.env.YOUTUBE_API_KEY442,
  process.env.YOUTUBE_API_KEY443,
  process.env.YOUTUBE_API_KEY444,
  process.env.YOUTUBE_API_KEY445,
  process.env.YOUTUBE_API_KEY446,
  process.env.YOUTUBE_API_KEY447,
  process.env.YOUTUBE_API_KEY448,
  process.env.YOUTUBE_API_KEY449,
  process.env.YOUTUBE_API_KEY450,
  process.env.YOUTUBE_API_KEY451,
  process.env.YOUTUBE_API_KEY452,
  process.env.YOUTUBE_API_KEY453,
  process.env.YOUTUBE_API_KEY454,
  process.env.YOUTUBE_API_KEY455,
  process.env.YOUTUBE_API_KEY456,
  process.env.YOUTUBE_API_KEY457,
  process.env.YOUTUBE_API_KEY458,
  process.env.YOUTUBE_API_KEY459,
  process.env.YOUTUBE_API_KEY460,
  process.env.YOUTUBE_API_KEY461,
  process.env.YOUTUBE_API_KEY462,
  process.env.YOUTUBE_API_KEY463,
  process.env.YOUTUBE_API_KEY464,
  process.env.YOUTUBE_API_KEY465,
  process.env.YOUTUBE_API_KEY466,
  process.env.YOUTUBE_API_KEY467,
  process.env.YOUTUBE_API_KEY468,
  process.env.YOUTUBE_API_KEY469,
  process.env.YOUTUBE_API_KEY470,
  process.env.YOUTUBE_API_KEY471,
  process.env.YOUTUBE_API_KEY472,
  process.env.YOUTUBE_API_KEY473,
  process.env.YOUTUBE_API_KEY474,
  process.env.YOUTUBE_API_KEY475,
  process.env.YOUTUBE_API_KEY476,
  process.env.YOUTUBE_API_KEY477,
  process.env.YOUTUBE_API_KEY478,
  process.env.YOUTUBE_API_KEY479,
  process.env.YOUTUBE_API_KEY480,
  process.env.YOUTUBE_API_KEY481,
  process.env.YOUTUBE_API_KEY482,
  process.env.YOUTUBE_API_KEY483,
  process.env.YOUTUBE_API_KEY484,
  process.env.YOUTUBE_API_KEY485,
  process.env.YOUTUBE_API_KEY486,
  process.env.YOUTUBE_API_KEY487,
  process.env.YOUTUBE_API_KEY488,
  process.env.YOUTUBE_API_KEY489,
  process.env.YOUTUBE_API_KEY490,
  process.env.YOUTUBE_API_KEY491,
  process.env.YOUTUBE_API_KEY492,
  process.env.YOUTUBE_API_KEY493,
  process.env.YOUTUBE_API_KEY494,
  process.env.YOUTUBE_API_KEY495,
  process.env.YOUTUBE_API_KEY496,
  process.env.YOUTUBE_API_KEY497,
  process.env.YOUTUBE_API_KEY498,
  process.env.YOUTUBE_API_KEY499,
  process.env.YOUTUBE_API_KEY500,
  process.env.YOUTUBE_API_KEY501,
  process.env.YOUTUBE_API_KEY502,
  process.env.YOUTUBE_API_KEY503,
  process.env.YOUTUBE_API_KEY504,
  process.env.YOUTUBE_API_KEY505,
  process.env.YOUTUBE_API_KEY506,
  process.env.YOUTUBE_API_KEY507,
  process.env.YOUTUBE_API_KEY508,
  process.env.YOUTUBE_API_KEY509,
  process.env.YOUTUBE_API_KEY510,
  process.env.YOUTUBE_API_KEY511,
  process.env.YOUTUBE_API_KEY512,
  process.env.YOUTUBE_API_KEY513,
  process.env.YOUTUBE_API_KEY514,
  process.env.YOUTUBE_API_KEY515,
  process.env.YOUTUBE_API_KEY516,
  process.env.YOUTUBE_API_KEY517,
  process.env.YOUTUBE_API_KEY518,
  process.env.YOUTUBE_API_KEY519,
  process.env.YOUTUBE_API_KEY520,
  process.env.YOUTUBE_API_KEY521,
  process.env.YOUTUBE_API_KEY522,
  process.env.YOUTUBE_API_KEY523,
  process.env.YOUTUBE_API_KEY524,
  process.env.YOUTUBE_API_KEY525,
  process.env.YOUTUBE_API_KEY526,
  process.env.YOUTUBE_API_KEY527,
  process.env.YOUTUBE_API_KEY528,
  process.env.YOUTUBE_API_KEY529,
  process.env.YOUTUBE_API_KEY530,
  process.env.YOUTUBE_API_KEY531,
  process.env.YOUTUBE_API_KEY532,
  process.env.YOUTUBE_API_KEY533,
  process.env.YOUTUBE_API_KEY534,
  process.env.YOUTUBE_API_KEY535,
  process.env.YOUTUBE_API_KEY536,
  process.env.YOUTUBE_API_KEY537,
  process.env.YOUTUBE_API_KEY538,
  process.env.YOUTUBE_API_KEY539,
  process.env.YOUTUBE_API_KEY540,
  process.env.YOUTUBE_API_KEY541,
  process.env.YOUTUBE_API_KEY542,
  process.env.YOUTUBE_API_KEY543,
  process.env.YOUTUBE_API_KEY544,
  process.env.YOUTUBE_API_KEY545,
  process.env.YOUTUBE_API_KEY546,
  process.env.YOUTUBE_API_KEY547,
  process.env.YOUTUBE_API_KEY548,
  process.env.YOUTUBE_API_KEY549,
  process.env.YOUTUBE_API_KEY550,
  process.env.YOUTUBE_API_KEY551,
  process.env.YOUTUBE_API_KEY552,
  process.env.YOUTUBE_API_KEY553,
  process.env.YOUTUBE_API_KEY554,
  process.env.YOUTUBE_API_KEY555,
  process.env.YOUTUBE_API_KEY556,
  process.env.YOUTUBE_API_KEY557,
  process.env.YOUTUBE_API_KEY558,
  process.env.YOUTUBE_API_KEY559,
  process.env.YOUTUBE_API_KEY560,
  process.env.YOUTUBE_API_KEY561,
  process.env.YOUTUBE_API_KEY562,
  process.env.YOUTUBE_API_KEY563,
  process.env.YOUTUBE_API_KEY564,
  process.env.YOUTUBE_API_KEY565,
  process.env.YOUTUBE_API_KEY566,
  process.env.YOUTUBE_API_KEY567,
  process.env.YOUTUBE_API_KEY568,
  process.env.YOUTUBE_API_KEY569,
  process.env.YOUTUBE_API_KEY570,
  process.env.YOUTUBE_API_KEY571,
  process.env.YOUTUBE_API_KEY572,
  process.env.YOUTUBE_API_KEY573,
  process.env.YOUTUBE_API_KEY574,
  process.env.YOUTUBE_API_KEY575,
  process.env.YOUTUBE_API_KEY576,
  process.env.YOUTUBE_API_KEY577,
  process.env.YOUTUBE_API_KEY578,
  process.env.YOUTUBE_API_KEY579,
  process.env.YOUTUBE_API_KEY580,
  process.env.YOUTUBE_API_KEY581,
  process.env.YOUTUBE_API_KEY582,
  process.env.YOUTUBE_API_KEY583,
  process.env.YOUTUBE_API_KEY584,
  process.env.YOUTUBE_API_KEY585,
  process.env.YOUTUBE_API_KEY586,
  process.env.YOUTUBE_API_KEY587,
  process.env.YOUTUBE_API_KEY588,
  process.env.YOUTUBE_API_KEY589,
  process.env.YOUTUBE_API_KEY590,
  process.env.YOUTUBE_API_KEY591,
  process.env.YOUTUBE_API_KEY592,
  process.env.YOUTUBE_API_KEY593,
  process.env.YOUTUBE_API_KEY594,
  process.env.YOUTUBE_API_KEY595,
  process.env.YOUTUBE_API_KEY596,
  process.env.YOUTUBE_API_KEY597,
  process.env.YOUTUBE_API_KEY598,
  process.env.YOUTUBE_API_KEY599,
  process.env.YOUTUBE_API_KEY600,
  process.env.YOUTUBE_API_KEY601,
  process.env.YOUTUBE_API_KEY602,
  process.env.YOUTUBE_API_KEY603,
  process.env.YOUTUBE_API_KEY604,
  process.env.YOUTUBE_API_KEY605,
  process.env.YOUTUBE_API_KEY606,
  process.env.YOUTUBE_API_KEY607,
  process.env.YOUTUBE_API_KEY608,
  process.env.YOUTUBE_API_KEY609,
  process.env.YOUTUBE_API_KEY610,
  process.env.YOUTUBE_API_KEY611,
  process.env.YOUTUBE_API_KEY612,
  process.env.YOUTUBE_API_KEY613,
  process.env.YOUTUBE_API_KEY614,
  process.env.YOUTUBE_API_KEY615,
  process.env.YOUTUBE_API_KEY616,
  process.env.YOUTUBE_API_KEY617,
  process.env.YOUTUBE_API_KEY618,
  process.env.YOUTUBE_API_KEY619,
  process.env.YOUTUBE_API_KEY620,
  process.env.YOUTUBE_API_KEY621,
  process.env.YOUTUBE_API_KEY622,
  process.env.YOUTUBE_API_KEY623,
  process.env.YOUTUBE_API_KEY624,
  process.env.YOUTUBE_API_KEY625,
  process.env.YOUTUBE_API_KEY626,
  process.env.YOUTUBE_API_KEY627,
  process.env.YOUTUBE_API_KEY628,
  process.env.YOUTUBE_API_KEY629,
  process.env.YOUTUBE_API_KEY630,
  process.env.YOUTUBE_API_KEY631,
  process.env.YOUTUBE_API_KEY632,
  process.env.YOUTUBE_API_KEY633,
  process.env.YOUTUBE_API_KEY634,
  process.env.YOUTUBE_API_KEY635,
  process.env.YOUTUBE_API_KEY636,
  process.env.YOUTUBE_API_KEY637,
  process.env.YOUTUBE_API_KEY638,
  process.env.YOUTUBE_API_KEY639,
  process.env.YOUTUBE_API_KEY640,
  process.env.YOUTUBE_API_KEY641,
  process.env.YOUTUBE_API_KEY642,
  process.env.YOUTUBE_API_KEY643,
  process.env.YOUTUBE_API_KEY644,
  process.env.YOUTUBE_API_KEY645,
  process.env.YOUTUBE_API_KEY646,
  process.env.YOUTUBE_API_KEY647,
  process.env.YOUTUBE_API_KEY648,
  process.env.YOUTUBE_API_KEY649,
  process.env.YOUTUBE_API_KEY650,
  process.env.YOUTUBE_API_KEY651,
  process.env.YOUTUBE_API_KEY652,
  process.env.YOUTUBE_API_KEY653,
  process.env.YOUTUBE_API_KEY654,
  process.env.YOUTUBE_API_KEY655,
  process.env.YOUTUBE_API_KEY656,
  process.env.YOUTUBE_API_KEY657,
  process.env.YOUTUBE_API_KEY658,
  process.env.YOUTUBE_API_KEY659,
  process.env.YOUTUBE_API_KEY660,
  process.env.YOUTUBE_API_KEY661,
  process.env.YOUTUBE_API_KEY662,
  process.env.YOUTUBE_API_KEY663,
  process.env.YOUTUBE_API_KEY664,
  process.env.YOUTUBE_API_KEY665,
  process.env.YOUTUBE_API_KEY666,
  process.env.YOUTUBE_API_KEY667,
  process.env.YOUTUBE_API_KEY668,
  process.env.YOUTUBE_API_KEY669,
  process.env.YOUTUBE_API_KEY670,
  process.env.YOUTUBE_API_KEY671,
  process.env.YOUTUBE_API_KEY672,
  process.env.YOUTUBE_API_KEY673,
  process.env.YOUTUBE_API_KEY674,
  process.env.YOUTUBE_API_KEY675,
  process.env.YOUTUBE_API_KEY676,
  process.env.YOUTUBE_API_KEY677,
  process.env.YOUTUBE_API_KEY678,
  process.env.YOUTUBE_API_KEY679,
  process.env.YOUTUBE_API_KEY680,
  process.env.YOUTUBE_API_KEY681,
  process.env.YOUTUBE_API_KEY682,
  process.env.YOUTUBE_API_KEY683,
  process.env.YOUTUBE_API_KEY684,
  process.env.YOUTUBE_API_KEY685,
  process.env.YOUTUBE_API_KEY686,
  process.env.YOUTUBE_API_KEY687,
  process.env.YOUTUBE_API_KEY688,
  process.env.YOUTUBE_API_KEY689,
  process.env.YOUTUBE_API_KEY690,
  process.env.YOUTUBE_API_KEY691,
  process.env.YOUTUBE_API_KEY692,
  process.env.YOUTUBE_API_KEY693,
  process.env.YOUTUBE_API_KEY694,
  process.env.YOUTUBE_API_KEY695,
  process.env.YOUTUBE_API_KEY696,
  process.env.YOUTUBE_API_KEY697,
  process.env.YOUTUBE_API_KEY698,
  process.env.YOUTUBE_API_KEY699,
  process.env.YOUTUBE_API_KEY700,
  process.env.YOUTUBE_API_KEY701,
  process.env.YOUTUBE_API_KEY702,
  process.env.YOUTUBE_API_KEY703,
  process.env.YOUTUBE_API_KEY704,
  process.env.YOUTUBE_API_KEY705,
  process.env.YOUTUBE_API_KEY706,
  process.env.YOUTUBE_API_KEY707,
  process.env.YOUTUBE_API_KEY708,
  process.env.YOUTUBE_API_KEY709,
  process.env.YOUTUBE_API_KEY710,
  process.env.YOUTUBE_API_KEY711,
  process.env.YOUTUBE_API_KEY712,
  process.env.YOUTUBE_API_KEY713,
  process.env.YOUTUBE_API_KEY714,
  process.env.YOUTUBE_API_KEY715,
  process.env.YOUTUBE_API_KEY716,
  process.env.YOUTUBE_API_KEY717,
  process.env.YOUTUBE_API_KEY718,
  process.env.YOUTUBE_API_KEY719,
  process.env.YOUTUBE_API_KEY720,
  process.env.YOUTUBE_API_KEY721,
  process.env.YOUTUBE_API_KEY722,
  process.env.YOUTUBE_API_KEY723,
  process.env.YOUTUBE_API_KEY724,
  process.env.YOUTUBE_API_KEY725,
  process.env.YOUTUBE_API_KEY726,
  process.env.YOUTUBE_API_KEY727,
  process.env.YOUTUBE_API_KEY728,
  process.env.YOUTUBE_API_KEY729,
  process.env.YOUTUBE_API_KEY730,
  process.env.YOUTUBE_API_KEY731,
  process.env.YOUTUBE_API_KEY732,
  process.env.YOUTUBE_API_KEY733,
  process.env.YOUTUBE_API_KEY734,
  process.env.YOUTUBE_API_KEY735,
  process.env.YOUTUBE_API_KEY736,
  process.env.YOUTUBE_API_KEY737,
  process.env.YOUTUBE_API_KEY738,
  process.env.YOUTUBE_API_KEY739,
  process.env.YOUTUBE_API_KEY740,
  process.env.YOUTUBE_API_KEY741,
  process.env.YOUTUBE_API_KEY742,
  process.env.YOUTUBE_API_KEY743,
  process.env.YOUTUBE_API_KEY744,
  process.env.YOUTUBE_API_KEY745,
  process.env.YOUTUBE_API_KEY746,
  process.env.YOUTUBE_API_KEY747,
  process.env.YOUTUBE_API_KEY748,
  process.env.YOUTUBE_API_KEY749,
  process.env.YOUTUBE_API_KEY750,
  process.env.YOUTUBE_API_KEY751,
  process.env.YOUTUBE_API_KEY752,
  process.env.YOUTUBE_API_KEY753,
  process.env.YOUTUBE_API_KEY754,
  process.env.YOUTUBE_API_KEY755,
  process.env.YOUTUBE_API_KEY756,
  process.env.YOUTUBE_API_KEY757,
  process.env.YOUTUBE_API_KEY758,
  process.env.YOUTUBE_API_KEY759,
  process.env.YOUTUBE_API_KEY760,
  process.env.YOUTUBE_API_KEY761,
  process.env.YOUTUBE_API_KEY762,
  process.env.YOUTUBE_API_KEY763,
  process.env.YOUTUBE_API_KEY764,
  process.env.YOUTUBE_API_KEY765,
  process.env.YOUTUBE_API_KEY766,
  process.env.YOUTUBE_API_KEY767,
  process.env.YOUTUBE_API_KEY768,
  process.env.YOUTUBE_API_KEY769,
  process.env.YOUTUBE_API_KEY770,
  process.env.YOUTUBE_API_KEY771,
  process.env.YOUTUBE_API_KEY772,
  process.env.YOUTUBE_API_KEY773,
  process.env.YOUTUBE_API_KEY774,
  process.env.YOUTUBE_API_KEY775,
  process.env.YOUTUBE_API_KEY776,
  process.env.YOUTUBE_API_KEY777,
  process.env.YOUTUBE_API_KEY778,
  process.env.YOUTUBE_API_KEY779,
  process.env.YOUTUBE_API_KEY780,
  process.env.YOUTUBE_API_KEY781,
  process.env.YOUTUBE_API_KEY782,
  process.env.YOUTUBE_API_KEY783,
  process.env.YOUTUBE_API_KEY784,
  process.env.YOUTUBE_API_KEY785,
  process.env.YOUTUBE_API_KEY786,
  process.env.YOUTUBE_API_KEY787,
  process.env.YOUTUBE_API_KEY788,
  process.env.YOUTUBE_API_KEY789,
  process.env.YOUTUBE_API_KEY790,
  process.env.YOUTUBE_API_KEY791,
  process.env.YOUTUBE_API_KEY792,
  process.env.YOUTUBE_API_KEY793,
  process.env.YOUTUBE_API_KEY794,
  process.env.YOUTUBE_API_KEY795,
  process.env.YOUTUBE_API_KEY796,
  process.env.YOUTUBE_API_KEY797,
  process.env.YOUTUBE_API_KEY798,
  process.env.YOUTUBE_API_KEY799,
  process.env.YOUTUBE_API_KEY800,
  process.env.YOUTUBE_API_KEY801,
  process.env.YOUTUBE_API_KEY802,
  process.env.YOUTUBE_API_KEY803,
  process.env.YOUTUBE_API_KEY804,
  process.env.YOUTUBE_API_KEY805,
  process.env.YOUTUBE_API_KEY806,
  process.env.YOUTUBE_API_KEY807,
  process.env.YOUTUBE_API_KEY808,
  process.env.YOUTUBE_API_KEY809,
  process.env.YOUTUBE_API_KEY810,
  process.env.YOUTUBE_API_KEY811,
  process.env.YOUTUBE_API_KEY812,
  process.env.YOUTUBE_API_KEY813,
  process.env.YOUTUBE_API_KEY814,
  process.env.YOUTUBE_API_KEY815,
  process.env.YOUTUBE_API_KEY816,
  process.env.YOUTUBE_API_KEY817,
  process.env.YOUTUBE_API_KEY818,
  process.env.YOUTUBE_API_KEY819,
  process.env.YOUTUBE_API_KEY820,
  process.env.YOUTUBE_API_KEY821,
  process.env.YOUTUBE_API_KEY822,
  process.env.YOUTUBE_API_KEY823,
  process.env.YOUTUBE_API_KEY824,
  process.env.YOUTUBE_API_KEY825,
  process.env.YOUTUBE_API_KEY826,
  process.env.YOUTUBE_API_KEY827,
  process.env.YOUTUBE_API_KEY828,
  process.env.YOUTUBE_API_KEY829,
  process.env.YOUTUBE_API_KEY830,
  process.env.YOUTUBE_API_KEY831,
  process.env.YOUTUBE_API_KEY832,
  process.env.YOUTUBE_API_KEY833,
  process.env.YOUTUBE_API_KEY834,
  process.env.YOUTUBE_API_KEY835,
  process.env.YOUTUBE_API_KEY836,
  process.env.YOUTUBE_API_KEY837,
  process.env.YOUTUBE_API_KEY838,
  process.env.YOUTUBE_API_KEY839,
  process.env.YOUTUBE_API_KEY840,
  process.env.YOUTUBE_API_KEY841,
  process.env.YOUTUBE_API_KEY842,
  process.env.YOUTUBE_API_KEY843,
  process.env.YOUTUBE_API_KEY844,
  process.env.YOUTUBE_API_KEY845,
  process.env.YOUTUBE_API_KEY846,
  process.env.YOUTUBE_API_KEY847,
  process.env.YOUTUBE_API_KEY848,
  process.env.YOUTUBE_API_KEY849,
  process.env.YOUTUBE_API_KEY850,
  process.env.YOUTUBE_API_KEY851,
  process.env.YOUTUBE_API_KEY852,
  process.env.YOUTUBE_API_KEY853,
  process.env.YOUTUBE_API_KEY854,
  process.env.YOUTUBE_API_KEY855,
  process.env.YOUTUBE_API_KEY856,
  process.env.YOUTUBE_API_KEY857,
  process.env.YOUTUBE_API_KEY858,
  process.env.YOUTUBE_API_KEY859,
  process.env.YOUTUBE_API_KEY860,
  process.env.YOUTUBE_API_KEY861,
  process.env.YOUTUBE_API_KEY862,
  process.env.YOUTUBE_API_KEY863,
  process.env.YOUTUBE_API_KEY864,
  process.env.YOUTUBE_API_KEY865,
  process.env.YOUTUBE_API_KEY866,
  process.env.YOUTUBE_API_KEY867,
  process.env.YOUTUBE_API_KEY868,
  process.env.YOUTUBE_API_KEY869,
  process.env.YOUTUBE_API_KEY870,
  process.env.YOUTUBE_API_KEY871,
  process.env.YOUTUBE_API_KEY872,
  process.env.YOUTUBE_API_KEY873,
  process.env.YOUTUBE_API_KEY874,
  process.env.YOUTUBE_API_KEY875,
  process.env.YOUTUBE_API_KEY876,
  process.env.YOUTUBE_API_KEY877,
  process.env.YOUTUBE_API_KEY878,
  process.env.YOUTUBE_API_KEY879,
  process.env.YOUTUBE_API_KEY880,
  process.env.YOUTUBE_API_KEY881,
  process.env.YOUTUBE_API_KEY882,
  process.env.YOUTUBE_API_KEY883,
  process.env.YOUTUBE_API_KEY884,
  process.env.YOUTUBE_API_KEY885,
  process.env.YOUTUBE_API_KEY886,
  process.env.YOUTUBE_API_KEY887,
  process.env.YOUTUBE_API_KEY888,
  process.env.YOUTUBE_API_KEY889,
  process.env.YOUTUBE_API_KEY890,
  process.env.YOUTUBE_API_KEY891,
  process.env.YOUTUBE_API_KEY892,
  process.env.YOUTUBE_API_KEY893,
  process.env.YOUTUBE_API_KEY894,
  process.env.YOUTUBE_API_KEY895,
  process.env.YOUTUBE_API_KEY896,
  process.env.YOUTUBE_API_KEY897,
  process.env.YOUTUBE_API_KEY898,
  process.env.YOUTUBE_API_KEY899,
  process.env.YOUTUBE_API_KEY900,
  process.env.YOUTUBE_API_KEY901,
  process.env.YOUTUBE_API_KEY902,
  process.env.YOUTUBE_API_KEY903,
  process.env.YOUTUBE_API_KEY904,
  process.env.YOUTUBE_API_KEY905,
  process.env.YOUTUBE_API_KEY906,
  process.env.YOUTUBE_API_KEY907,
  process.env.YOUTUBE_API_KEY908,
  process.env.YOUTUBE_API_KEY909,
  process.env.YOUTUBE_API_KEY910,
  process.env.YOUTUBE_API_KEY911,
  process.env.YOUTUBE_API_KEY912,
  process.env.YOUTUBE_API_KEY913,
  process.env.YOUTUBE_API_KEY914,
  process.env.YOUTUBE_API_KEY915,
  process.env.YOUTUBE_API_KEY916,
  process.env.YOUTUBE_API_KEY917,
  process.env.YOUTUBE_API_KEY918,
  process.env.YOUTUBE_API_KEY919,
  process.env.YOUTUBE_API_KEY920,
  process.env.YOUTUBE_API_KEY921,
  process.env.YOUTUBE_API_KEY922,
  process.env.YOUTUBE_API_KEY923,
  process.env.YOUTUBE_API_KEY924,
  process.env.YOUTUBE_API_KEY925,
  process.env.YOUTUBE_API_KEY926,
  process.env.YOUTUBE_API_KEY927,
  process.env.YOUTUBE_API_KEY928,
  process.env.YOUTUBE_API_KEY929,
  process.env.YOUTUBE_API_KEY930,
  process.env.YOUTUBE_API_KEY931,
  process.env.YOUTUBE_API_KEY932,
  process.env.YOUTUBE_API_KEY933,
  process.env.YOUTUBE_API_KEY934,
  process.env.YOUTUBE_API_KEY935,
  process.env.YOUTUBE_API_KEY936,
  process.env.YOUTUBE_API_KEY937,
  process.env.YOUTUBE_API_KEY938,
  process.env.YOUTUBE_API_KEY939,
  process.env.YOUTUBE_API_KEY940,
  process.env.YOUTUBE_API_KEY941,
  process.env.YOUTUBE_API_KEY942,
  process.env.YOUTUBE_API_KEY943,
  process.env.YOUTUBE_API_KEY944,
  process.env.YOUTUBE_API_KEY945,
  process.env.YOUTUBE_API_KEY946,
  process.env.YOUTUBE_API_KEY947,
  process.env.YOUTUBE_API_KEY948,
  process.env.YOUTUBE_API_KEY949,
  process.env.YOUTUBE_API_KEY950,
  process.env.YOUTUBE_API_KEY951,
  process.env.YOUTUBE_API_KEY952,
  process.env.YOUTUBE_API_KEY953,
  process.env.YOUTUBE_API_KEY954,
  process.env.YOUTUBE_API_KEY955,
  process.env.YOUTUBE_API_KEY956,
  process.env.YOUTUBE_API_KEY957,
  process.env.YOUTUBE_API_KEY958,
  process.env.YOUTUBE_API_KEY959,
  process.env.YOUTUBE_API_KEY960,
  process.env.YOUTUBE_API_KEY961,
  process.env.YOUTUBE_API_KEY962,
  process.env.YOUTUBE_API_KEY963,
  process.env.YOUTUBE_API_KEY964,
  process.env.YOUTUBE_API_KEY965,
  process.env.YOUTUBE_API_KEY966,
  process.env.YOUTUBE_API_KEY967,
  process.env.YOUTUBE_API_KEY968,
  process.env.YOUTUBE_API_KEY969,
  process.env.YOUTUBE_API_KEY970,
  process.env.YOUTUBE_API_KEY971,
  process.env.YOUTUBE_API_KEY972,
  process.env.YOUTUBE_API_KEY973,
  process.env.YOUTUBE_API_KEY974,
  process.env.YOUTUBE_API_KEY975,
  process.env.YOUTUBE_API_KEY976,
  process.env.YOUTUBE_API_KEY977,
  process.env.YOUTUBE_API_KEY978,
  process.env.YOUTUBE_API_KEY979,
  process.env.YOUTUBE_API_KEY980,
  process.env.YOUTUBE_API_KEY981,
  process.env.YOUTUBE_API_KEY982,
  process.env.YOUTUBE_API_KEY983,
  process.env.YOUTUBE_API_KEY984,
  process.env.YOUTUBE_API_KEY985,
  process.env.YOUTUBE_API_KEY986,
  process.env.YOUTUBE_API_KEY987,
  process.env.YOUTUBE_API_KEY988,
  process.env.YOUTUBE_API_KEY989,
  process.env.YOUTUBE_API_KEY990,
  process.env.YOUTUBE_API_KEY991,
  process.env.YOUTUBE_API_KEY992,
  process.env.YOUTUBE_API_KEY993,
  process.env.YOUTUBE_API_KEY994,
  process.env.YOUTUBE_API_KEY995,
  process.env.YOUTUBE_API_KEY996,
  process.env.YOUTUBE_API_KEY997,
  process.env.YOUTUBE_API_KEY998,
  process.env.YOUTUBE_API_KEY999,
  process.env.YOUTUBE_API_KEY1000,
].filter(Boolean);

let currentKey = 0;

function getKey() {
  return YT_KEYS[currentKey];
}

function rotateKey() {
  currentKey = (currentKey + 1) % YT_KEYS.length;
}

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.garudalinux.org',
  'https://api.piped.projectsegfau.lt'
];

async function fetchFromPiped(query) {
  for (let i = 0; i < PIPED_INSTANCES.length; i++) {
    try {
      const url = PIPED_INSTANCES[i] + '/search?q=' + encodeURIComponent(query) + '&filter=videos';
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const data = await r.json();
      if (!data.items || data.items.length === 0) continue;
      const v = data.items.find(function(x){ return x.type === 'stream'; });
      if (!v) continue;
      const ytId = v.url ? v.url.replace('/watch?v=', '') : null;
      if (!ytId) continue;
      return {
        items: [{
          id: { videoId: ytId },
          snippet: {
            title: v.title || query,
            thumbnails: { medium: { url: v.thumbnail || '' } }
          }
        }]
      };
    } catch(e) {}
  }
  return { items: [] };
}

async function fetchYT(url) {
  for (let i = 0; i < YT_KEYS.length; i++) {
    try {
      const fullUrl = url + '&key=' + getKey();
      const r = await fetch(fullUrl);
      if (!r.ok) { rotateKey(); continue; }
      const data = await r.json();
      if (data.error && data.error.code === 403) {
        rotateKey();
        continue;
      }
      return data;
    } catch(e) {
      console.error('[fetchYT] erro:', e.message);
      rotateKey();
      continue;
    }
  }
  console.log('[fetchYT] todas as chaves esgotadas, tentando Piped...');
  const qMatch = url.match(/[?&]q=([^&]+)/);
  if (qMatch) {
    return await fetchFromPiped(decodeURIComponent(qMatch[1]));
  }
  return { items: [] };
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'hitssoud.html'));
});

app.get('/api/search', async function(req, res) {
  try {
    const q = req.query.q;
    if (!q) return res.json({ items: [] });

    // Palavras que indicam playlist ou compilacao — filtrar fora
    const blocklist = ['top 50','top50','dvd','radio 24','rádio 24','24 horas','24h','completo','playlist','coletanea','coletânea','mais tocadas','mais ouvidas','louvores que tocam','louvores que','album completo','álbum completo','as 10','as 20','as 30','compilation','mix completo','ao vivo completo'];

    function isBlocked(title) {
      var t = title.toLowerCase();
      return blocklist.some(function(w) { return t.includes(w); });
    }

    // Busca 1: musicas do artista buscado no YouTube
    var isInternacional = (generoDetectado === 'internacional');
    var url1 = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=15' + (isInternacional ? '' : '&relevanceLanguage=pt&regionCode=BR') + '&q=' + encodeURIComponent(q);
    var data1 = await fetchYT(url1);
    var items1 = (data1.items || []).filter(function(i) { return !isBlocked(i.snippet.title); });

    // Busca 2: artistas relacionados por genero detectado
    var items2 = [];
    var artistasBR = {
      gospel:     ['Gabriela Rocha','Aline Barros','Morada','Thalles Roberto','Nivea Soares','Anderson Freire','Davi Sacer','Fernandinho','Ministério Avivah','Sarah Beatriz','Isadora Pompeo','Julliany Souza','Preto no Branco','Ton Carfi','Eyshila','Bruna Karla','Kemuel','Ana Paula Valadão','Eli Soares','Paulo Cesar Baruk'],
      sertanejo:  ['Jorge e Mateus','Marilia Mendonca','Gusttavo Lima','Henrique e Juliano','Luan Santana','Ana Castela','Zé Neto e Cristiano','Israel e Rodolffo'],
      funk:       ['MC Livinho','Ludmilla','Anitta','MC Kekel','Dennis DJ','MC Hariel','MC Don Juan','Kevinho'],
      pagode:     ['Grupo Menos É Mais','Turma do Pagode','Sorriso Maroto','Dilsinho','Thiaguinho','Exaltasamba','Belo'],
      rap:        ['Emicida','Racionais MCs','Criolo','BK','Djonga','Filipe Ret','Orochi','Xamã'],
      rock:       ['Legião Urbana','Skank','Os Paralamas do Sucesso','Nando Reis','Capital Inicial','Fresno','NX Zero'],
      pop:        ['Anitta','Dua Lipa','The Weeknd','Luisa Sonza','Matuê','IZA','Pabllo Vittar'],
      forro:      ['Wesley Safadão','Xand Avião','Tarcísio do Acordeon','Solange Almeida','Falamansa'],
      axe:        ['Ivete Sangalo','Claudia Leitte','Léo Santana','Timbalada','Olodum'],
      internacional: ['The Weeknd','Taylor Swift','Bruno Mars','Ed Sheeran','Ariana Grande','Billie Eilish']
    };
    // Detecta genero pelo nome do artista buscado
    var generoDetectado = 'pop';
    var qLow = q.toLowerCase();
    if(['fernandinho','gabriela rocha','aline barros','morada','thalles','nivea soares','anderson freire','davi sacer','avivah','sarah beatriz','isadora pompeo','pregador luo','eyshila'].some(function(g){ return qLow.includes(g); })) generoDetectado = 'gospel';
    else if(['jorge','mateus','marilia','gusttavo','henrique','juliano','luan santana','ana castela','ze neto','israel','rodolffo','maiara','maraisa'].some(function(g){ return qLow.includes(g); })) generoDetectado = 'sertanejo';
    else if(['mc ','ludmilla','anitta','dennis','kevinho'].some(function(g){ return qLow.includes(g); })) generoDetectado = 'funk';
    else if(['emicida','racionais','criolo','djonga','filipe ret','orochi','xama'].some(function(g){ return qLow.includes(g); })) generoDetectado = 'rap';
    else if(['legiao','skank','paralamas','nando reis','capital inicial','fresno'].some(function(g){ return qLow.includes(g); })) generoDetectado = 'rock';
    else if(['wesley safadao','xand','tarcisio','solange almeida','falamansa'].some(function(g){ return qLow.includes(g); })) generoDetectado = 'forro';
    else if(['ivete','claudia leitte','leo santana','timbalada','olodum'].some(function(g){ return qLow.includes(g); })) generoDetectado = 'axe';
    else if(['weeknd','taylor swift','bruno mars','ed sheeran','ariana','billie eilish','beyonce','drake','rihanna','adele','justin bieber','lady gaga','post malone','kendrick','travis scott','bad bunny','j balvin','ozuna','maluma','shakira','karol g'].some(function(g){ return qLow.includes(g); })) generoDetectado = 'internacional';

    // Busca top artistas do genero no Last.fm
    var tagLastFm = {
      gospel: 'gospel',
      sertanejo: 'sertanejo',
      funk: 'funk brasileiro',
      pagode: 'pagode',
      rap: 'rap brasileiro',
      rock: 'rock brasileiro',
      pop: 'pop brasileiro',
      forro: 'forro',
      axe: 'axe',
      internacional: 'pop'
    };
    var lfTag = tagLastFm[generoDetectado] || 'pop brasileiro';
    var listaArtistas = artistasBR[generoDetectado] || artistasBR.pop; // fallback
    // Usando lista fixa BR — Last.fm trazia artistas internacionais para tags gospel/sertanejo
    listaArtistas = listaArtistas.filter(function(a){ return !a.toLowerCase().includes(qLow) && !qLow.includes(a.toLowerCase()); });
    listaArtistas = listaArtistas.sort(function(){ return Math.random()-0.5; }).slice(0,8);
    console.log('[SEARCH] Artistas selecionados:', listaArtistas);
    var simBuscas = listaArtistas.map(function(nome){
      var u = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=4' + (isInternacional ? '' : '&relevanceLanguage=pt&regionCode=BR') + '&q=' + encodeURIComponent(nome + ' musica');
      return fetchYT(u);
    });
    var simResultados = await Promise.all(simBuscas);
    simResultados.forEach(function(d){
      var its = (d.items || []).filter(function(i){ return !isBlocked(i.snippet.title); });
      items2 = items2.concat(its);
    });

    // Mesclar sem duplicatas por videoId
    var seen = new Set();
    var merged = [];
    items1.concat(items2).forEach(function(item) {
      var id = item.id && item.id.videoId ? item.id.videoId : item.id;
      if (!seen.has(id)) { seen.add(id); merged.push(item); }
    });

    res.json({ items: merged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/artist-photo', async function(req, res) {
  try {
    var artist = req.query.artist;
    if (!artist) return res.json({ photo: null });
    var url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=' + encodeURIComponent(artist);
    var data = await fetchYT(url);
    var items = data.items || [];
    if (!items.length) return res.json({ photo: null });
    var thumb = items[0].snippet.thumbnails.medium.url;
    res.json({ photo: thumb });
  } catch(e) {
    res.json({ photo: null });
  }
});

app.post('/api/ia-humor', async function(req, res) {
  try {
    const { humor } = req.body;
    if (!humor) return res.status(400).json({ error: 'humor obrigatorio' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: 'Você é um DJ especialista em música brasileira. O usuário vai te contar seu humor ou momento atual. Você deve responder com uma mensagem curta e animada (máximo 2 frases) e sugerir exatamente 5 músicas perfeitas para aquele momento. Responda APENAS em JSON válido, sem markdown, no formato: {"mensagem":"texto animado aqui","musicas":[{"nome":"nome da musica","artista":"nome do artista"},{"nome":"...","artista":"..."},{"nome":"...","artista":"..."},{"nome":"...","artista":"..."},{"nome":"...","artista":"..."}]}. Prefira músicas brasileiras (sertanejo, funk, gospel, pagode, pop BR, forró) mas pode incluir internacionais se fizer sentido para o momento.',
        messages: [{ role: 'user', content: humor }]
      })
    });
    const data = await response.json();
    const raw = data.content.map(function(i){ return i.text||''; }).join('');
    const clean = raw.replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trending', async function(req, res) {
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&videoCategoryId=10&regionCode=BR&maxResults=50`;
    const data = await fetchYT(url);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clear-genre-cache', async function(req, res) {
  try {
    await GenreCache.deleteMany({});
    res.json({ ok: true, msg: 'GenreCache limpo!' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/lastfm-novidades', async function(req, res) {
  try {
    const genre = req.query.genre || 'brasil';

    // Gospel: nao mexemos
    if (genre === 'gospel') {
      const artistasGospel = ['Gabriela Rocha','Aline Barros','Morada','Thalles Roberto','Nivea Soares','Anderson Freire','Davi Sacer','Fernandinho','Ministerio Avivah','Sarah Beatriz','Isadora Pompeo','Julliany Souza','Preto no Branco','Ton Carfi','Eyshila','Bruna Karla','Kemuel','Ana Paula Valadao','Eli Soares','Paulo Cesar Baruk'];
      const shuffled = artistasGospel.sort(function(){ return Math.random() - 0.5; });
      const escolhidos = shuffled.slice(0, 20);
      var gospelResults = [];
      for (var gi = 0; gi < escolhidos.length; gi++) {
        var artista = escolhidos[gi];
        var q = artista + ' gospel';
        try {
          var cached = await YtCache.findOne({ query: q });
          if (cached) {
            gospelResults.push({ name: cached.title || q, artist: artista, ytId: cached.ytId, thumb: cached.thumb });
          } else {
            var ytUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=' + encodeURIComponent(q);
            var ytData = await fetchYT(ytUrl);
            if (ytData.items && ytData.items.length > 0) {
              var it = ytData.items[0];
              var ytId = it.id.videoId;
              var thumb = it.snippet.thumbnails.medium.url;
              var title = it.snippet.title;
              gospelResults.push({ name: title, artist: artista, ytId: ytId, thumb: thumb });
              YtCache.create({ query: q, ytId: ytId, thumb: thumb, title: title }).catch(function(){});
            }
          }
        } catch(e) {}
      }
      return res.json({ items: gospelResults });
    }

    // Cache de genero: retorna direto se existir
    try {
      var genreCached = await GenreCache.findOne({ genre: genre }).maxTimeMS(3000);
      if (genreCached && genreCached.items && genreCached.items.length > 0) {
        return res.json({ items: genreCached.items });
      }
    } catch(cacheErr) {}

    // Mapa iTunes com termos especificos por genero para artistas certos
    const itunesTermMap = {
      'funk':      ['funk carioca','MC Livinho','MC Fioti','Ludmilla funk','Anitta funk','MC Don Juan','Kevinho','MC Kekel','MC G15','MC Rodolfinho'],
      'pagode':    ['pagode brasileiro','Thiaguinho','Ferrugem','Dilsinho','Sorriso Maroto','Grupo Revelacao','Exaltasamba','Belo','Mumuzinho','Turma do Pagode','Negritude Junior','Raça Negra','Fundo de Quintal','Molejo','Pixote','Jeito Moleque','Revelação','Swing e Simpatia','Rodriguinho','Diogo Nogueira'],
      'sertanejo': ['sertanejo universitario','Gusttavo Lima','Marilia Mendonca','Jorge e Mateus','Henrique e Juliano','Zeze Di Camargo','Maiara e Maraisa','Luan Santana','Wesley Safadao','Pedro Sampaio sertanejo'],
      'rap':       ['rap nacional','Emicida','Racionais','Criolo rap','Projota','Marcelo D2','Rashid rap','BK rap','Djonga','Filipe Ret'],
      'rock':      ['rock brasileiro','Legiao Urbana','Titãs','Skank','Os Paralamas do Sucesso','Capital Inicial','CPM 22','Detonautas','Fresno','Charlie Brown Jr','Engenheiros do Hawaii','Raimundos','Ultraje a Rigor','NXZero','Jota Quest','Pitty','Restart','Los Hermanos','Sepultura','Angra'],
      'pop':       ['pop brasileiro','Anitta','Ludmilla','Dua Lipa','The Weeknd','Ivete Sangalo pop','Claudia Leitte','Gloria Groove','IZA','Pabllo Vittar'],
      'axe':       ['axe bahia','Ivete Sangalo','Claudia Leitte','Bell Marques','Chiclete com Banana','Harmonia do Samba','Psirico','Margareth Menezes','Safadao forro','Tomate axe'],
      'brasil':    ['musica brasileira','hits brasil','MPB','Caetano Veloso','Gilberto Gil','Djavan','Milton Nascimento','Seu Jorge','Marisa Monte','Elza Soares'],
      'internacional': ['pop hits','Billboard hot 100','Taylor Swift','Bad Bunny','Drake','The Weeknd','Beyonce','Ed Sheeran','Billie Eilish','Ariana Grande'],
    };

    const terms = itunesTermMap[genre] || itunesTermMap['brasil'];
    var seen = {};
    var seenArtists = {};
    var results = [];

    // Busca iTunes em paralelo para os termos do genero
    var fetchPromises = terms.map(function(term) {
      var url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(term) + '&media=music&limit=50&country=BR';
      return fetch(url, { signal: AbortSignal.timeout(6000) })
        .then(function(r){ return r.json(); })
        .catch(function(){ return { results: [] }; });
    });

    var allResponses = await Promise.all(fetchPromises);

    for (var ri = 0; ri < allResponses.length; ri++) {
      var data = allResponses[ri];
      if (!data.results) continue;
      for (var i = 0; i < data.results.length; i++) {
        var it = data.results[i];
        var name = it.trackName || '';
        var artist = it.artistName || '';
        var thumb = it.artworkUrl100 || '';
        if (!name || !artist) continue;
        var key = (artist + name).toLowerCase();
        if (seen[key]) continue;
        var artistLimit = (genre === 'pagode' || genre === 'rock') ? 5 : 3;
        if (seenArtists[artist] >= artistLimit) continue;
        seen[key] = true;
        seenArtists[artist] = (seenArtists[artist] || 0) + 1;
        results.push({ name: name, artist: artist, ytId: null, thumb: thumb });
        if (results.length >= 30) break;
      }
    }

    // Salva no cache de genero por 7 dias
    if (results.length > 0) {
      GenreCache.findOneAndUpdate(
        { genre: genre },
        { genre: genre, items: results, cachedAt: new Date() },
        { upsert: true }
      ).catch(function(){});
    }

    res.json({ items: results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/artist-videos', async function(req, res) {
  try {
    const artist = req.query.artist;
    if (!artist) return res.json({ items: [] });
    // Primeiro busca o canal oficial do artista
    const chUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(artist)}`;
    const chData = await fetchYT(chUrl);
    if(chData.items && chData.items.length > 0) {
      const channelId = chData.items[0].id.channelId;
      // Busca albuns e lancamentos recentes do canal oficial
      const vUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=6&channelId=${channelId}&q=album+lancamento+novo+clipe`;
      const vData = await fetchYT(vUrl);
      res.json(vData);
    } else {
      // Fallback: busca lancamentos por nome do artista
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=6&q=${encodeURIComponent(artist + ' album lancamento novo')}`;
      const data = await fetchYT(url);
      res.json(data);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reels', async function(req, res) {
  try {
    const artist = req.query.artist;
    if (!artist) return res.json({ items: [] });
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=9&videoDuration=short&q=${encodeURIComponent(artist + ' official short clip')}&relevanceLanguage=pt`;
    const data = await fetchYT(url);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/podcasts', async function(req, res) {
  try {
    const q = req.query.q || 'podcast brasil';
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=podcast&limit=15&country=BR`;
    const r = await fetch(url);
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Schema de comentarios
const commentSchema = new mongoose.Schema({
  ytId: String,
  userId: String,
  userName: String,
  text: String,
  createdAt: { type: Date, default: Date.now }
});
const Comment = mongoose.model('Comment', commentSchema);

// Buscar comentarios de uma musica
app.get('/api/comments', async function(req, res) {
  try {
    const ytId = req.query.ytId;
    if (!ytId) return res.status(400).json({ error: 'ytId obrigatorio' });
    const comments = await Comment.find({ ytId }).sort({ createdAt: -1 }).limit(50);
    res.json(comments);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Adicionar comentario
app.post('/api/comments', async function(req, res) {
  try {
    const { ytId, userId, userName, text } = req.body;
    if (!ytId || !userId || !text) return res.status(400).json({ error: 'Campos obrigatorios' });
    if (text.length > 200) return res.status(400).json({ error: 'Comentario muito longo' });
    const comment = await Comment.create({ ytId, userId, userName, text });
    res.json(comment);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Apagar comentario (admin)
app.delete('/api/comments/:id', async function(req, res) {
  try {
    await Comment.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Rota para registrar play
app.post('/api/ranking/play', async function(req, res) {
  try {
    const { userId, userName } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId obrigatorio' });
    const month = new Date().toISOString().slice(0, 7);
    let record = await Play.findOne({ userId, month });
    if (record) {
      record.count += 1;
      if (userName) record.userName = userName;
      await record.save();
    } else {
      record = await Play.create({ userId, userName: userName || userId, count: 1, month });
    }
    res.json({ ok: true, count: record.count });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Rota para buscar ranking do mes
app.get('/api/ranking', async function(req, res) {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const top = await Play.find({ month }).sort({ count: -1 }).limit(20);
    res.json(top);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Registrar ou atualizar usuário
app.post('/api/user/register', async function(req, res) {
  try {
    const { userId, userName, displayName, photo } = req.body;
    if (!userId || !userName) return res.status(400).json({ error: 'userId e userName obrigatórios' });
    const clean = userName.toLowerCase().replace(/[^a-z0-9_]/g,'');
    if (clean.length < 3) return res.status(400).json({ error: 'Nome deve ter pelo menos 3 caracteres' });
    const existing = await User.findOne({ userName: clean, userId: { $ne: userId } });
    if (existing) return res.status(400).json({ error: 'Nome de usuário já em uso' });
    const user = await User.findOneAndUpdate(
      { userId },
      { userName: clean, displayName: displayName || clean, photo: photo || null },
      { upsert: true, new: true }
    );
    res.json({ ok: true, user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Buscar usuário pelo userId
app.get('/api/user/get', async function(req, res) {
  try {
    const { userId } = req.query;
    if (!userId) return res.json({ user: null });
    const user = await User.findOne({ userId }).select('userId userName displayName photo');
    res.json({ user: user || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Buscar usuário por nome
app.get('/api/user/search', async function(req, res) {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q || q.length < 3) return res.json({ users: [] });
    const users = await User.find({ userName: new RegExp(q) }).limit(10).select('userId userName displayName photo');
    res.json({ users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Enviar pedido de amizade
app.post('/api/user/friend-request', async function(req, res) {
  try {
    const { fromId, toUserName } = req.body;
    const target = await User.findOne({ userName: toUserName.toLowerCase() });
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (target.userId === fromId) return res.status(400).json({ error: 'Você não pode se adicionar' });
    if (target.friends.includes(fromId)) return res.status(400).json({ error: 'Já são amigos' });
    if (target.friendRequests.includes(fromId)) return res.status(400).json({ error: 'Pedido já enviado' });
    await User.findOneAndUpdate({ userName: toUserName.toLowerCase() }, { $push: { friendRequests: fromId } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Aceitar pedido de amizade
app.post('/api/user/friend-accept', async function(req, res) {
  try {
    const { userId, fromId } = req.body;
    await User.findOneAndUpdate({ userId }, { $pull: { friendRequests: fromId }, $push: { friends: fromId } });
    await User.findOneAndUpdate({ userId: fromId }, { $push: { friends: userId } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Recusar pedido
app.post('/api/user/friend-decline', async function(req, res) {
  try {
    const { userId, fromId } = req.body;
    await User.findOneAndUpdate({ userId }, { $pull: { friendRequests: fromId } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Buscar amigos e pedidos pendentes
app.get('/api/user/friends', async function(req, res) {
  try {
    const { userId } = req.query;
    const user = await User.findOne({ userId });
    if (!user) return res.json({ friends: [], requests: [] });
    const friends = await User.find({ userId: { $in: user.friends } }).select('userId userName displayName photo');
    const requests = await User.find({ userId: { $in: user.friendRequests } }).select('userId userName displayName photo');
    res.json({ friends, requests });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

server.listen(PORT, function() {
  console.log('HitsSoud rodando na porta ' + PORT);
});
