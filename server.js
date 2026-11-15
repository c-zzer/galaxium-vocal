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
const prefs = new Map(); // name(lowercase) -> { cible(lowercase) | "*": volume 0-200 } réglés avec /voc
let lastGameSync = 0;

// ───── Pont Discord (programme qui tourne sur le PC, voir dossier bridge/) ─────
let bridge = null; // WebSocket du pont
const discordActive = new Map(); // name(lowercase) -> nom MC des joueurs en vocal sur Discord
const discordSpeaking = new Set();
const isLinked = (k) => clients.has(k) || discordActive.has(k);
const isSpeaking = (k) => speaking.has(k) || discordSpeaking.has(k);
const FRAME = 320; // 20 ms d'audio en 16 kHz mono (Int16)

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
          gameDeaf: !!p.deaf,
          gameLoop: !!p.loop,
          seen: now,
        });
      }
      // ceux qui ne sont plus dans la liste ont quitté le jeu
      for (const k of players.keys()) if (!online.has(k)) players.delete(k);
      broadcastPositions();
      return send(res, 200, {
        linked: [...online].filter((k) => isLinked(k)).map((k) => players.get(k).name),
        speaking: [...online].filter((k) => isSpeaking(k)).map((k) => players.get(k).name),
        muted: [...clients.entries()].filter(([k, w]) => online.has(k) && w.siteMuted).map(([k]) => players.get(k).name),
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

    // Réglages de volume faits en jeu avec /voc
    if (url.pathname === "/api/mc/prefs") {
      if (typeof body.name !== "string" || typeof body.prefs !== "object" || !body.prefs) return send(res, 400, { error: "prefs" });
      const clean = {};
      for (const [t, v] of Object.entries(body.prefs).slice(0, 300)) {
        const n = Number(v);
        if (Number.isFinite(n)) clean[String(t).toLowerCase().slice(0, 32)] = Math.max(0, Math.min(200, n));
      }
      prefs.set(key(body.name), clean);
      wsSend(clients.get(key(body.name)), { t: "prefs", v: clean });
      wsSend(bridge, { t: "prefs", name: key(body.name), v: clean });
      return send(res, 200, { ok: true });
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

  if (url.pathname === "/health") return send(res, 200, { ok: true, game: Date.now() - lastGameSync < GAME_TIMEOUT_MS, bridge: !!bridge, discord: discordActive.size });

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
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const bwss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const p = new URL(req.url, "http://x").pathname;
  const target = p === "/ws" ? wss : p === "/bridge" ? bwss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

// trame audio binaire : [type][len][nom utf8][PCM Int16 16 kHz mono]
function audioPacket(type, name, pcm) {
  const nb = Buffer.from(name, "utf8");
  return Buffer.concat([Buffer.from([type, nb.length]), nb, pcm]);
}
function parsePacket(buf) {
  if (buf.length < 2) return null;
  const n = buf[1];
  return { type: buf[0], name: buf.subarray(2, 2 + n).toString("utf8"), pcm: buf.subarray(2 + n) };
}
const near = (a, b, r) => a && b && a.dim === b.dim && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= r;

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
            discord: discordActive.has(key(p.name)),
            speaking: isSpeaking(key(p.name)),
            muted: p.gameMuted || !!clients.get(key(p.name))?.siteMuted,
          }))
      : [];
    wsSend(ws, { t: "pos", game: gameOnline, me, players: others });
    // le navigateur n'envoie son micro au serveur que si un joueur Discord est à portée
    const up = !!bridge && !!me && [...discordActive.keys()].some((dk) => near(players.get(dk), me, RANGE + 4));
    if (up !== !!ws.uplink) {
      ws.uplink = up;
      wsSend(ws, { t: "uplink", v: up });
    }
  }
  if (bridge) wsSend(bridge, { t: "pos", range: RANGE, players: all });
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

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      // micro d'un joueur du site → pont Discord
      if (ws.name && ws.uplink && bridge && !ws.siteMuted && raw.length >= 2 && raw[0] === 2) {
        const me = players.get(ws.k);
        if (me && !me.gameMuted) bridge.send(audioPacket(2, ws.name, raw.subarray(1)));
      }
      return;
    }
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
      if (prefs.has(k)) wsSend(ws, { t: "prefs", v: prefs.get(k) });
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

// ───────────── Pont Discord ─────────────
bwss.on("connection", (ws) => {
  ws.ok = false;
  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));
  const t = setTimeout(() => !ws.ok && ws.close(), 10000);
  ws.on("message", (raw, isBinary) => {
    if (!ws.ok) {
      let m;
      try { m = JSON.parse(raw); } catch { return ws.close(); }
      if (m.t !== "hello" || !safeEqual(m.key || "", MC_KEY)) return ws.close();
      clearTimeout(t);
      ws.ok = true;
      if (bridge && bridge !== ws) bridge.close();
      bridge = ws;
      console.log("Pont Discord connecté");
      for (const [k, v] of prefs) wsSend(ws, { t: "prefs", name: k, v });
      broadcastPositions();
      return;
    }
    if (isBinary) {
      // voix d'un joueur Discord → navigateurs à portée
      const pk = parsePacket(raw);
      if (!pk || pk.type !== 1) return;
      const src = players.get(key(pk.name));
      if (!src || src.gameMuted) return;
      const out = audioPacket(1, src.name, pk.pcm);
      for (const [k, c] of clients) {
        if (c.readyState === 1 && near(players.get(k), src, RANGE + 4)) c.send(out);
      }
      return;
    }
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "active") {
      discordActive.clear();
      for (const n of m.list || []) discordActive.set(key(n), n);
      broadcastPositions();
    } else if (m.t === "speaking") {
      if (m.v) discordSpeaking.add(key(m.name || ""));
      else discordSpeaking.delete(key(m.name || ""));
    } else if (m.t === "link") {
      // /lier dans Discord : même code que /vocal
      const code = String(m.code || "").trim().toUpperCase();
      const c = codes.get(code);
      if (!c || c.exp < Date.now()) return wsSend(ws, { t: "linkerr", reqId: m.reqId, msg: "Code invalide ou expiré. Refais /vocal en jeu." });
      codes.delete(code);
      wsSend(ws, { t: "linked", reqId: m.reqId, name: c.name });
    }
  });
  ws.on("close", () => {
    if (bridge === ws) {
      bridge = null;
      discordActive.clear();
      discordSpeaking.clear();
      console.log("Pont Discord déconnecté");
      broadcastPositions();
    }
  });
});

// garde Render éveillé (le plan gratuit s'endort après 15 min sans visite)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    require("https").get(process.env.RENDER_EXTERNAL_URL + "/health", (r) => r.resume()).on("error", () => {});
  }, 10 * 60 * 1000);
}

// ping régulier pour détecter les connexions mortes (et garder Render éveillé)
setInterval(() => {
  for (const ws of [...wss.clients, ...bwss.clients]) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 20000);

server.listen(PORT, () => console.log(`Galaxium Vocal en ligne sur le port ${PORT} (portée ${RANGE} blocs)`));
