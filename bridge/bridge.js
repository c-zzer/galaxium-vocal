// Galaxium Vocal — pont Discord ↔ jeu ↔ site (tourne sur le PC)
//
//  Discord (bots)  ⇄  ce programme  ⇄  serveur Render (hub)  ⇄  site + plugin Minecraft
//
//  • Un bot principal surveille le salon « ➕ Rejoindre le vocal » du serveur Discord.
//  • Quand quelqu'un le rejoint : un salon perso est créé, la personne y est déplacée,
//    et un bot libre de la réserve y entre avec le pseudo Minecraft du joueur.
//  • Le bot écoute ton micro, l'envoie aux joueurs proches (site + Discord),
//    et te joue un mélange des joueurs proches avec le volume selon la distance.
//  • Quand tu quittes ton salon, il est supprimé et le bot retourne dans la réserve.

const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");
const WebSocket = require("ws");
const prism = require("prism-media");
const {
  Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, Events, REST, Routes, SlashCommandBuilder, MessageFlags,
} = require("discord.js");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, EndBehaviorType,
  NoSubscriberBehavior, VoiceConnectionStatus, entersState,
} = require("@discordjs/voice");

const DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const TOKENS = fs.existsSync(path.join(DIR, "tokens.txt"))
  ? fs.readFileSync(path.join(DIR, "tokens.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  : [];
const LINKS_FILE = path.join(DIR, "links.json");
let links = fs.existsSync(LINKS_FILE) ? JSON.parse(fs.readFileSync(LINKS_FILE, "utf8")) : {}; // id Discord -> pseudo MC
const saveLinks = () => fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));

const key = (n) => String(n).toLowerCase();
const log = (...a) => console.log(new Date().toLocaleTimeString("fr-FR"), ...a);

// ═════════════════ connexion au hub (Render) ═════════════════
let hub = null;
let hubRetry = 0;
let positions = new Map(); // nom(min) -> { name, x, y, z, dim, yaw, gameMuted, gameDeaf }
let range = 24;
const prefs = new Map(); // écouteur(min) -> { cible(min) | "*": 0-200 }
const pendingLinks = new Map();

function hubSend(o) {
  if (hub && hub.readyState === 1) hub.send(JSON.stringify(o));
}
function packet(type, name, pcm) {
  const nb = Buffer.from(name, "utf8");
  return Buffer.concat([Buffer.from([type, nb.length]), nb, pcm]);
}

function connectHub() {
  const ws = new WebSocket(CONFIG.hubUrl);
  hub = ws;
  ws.on("open", () => {
    hubRetry = 0;
    ws.send(JSON.stringify({ t: "hello", key: CONFIG.key }));
    log("✅ Relié au serveur vocal", CONFIG.hubUrl);
    sendActive();
  });
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return onWebAudio(raw);
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "pos") {
      range = m.range || range;
      positions = new Map((m.players || []).map((p) => [key(p.name), p]));
    } else if (m.t === "prefs") {
      prefs.set(key(m.name), m.v || {});
    } else if (m.t === "linked" || m.t === "linkerr") {
      const cb = pendingLinks.get(m.reqId);
      if (cb) { pendingLinks.delete(m.reqId); cb(m); }
    }
  });
  ws.on("close", () => {
    if (hub === ws) hub = null;
    const wait = Math.min(1000 * 2 ** hubRetry++, 30000);
    log("⚠️ Serveur vocal déconnecté, nouvelle tentative dans", wait / 1000, "s");
    setTimeout(connectHub, wait);
  });
  ws.on("error", () => {});
}

// ═════════════════ audio ═════════════════
// format interne : 48 kHz mono, trames de 20 ms (960 échantillons, Float32)
const FRAME = 960;
const sessions = new Map(); // id Discord -> session

function distanceGain(d) {
  const near = 3;
  if (d <= near) return 1;
  if (d >= range) return 0;
  return Math.pow(1 - (d - near) / (range - near), 1.6);
}
function cutoff(d) {
  const t = Math.min(1, Math.max(0, (d - 3) / (range - 3)));
  return 700 * Math.pow(18000 / 700, Math.pow(1 - t, 0.7));
}

// voix d'un joueur du site (16 kHz) → files d'écoute des joueurs Discord
function onWebAudio(buf) {
  if (buf[0] !== 2) return;
  const n = buf[1];
  const name = buf.subarray(2, 2 + n).toString("utf8");
  const pcm = buf.subarray(2 + n);
  const s16 = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.length & ~1)));
  const out = new Float32Array(s16.length * 3);
  for (let i = 0; i < s16.length; i++) {
    const a = s16[i] / 32768, b = (i + 1 < s16.length ? s16[i + 1] : s16[i]) / 32768;
    out[i * 3] = a; out[i * 3 + 1] = a + (b - a) / 3; out[i * 3 + 2] = a + (2 * (b - a)) / 3;
  }
  pushToListeners(name, out);
}

