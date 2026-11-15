// Galaxium Vocal — relais entre le serveur Minecraft Bedrock (behavior pack)
// et le site de chat vocal de proximité (WebRTC).
//
//  BDS (behavior pack) ──HTTP POST /api/mc/*──►  ce serveur  ◄──WebSocket /ws──  navigateurs
//                                                    │
//                     positions + liaison par code   │   signalisation WebRTC (l'audio va en P2P)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// ───────────── Configuration (variables d'environnement sur Render) ─────────────
const PORT = Number(process.env.PORT) || 3000;
const MC_KEY = process.env.MC_KEY || "change-moi"; // même clé que dans bp/scripts/config.js
const RANGE = Number(process.env.VOICE_RANGE) || 24; // distance max d'écoute (blocs)
const CODE_TTL_MS = 5 * 60 * 1000; // un code expire au bout de 5 min
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // session du site : 30 jours
const GAME_TIMEOUT_MS = 4000; // sans nouvelles du jeu → joueur considéré hors ligne

// Serveurs ICE (STUN gratuit Google + TURN optionnel pour les réseaux 4G/CGNAT)
const ICE = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
if (process.env.TURN_URL) {
  ICE.push({
    urls: process.env.TURN_URL.split(",").map((s) => s.trim()),
    username: process.env.TURN_USER || "",
    credential: process.env.TURN_PASS || "",
  });
}

// ───────────── État en mémoire ─────────────
const codes = new Map(); // code -> { name, exp }
const tokens = new Map(); // token -> { name, exp }
const players = new Map(); // name(lowercase) -> { name, x, y, z, dim, yaw, gameMuted, seen }
const clients = new Map(); // name(lowercase) -> ws (une seule page par joueur)
const speaking = new Set(); // names(lowercase) en train de parler
let lastGameSync = 0;

const key = (n) => String(n).toLowerCase();
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I

function newCode() {
  let c;
  do {
    c = "";
    const bytes = crypto.randomBytes(6);
    for (const b of bytes) c += ALPHABET[b % ALPHABET.length];
  } while (codes.has(c));
  return c;
}

function cleanup() {
  const now = Date.now();
  for (const [c, v] of codes) if (v.exp < now) codes.delete(c);
  for (const [t, v] of tokens) if (v.exp < now) tokens.delete(t);
  for (const [k, p] of players) if (now - p.seen > GAME_TIMEOUT_MS) players.delete(k);
}
setInterval(cleanup, 10000);

// ───────────── HTTP ─────────────
function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const INDEX = path.join(__dirname, "public", "index.html");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  // ── API appelée par le behavior pack ──
  if (url.pathname.startsWith("/api/mc/")) {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    if (!safeEqual(req.headers["x-key"] || "", MC_KEY)) return send(res, 401, { error: "bad key" });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: "bad json" });
    }

    // Synchronisation des positions (≈ 4 fois / seconde)
    if (url.pathname === "/api/mc/sync") {
      const now = Date.now();
      lastGameSync = now;
      const list = Array.isArray(body.players) ? body.players.slice(0, 200) : [];
      const online = new Set();
      for (const p of list) {
        if (!p || typeof p.name !== "string") continue;
        const k = key(p.name);
        online.add(k);
        players.set(k, {
          name: p.name.slice(0, 32),
          x: +p.x || 0,
          y: +p.y || 0,
          z: +p.z || 0,
          dim: String(p.dim || "overworld"),
          yaw: +p.yaw || 0,
          gameMuted: !!p.muted,
          seen: now,
        });
      }
      // ceux qui ne sont plus dans la liste ont quitté le jeu
      for (const k of players.keys()) if (!online.has(k)) players.delete(k);
      broadcastPositions();
      return send(res, 200, {
        linked: [...clients.keys()].filter((k) => online.has(k)).map((k) => players.get(k).name),
        speaking: [...speaking].filter((k) => online.has(k)).map((k) => players.get(k).name),
      });
    }

    // Demande d'un code de liaison (/vocal en jeu)
    if (url.pathname === "/api/mc/code") {
      if (typeof body.name !== "string" || !body.name) return send(res, 400, { error: "name" });
      for (const [c, v] of codes) if (key(v.name) === key(body.name)) codes.delete(c); // un seul code actif
      const code = newCode();
      codes.set(code, { name: body.name.slice(0, 32), exp: Date.now() + CODE_TTL_MS });
      return send(res, 200, { code, ttl: CODE_TTL_MS / 1000 });
    }

    // Déliaison (/vocal unlink en jeu) : coupe la page et invalide les sessions
    if (url.pathname === "/api/mc/unlink") {
      const k = key(body.name || "");
      for (const [t, v] of tokens) if (key(v.name) === k) tokens.delete(t);
      const ws = clients.get(k);
      if (ws) {
        wsSend(ws, { t: "unlinked" });
        ws.close();
      }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  }

  if (url.pathname === "/health") return send(res, 200, { ok: true, game: Date.now() - lastGameSync < GAME_TIMEOUT_MS });

  // ── Site ──
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    fs.readFile(INDEX, (err, data) => {
      if (err) return send(res, 500, { error: "index missing" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(data);
    });
    return;
  }
  send(res, 404, { error: "not found" });
});

