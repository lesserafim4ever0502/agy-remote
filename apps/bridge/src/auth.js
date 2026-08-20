import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { boolEnv } from "../../../packages/agy-ls/src/utils.js";

const INACTIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const ABSOLUTE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days max

export function getStorageDir() {
  const dir = process.env.AGY_REMOTE_STATE_DIR || path.join(os.homedir(), ".agy-remote");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function loadOrCreateToken() {
  if (process.env.AGY_REMOTE_TOKEN) return { token: process.env.AGY_REMOTE_TOKEN, source: "environment" };
  const dir = getStorageDir();
  const file = path.join(dir, "token");
  if (fs.existsSync(file)) {
    try {
      const content = fs.readFileSync(file, "utf8").trim();
      if (content) return { token: content, source: file };
    } catch {}
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return { token, source: file };
}

export function hashToken(token) {
  if (!token || typeof token !== "string") return "";
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function requestToken(req) {
  const auth = req?.headers?.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (req?.headers?.["x-agy-token"]) return String(req.headers["x-agy-token"]);
  return ""; // STRICT: Query parameter tokens are completely disabled
}

// ----------------------------------------------------
// Pairing & Device Sessions (Hashed + Persisted)
// ----------------------------------------------------
const pairingSecrets = new Map(); // secret -> { createdAt, expiresAt }
const sessions = new Map(); // tokenHash -> sessionRecord
let sessionsLoaded = false;
let sessionsDirty = false;
let flushTimer = null;

export function _resetSessionsForTest() {
  sessions.clear();
  pairingSecrets.clear();
  sessionsLoaded = false;
  sessionsDirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function loadSessions() {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  const file = path.join(getStorageDir(), "sessions.json");
  if (fs.existsSync(file)) {
    try {
      const list = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(list)) {
        const now = Date.now();
        for (const s of list) {
          if (s.tokenHash && !s.revoked && now < s.expiresAt) {
            sessions.set(s.tokenHash, s);
          }
        }
      }
    } catch {}
  }
}

export function flushSessionsSync() {
  if (!sessionsDirty && sessionsLoaded) return;
  const dir = getStorageDir();
  const file = path.join(dir, "sessions.json");
  const tmp = path.join(dir, "sessions.json.tmp");
  try {
    const list = [...sessions.values()];
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    sessionsDirty = false;
  } catch {}
}

function scheduleSessionsFlush() {
  sessionsDirty = true;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushSessionsSync();
    }, 10000);
  }
}

export function createPairingSecret(ttlMs = 5 * 60 * 1000) {
  const secret = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  pairingSecrets.set(secret, {
    createdAt: now,
    expiresAt: now + ttlMs,
  });
  return { secret, expiresAt: now + ttlMs };
}

export function exchangePairingSecret(secret, deviceLabel = "Mobile Device") {
  if (!secret || typeof secret !== "string") throw new Error("Pairing secret is required");
  const entry = pairingSecrets.get(secret);
  if (!entry) throw new Error("Invalid or expired pairing secret");
  pairingSecrets.delete(secret); // Single use immediately consumed

  if (Date.now() > entry.expiresAt) throw new Error("Pairing secret has expired");

  loadSessions();
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const now = Date.now();
  const id = `dev_${crypto.randomBytes(8).toString("hex")}`;

  const session = {
    id,
    label: String(deviceLabel || "Mobile Device").slice(0, 60),
    tokenHash,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: Math.min(now + INACTIVE_TTL_MS, now + ABSOLUTE_TTL_MS),
    revoked: false,
  };

  sessions.set(tokenHash, session);
  sessionsDirty = true;
  flushSessionsSync();

  return {
    token: rawToken,
    id: session.id,
    label: session.label,
    expiresAt: session.expiresAt,
  };
}

export function isAuthorized(req, url, masterToken) {
  const actual = requestToken(req);
  if (!actual) return false;

  loadSessions();
  const actualHash = hashToken(actual);
  const session = sessions.get(actualHash);

  if (session && !session.revoked) {
    const now = Date.now();
    if (now > session.expiresAt || (now - session.lastUsedAt > INACTIVE_TTL_MS)) {
      sessions.delete(actualHash);
      sessionsDirty = true;
      scheduleSessionsFlush();
      return false;
    }
    session.lastUsedAt = now;
    session.expiresAt = Math.min(now + INACTIVE_TTL_MS, session.createdAt + ABSOLUTE_TTL_MS);
    scheduleSessionsFlush();
    return true;
  }

  // 2. Check master token with constant-time equality
  if (actual.length !== masterToken.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(masterToken));
  } catch {
    return false;
  }
}

export function listSessions() {
  loadSessions();
  return [...sessions.values()].map((s) => ({
    id: s.id,
    label: s.label,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    expiresAt: s.expiresAt,
  }));
}

export function revokeSession(id) {
  loadSessions();
  for (const [hash, s] of sessions.entries()) {
    if (s.id === id) {
      sessions.delete(hash);
      sessionsDirty = true;
      flushSessionsSync();
      return true;
    }
  }
  return false;
}

export function revokeAllSessions() {
  loadSessions();
  const count = sessions.size;
  sessions.clear();
  sessionsDirty = true;
  flushSessionsSync();
  return { revoked: count };
}

// ----------------------------------------------------
// WebSocket One-Time Tickets (30s single-use)
// ----------------------------------------------------
const wsTickets = new Map(); // ticket -> { createdAt, expiresAt, consumed }

export function createWsTicket(ttlMs = 30000) {
  const ticket = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  wsTickets.set(ticket, {
    createdAt: now,
    expiresAt: now + ttlMs,
    consumed: false,
  });
  return { ticket, expiresAt: now + ttlMs };
}

export function consumeWsTicket(ticket) {
  if (!ticket || typeof ticket !== "string") return false;
  const entry = wsTickets.get(ticket);
  if (!entry) return false;
  
  wsTickets.delete(ticket); // Single use immediately consumed before 101 switch

  if (entry.consumed) return false;
  if (Date.now() > entry.expiresAt) return false;

  entry.consumed = true;
  return true;
}

// ----------------------------------------------------
// Security & Host Binding
// ----------------------------------------------------
export function assertSafeBind(host) {
  if (boolEnv("AGY_REMOTE_ALLOW_NON_LOOPBACK", false)) return;
  const value = String(host || "").toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(value)) return;
  throw new Error(
    `Refusing non-loopback bind host ${host}. Agy Remote must listen on localhost only; Tailscale Serve proxies remote requests. Set AGY_REMOTE_ALLOW_NON_LOOPBACK=1 only if intentionally debugging.`
  );
}