function pushToListeners(srcName, frame) {
  const sk = key(srcName);
  for (const s of sessions.values()) {
    if (!s.mcName || key(s.mcName) === sk) continue;
    let q = s.queues.get(sk);
    if (!q) s.queues.set(sk, (q = []));
    q.push(frame);
    if (q.length > 6) q.splice(0, q.length - 3); // rattrape le retard
  }
}

// voix d'un joueur Discord (48 kHz stéréo décodé) → site + autres joueurs Discord
function onDiscordAudio(s, pcm) {
  if (!s.mcName || pcm.length < FRAME * 4) return;
  const me = positions.get(key(s.mcName));
  if (!me || me.gameMuted) return;
  const mono = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) mono[i] = (pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 65536;
  pushToListeners(s.mcName, mono);
  const down = Buffer.alloc((FRAME / 3) * 2);
  for (let i = 0; i < FRAME / 3; i++) {
    const v = (mono[i * 3] + mono[i * 3 + 1] + mono[i * 3 + 2]) / 3;
    down.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  if (hub && hub.readyState === 1) hub.send(packet(1, s.mcName, down));
}

// mélange personnalisé pour chaque joueur Discord, toutes les 20 ms
function mixFor(s) {
  const out = Buffer.alloc(FRAME * 4);
  const me = s.mcName && positions.get(key(s.mcName));
  const L = new Float32Array(FRAME), R = new Float32Array(FRAME);
  let any = false;
  if (me && !me.gameDeaf) {
    const pf = prefs.get(key(s.mcName)) || {};
    const master = (pf["*"] ?? 100) / 100;
    const yaw = (me.yaw * Math.PI) / 180, fx = -Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = -Math.sin(yaw);
    for (const [src, q] of s.queues) {
      const frame = q.shift();
      if (!frame) continue;
      const p = positions.get(src);
      if (!p || p.dim !== me.dim || p.gameMuted) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z);
      const g = distanceGain(d) * master * ((pf[src] ?? 100) / 100);
      if (g <= 0.001) continue;
      const dx = p.x - me.x, dz = p.z - me.z, h = Math.hypot(dx, dz) || 1;
      const pan = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / h)) * Math.min(1, h / 2);
      const back = (dx * fx + dz * fz) / h < 0 ? 0.85 : 1; // un peu plus sourd derrière
      const gl = g * back * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
      const gr = g * back * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
      // filtre passe-bas : voix étouffée au loin
      const a = 1 - Math.exp((-2 * Math.PI * cutoff(d)) / 48000);
      let y = s.lp.get(src) || 0;
      for (let i = 0; i < FRAME; i++) {
        y += a * (frame[i] - y);
        L[i] += y * gl;
        R[i] += y * gr;
      }
      s.lp.set(src, y);
      any = true;
    }
  } else {
    for (const q of s.queues.values()) q.length = 0;
  }
  if (any) {
    for (let i = 0; i < FRAME; i++) {
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), i * 4);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), i * 4 + 2);
    }
  }
  return out;
}

// horloge 20 ms corrigée de la dérive
let nextTick = performance.now();
function tick() {
  for (const s of sessions.values()) {
    if (s.out && s.out.writableLength < FRAME * 4 * 5) s.out.write(mixFor(s));
  }
  nextTick += 20;
  const now = performance.now();
  if (nextTick < now - 200) nextTick = now; // rattrapage après un gel
  setTimeout(tick, Math.max(0, nextTick - now));
}

// ═════════════════ Discord ═════════════════
const workers = []; // { client, busy, index }
let manager = null;
let guild = null;
let lobby = null;
let category = null;

const MANAGER_PERMS =
  PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles | PermissionFlagsBits.MoveMembers | PermissionFlagsBits.Connect |
  PermissionFlagsBits.Speak | PermissionFlagsBits.UseVAD | PermissionFlagsBits.ChangeNickname;
const WORKER_PERMS =
  PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.Connect |
  PermissionFlagsBits.Speak | PermissionFlagsBits.UseVAD | PermissionFlagsBits.ChangeNickname;
const invite = (id, perms) =>
  `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot%20applications.commands&permissions=${perms}`;

function sendActive() {
  hubSend({ t: "active", list: [...sessions.values()].filter((s) => s.mcName).map((s) => s.mcName) });
}