// ───────────── WebSocket (navigateurs) ─────────────
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });

function wsSend(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastPositions() {
  const gameOnline = Date.now() - lastGameSync < GAME_TIMEOUT_MS;
  const all = [...players.values()];
  for (const [k, ws] of clients) {
    const me = players.get(k) || null;
    // on n'envoie que les joueurs utiles (même dimension, à portée + marge)
    const others = me
      ? all
          .filter((p) => key(p.name) !== k && p.dim === me.dim && Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z) < RANGE * 3)
          .map((p) => ({
            name: p.name,
            x: p.x,
            y: p.y,
            z: p.z,
            yaw: p.yaw,
            onSite: clients.has(key(p.name)),
            speaking: speaking.has(key(p.name)),
            muted: p.gameMuted || !!clients.get(key(p.name))?.siteMuted,
          }))
      : [];
    wsSend(ws, { t: "pos", game: gameOnline, me, players: others });
  }
}
// au cas où le jeu ne pousse rien (serveur MC éteint), on prévient quand même les pages
setInterval(() => {
  if (Date.now() - lastGameSync > GAME_TIMEOUT_MS) broadcastPositions();
}, 2000);

wss.on("connection", (ws) => {
  ws.name = null;
  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));

  const authTimer = setTimeout(() => !ws.name && ws.close(), 15000);

  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    if (!ws.name) {
      let name = null;
      let token = null;
      if (m.t === "link" && typeof m.code === "string") {
        const c = codes.get(m.code.trim().toUpperCase());
        if (!c || c.exp < Date.now()) return wsSend(ws, { t: "error", msg: "Code invalide ou expiré. Refais /vocal en jeu." });
        codes.delete(m.code.trim().toUpperCase());
        name = c.name;
        token = crypto.randomBytes(24).toString("hex");
        tokens.set(token, { name, exp: Date.now() + TOKEN_TTL_MS });
      } else if (m.t === "auth" && typeof m.token === "string") {
        const s = tokens.get(m.token);
        if (!s || s.exp < Date.now()) return wsSend(ws, { t: "error", msg: "Session expirée, relie-toi avec un nouveau code.", reset: true });
        name = s.name;
        token = m.token;
      } else return;

      clearTimeout(authTimer);
      const k = key(name);
      const old = clients.get(k);
      if (old && old !== ws) {
        wsSend(old, { t: "replaced" });
        old.close();
      }
      ws.name = name;
      ws.k = k;
      ws.siteMuted = false;
      clients.set(k, ws);
      wsSend(ws, { t: "ready", name, token, range: RANGE, ice: ICE });
      broadcastPositions();
      return;
    }

    switch (m.t) {
      case "signal": {
        // relaie offre/réponse/candidats ICE vers un autre joueur
        const target = clients.get(key(m.to || ""));
        if (target && m.data) wsSend(target, { t: "signal", from: ws.name, data: m.data });
        break;
      }
      case "speaking":
        if (m.v) speaking.add(ws.k);
        else speaking.delete(ws.k);
        break;
      case "mute":
        ws.siteMuted = !!m.v;
        break;
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (ws.k && clients.get(ws.k) === ws) {
      clients.delete(ws.k);
      speaking.delete(ws.k);
      for (const other of clients.values()) wsSend(other, { t: "left", name: ws.name });
    }
  });
});

// ping régulier pour détecter les connexions mortes (et garder Render éveillé)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 20000);

server.listen(PORT, () => console.log(`Galaxium Vocal en ligne sur le port ${PORT} (portée ${RANGE} blocs)`));
