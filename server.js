'use strict';
/*
 * 온기 마을회관 실시간 서버
 * - 로그인 없이 입장, 이름과 모습은 서버가 자동으로 정해 줘요.
 * - 방 하나의 정원은 ROOM_CAP(기본 30명). 가득 차면 새 방을 열고, MAX_ROOMS(기본 50개)까지 열어요.
 * - 자유 입력 문장은 받지 않아요. 정해진 문장의 번호(0~8)만 받아서 중계해요.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_CAP = Number(process.env.ROOM_CAP) || 30;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 50;
const PHRASE_COUNT = 9;      // public/index.html 의 PHRASES 개수와 같아야 해요
const LOOK_COUNT = 8;        // public/index.html 의 LOOKS 개수와 같아야 해요
const MIN_MOVE_GAP = 40;     // ms, 이동 메시지 최소 간격
const MIN_SAY_GAP = 1500;    // ms, 인사 최소 간격

// 마당 좌표는 가로·세로 모두 0~100 (50,50 이 한가운데). 화면이 이 값을 실제 거리로 바꿔 써요.
const X_MIN = 2, X_MAX = 98, Y_MIN = 2, Y_MAX = 98;

const ADJ = ['따뜻한','푸른','느긋한','고운','환한','잔잔한','든든한','맑은','포근한','싱그러운','넉넉한','은은한','다정한','고요한','반짝이는','향긋한'];
const NOUN = ['햇살','하늘','구름','단풍','달빛','바람','바위','시냇물','솔잎','들꽃','노을','새벽','호수','언덕','별빛','국화'];

// 화면 파일은 public/index.html 이나 같은 폴더의 index.html 중 있는 쪽을 써요.
const htmlPath = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')]
  .find((p) => fs.existsSync(p));
if (!htmlPath) {
  console.error('index.html 을 찾지 못했어요. server.js 와 같은 폴더(또는 public 폴더)에 index.html 을 넣어 주세요.');
  process.exit(1);
}
const indexHtml = fs.readFileSync(htmlPath);
// 3D 라이브러리(three.min.js)가 같은 폴더(또는 public 폴더)에 있으면 이 서버가 직접 내려줘요.
// 없으면 화면이 인터넷(cdnjs)에서 불러와요.
const threePath = [path.join(__dirname, 'public', 'three.min.js'), path.join(__dirname, 'three.min.js')]
  .find((p) => fs.existsSync(p));
const threeJs = threePath ? fs.readFileSync(threePath) : null;

const rooms = [];            // { id, players: Map }
let nextPlayerId = 1;
let nextRoomId = 1;

function rnd(n) { return Math.floor(Math.random() * n); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

function pickName(room) {
  const used = new Set();
  room.players.forEach(p => used.add(p.name));
  for (let i = 0; i < 30; i++) {
    const n = ADJ[rnd(ADJ.length)] + ' ' + NOUN[rnd(NOUN.length)];
    if (!used.has(n)) return n;
  }
  return ADJ[rnd(ADJ.length)] + ' ' + NOUN[rnd(NOUN.length)] + ' ' + (rnd(90) + 10);
}

function assignRoom() {
  for (const r of rooms) if (r.players.size < ROOM_CAP) return r;
  if (rooms.length < MAX_ROOMS) {
    const r = { id: nextRoomId++, players: new Map() };
    rooms.push(r);
    return r;
  }
  return null;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj, exceptId) {
  const msg = JSON.stringify(obj);
  room.players.forEach(p => {
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(msg);
  });
}
function pub(p) { return { id: p.id, name: p.name, look: p.look, x: p.x, y: p.y, sit: p.sit ? 1 : 0 }; }

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, base));
    res.end(indexHtml);
  } else if (url === '/three.min.js' && threeJs) {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }, base));
    res.end(threeJs);
  } else if (url === '/healthz') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, base));
    res.end('ok');
  } else if (url === '/stats') {
    let players = 0;
    rooms.forEach(r => { players += r.players.size; });
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, base));
    res.end(JSON.stringify({ rooms: rooms.length, players, roomCap: ROOM_CAP, maxRooms: MAX_ROOMS }));
  } else {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, base));
    res.end('not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 });

wss.on('connection', (ws) => {
  const room = assignRoom();
  if (!room) {
    send(ws, { t: 'full' });
    ws.close(1013, 'full');
    return;
  }
  const p = {
    id: String(nextPlayerId++),
    name: pickName(room),
    look: rnd(LOOK_COUNT),
    x: 42 + Math.random() * 16,
    y: 42 + Math.random() * 16,
    ws, room, lastMove: 0, lastSay: 0, lastSit: 0, sit: 0
  };
  room.players.set(p.id, p);
  ws.isAlive = true;

  send(ws, {
    t: 'hello',
    me: pub(p),
    room: room.id,
    peers: Array.from(room.players.values()).filter(o => o.id !== p.id).map(pub)
  });
  broadcast(room, { t: 'join', p: pub(p) }, p.id);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const now = Date.now();
    if (m.t === 'move') {
      if (now - p.lastMove < MIN_MOVE_GAP) return;
      const x = Number(m.x), y = Number(m.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      p.lastMove = now;
      p.x = clamp(x, X_MIN, X_MAX);
      p.y = clamp(y, Y_MIN, Y_MAX);
      broadcast(room, { t: 'move', id: p.id, x: p.x, y: p.y }, p.id);
    } else if (m.t === 'sit') {
      if (now - p.lastSit < 300) return;
      p.lastSit = now;
      p.sit = (m.v === 1 || m.v === true) ? 1 : 0;
      broadcast(room, { t: 'sit', id: p.id, v: p.sit }, p.id);
    } else if (m.t === 'say') {
      const i = Number(m.i);
      if (!Number.isInteger(i) || i < 0 || i >= PHRASE_COUNT) return;
      if (now - p.lastSay < MIN_SAY_GAP) return;
      p.lastSay = now;
      broadcast(room, { t: 'say', id: p.id, i }); // 보낸 사람에게도 돌려줘요
    }
  });

  ws.on('close', () => {
    room.players.delete(p.id);
    broadcast(room, { t: 'leave', id: p.id });
    if (room.players.size === 0) {
      const k = rooms.indexOf(room);
      if (k >= 0) rooms.splice(k, 1);
    }
  });
  ws.on('error', () => {});
});

// 끊어진 접속 정리 (30초마다 확인)
const hb = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);
wss.on('close', () => clearInterval(hb));

server.listen(PORT, () => {
  console.log('온기 마을회관 서버 시작: http://localhost:' + PORT + '  (방 정원 ' + ROOM_CAP + '명, 최대 ' + MAX_ROOMS + '개 방)');
});

module.exports = { server };