async function setupGuild() {
  const name = key(CONFIG.guildName || "");
  guild = manager.guilds.cache.find((g) => key(g.name) === name) || manager.guilds.cache.find((g) => key(g.name).includes(name)) || null;
  if (!guild) {
    log(`❌ Le bot principal n'est pas sur le serveur Discord « ${CONFIG.guildName} ». Invite-le avec :`);
    log("   " + invite(manager.user.id, MANAGER_PERMS));
    return;
  }
  await guild.channels.fetch();
  category =
    guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === CONFIG.categoryName) ||
    (await guild.channels.create({ name: CONFIG.categoryName, type: ChannelType.GuildCategory }));
  lobby =
    guild.channels.cache.find((c) => c.type === ChannelType.GuildVoice && c.name === CONFIG.lobbyName) ||
    (await guild.channels.create({ name: CONFIG.lobbyName, type: ChannelType.GuildVoice, parent: category.id }));
  // nettoie les salons perso restés d'une session précédente
  for (const c of guild.channels.cache.values()) {
    if (c.parentId === category.id && c.type === ChannelType.GuildVoice && c.id !== lobby.id && c.members.size === 0) {
      await c.delete().catch(() => {});
    }
  }
  // commandes /lier et /delier
  const cmds = [
    new SlashCommandBuilder().setName("lier").setDescription("Relie ton compte Discord à ton pseudo Minecraft (code donné par /vocal en jeu)")
      .addStringOption((o) => o.setName("code").setDescription("Le code à 6 caractères").setRequired(true)),
    new SlashCommandBuilder().setName("delier").setDescription("Retire le lien entre ton Discord et ton pseudo Minecraft"),
  ].map((c) => c.toJSON());
  await new REST().setToken(manager.token).put(Routes.applicationGuildCommands(manager.user.id, guild.id), { body: cmds });
  log(`✅ Serveur Discord « ${guild.name} » prêt — salon : ${CONFIG.lobbyName}`);
  for (const w of workers) {
    if (!w.client.guilds.cache.has(guild.id)) {
      log(`➕ Le bot ${w.client.user.tag} n'est pas sur le serveur. Invite-le :`);
      log("   " + invite(w.client.user.id, WORKER_PERMS));
    }
  }
}

function freeWorker() {
  return workers.find((w) => !w.busy && w.client.isReady() && guild && w.client.guilds.cache.has(guild.id));
}

async function startSession(member) {
  const existing = sessions.get(member.id);
  if (existing) return member.voice.setChannel(existing.channel).catch(() => {});
  const w = freeWorker();
  if (!w) {
    await lobby.send(`<@${member.id}> tous les bots vocaux sont occupés pour l'instant, réessaie dans un moment.`).catch(() => {});
    return member.voice.disconnect().catch(() => {});
  }
  w.busy = true;
  const mcName = links[member.id] || null;
  const label = mcName || member.displayName;
  const s = { member, worker: w, mcName, queues: new Map(), lp: new Map(), channel: null, connection: null, out: null };
  sessions.set(member.id, s);
  try {
    s.channel = await guild.channels.create({
      name: `🔊 ${label}`.slice(0, 100),
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] },
        { id: member.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ViewChannel] },
        { id: w.client.user.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ViewChannel] },
        { id: manager.user.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.MoveMembers] },
      ],
    });
    await member.voice.setChannel(s.channel);
    const wg = w.client.guilds.cache.get(guild.id);
    await wg.members.me.setNickname(label.slice(0, 32)).catch(() => {});
    s.connection = joinVoiceChannel({
      channelId: s.channel.id, guildId: guild.id, adapterCreator: wg.voiceAdapterCreator,
      selfDeaf: false, selfMute: false, group: w.client.user.id,
    });
    await entersState(s.connection, VoiceConnectionStatus.Ready, 20000);
    // sortie : le mélange des joueurs proches
    s.out = new PassThrough({ highWaterMark: FRAME * 4 * 3 });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.play(createAudioResource(s.out, { inputType: StreamType.Raw }));
    s.connection.subscribe(player);
    s.player = player;
    // entrée : le micro du joueur
    const rec = s.connection.receiver;
    rec.speaking.on("start", (uid) => {
      if (uid !== member.id) return;
      if (s.mcName) hubSend({ t: "speaking", name: s.mcName, v: true });
      if (rec.subscriptions.has(uid)) return;
      const opus = rec.subscribe(uid, { end: { behavior: EndBehaviorType.AfterSilence, duration: 400 } });
      const dec = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      opus.on("error", () => {});
      dec.on("error", () => {});
      opus.pipe(dec).on("data", (pcm) => onDiscordAudio(s, pcm));
    });
    rec.speaking.on("end", (uid) => {
      if (uid === member.id && s.mcName) hubSend({ t: "speaking", name: s.mcName, v: false });
    });
    s.connection.on(VoiceConnectionStatus.Disconnected, () => endSession(member.id));
    if (!mcName) {
      await s.channel.send(
        `👋 <@${member.id}> relie ton compte pour que les joueurs t'entendent : tape **/vocal** en jeu puis **/lier** ici avec le code.`
      ).catch(() => {});
    }
    log(`🎧 ${member.displayName} → salon « ${s.channel.name} » (bot ${w.client.user.tag})`);
    sendActive();
  } catch (e) {
    log("❌ Impossible d'ouvrir le salon de", member.displayName, ":", e.message);
    endSession(member.id);
  }
}

async function endSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  if (s.mcName) hubSend({ t: "speaking", name: s.mcName, v: false });
  try { s.player && s.player.stop(true); } catch {}
  try { s.connection && s.connection.destroy(); } catch {}
  try { s.out && s.out.end(); } catch {}
  if (s.channel) await s.channel.delete().catch(() => {});
  const wg = s.worker.client.guilds.cache.get(guild.id);
  if (wg) await wg.members.me.setNickname(null).catch(() => {});
  s.worker.busy = false;
  sendActive();
  log(`👋 Fin de session : ${s.member.displayName}`);
}

async function onInteraction(i) {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === "lier") {
    const code = i.options.getString("code", true);
    if (!hub || hub.readyState !== 1) return i.reply({ content: "Le serveur vocal est injoignable, réessaie dans un instant.", flags: MessageFlags.Ephemeral });
    const reqId = Math.random().toString(36).slice(2);
    const res = await new Promise((resolve) => {
      pendingLinks.set(reqId, resolve);
      hubSend({ t: "link", code, reqId });
      setTimeout(() => pendingLinks.has(reqId) && (pendingLinks.delete(reqId), resolve({ t: "linkerr", msg: "Pas de réponse du serveur." })), 8000);
    });
    if (res.t !== "linked") return i.reply({ content: "❌ " + res.msg, flags: MessageFlags.Ephemeral });
    links[i.user.id] = res.name;
    saveLinks();
    const s = sessions.get(i.user.id);
    if (s) {
      s.mcName = res.name;
      s.channel.setName(`🔊 ${res.name}`).catch(() => {});
      s.worker.client.guilds.cache.get(guild.id)?.members.me.setNickname(res.name.slice(0, 32)).catch(() => {});
      sendActive();
    }
    return i.reply({ content: `✅ Ton Discord est relié à **${res.name}**. Rejoins « ${CONFIG.lobbyName} » pour parler en jeu.`, flags: MessageFlags.Ephemeral });
  }
  if (i.commandName === "delier") {
    delete links[i.user.id];
    saveLinks();
    endSession(i.user.id);
    return i.reply({ content: "Lien supprimé.", flags: MessageFlags.Ephemeral });
  }
}

async function main() {
  if (!CONFIG.key || CONFIG.key === "change-moi") log("⚠️ Mets la clé MC_KEY dans config.json");
  connectHub();
  tick();
  if (!TOKENS.length) {
    log("❌ Aucun token dans tokens.txt (un token de bot par ligne, le premier = bot principal).");
    return;
  }
  for (const [index, token] of TOKENS.entries()) {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    const w = { client, busy: false, index };
    workers.push(w);
    client.once(Events.ClientReady, async () => {
      log(`🤖 Bot ${index === 0 ? "principal" : index + 1} connecté : ${client.user.tag}`);
      if (index === 0) {
        manager = client;
        await setupGuild().catch((e) => log("❌ Configuration Discord :", e.message));
      }
    });
    if (index === 0) {
      client.on(Events.VoiceStateUpdate, (oldS, newS) => {
        if (!guild || newS.guild.id !== guild.id || newS.member?.user.bot) return;
        if (newS.channelId && lobby && newS.channelId === lobby.id) startSession(newS.member);
        const s = sessions.get(newS.id);
        if (s && s.channel && oldS.channelId === s.channel.id && newS.channelId !== s.channel.id) endSession(newS.id);
      });
      client.on(Events.InteractionCreate, (i) => onInteraction(i).catch(() => {}));
      client.on(Events.GuildCreate, () => setupGuild().catch(() => {}));
    }
    client.login(token).catch((e) => log(`❌ Token n°${index + 1} refusé :`, e.message));
    await new Promise((r) => setTimeout(r, 1500)); // évite la limite de connexions Discord
  }
}

process.on("unhandledRejection", (e) => log("⚠️", e && e.message ? e.message : e));
async function shutdown() {
  log("Arrêt… (fermeture des salons)");
  for (const id of [...sessions.keys()]) await endSession(id).catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main();
