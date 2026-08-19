import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { boolEnv } from '../../../packages/agy-ls/src/utils.js';

export function loadOrCreateToken() {
  if (process.env.AGY_REMOTE_TOKEN) return { token: process.env.AGY_REMOTE_TOKEN, source: 'environment' };
  const dir = path.join(os.homedir(), '.agy-remote');
  const file = path.join(dir, 'token');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) return { token: fs.readFileSync(file, 'utf8').trim(), source: file };
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return { token, source: file };
}

export function requestToken(req, url) {
  const auth = req.headers?.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.headers?.['x-agy-token']) return String(req.headers['x-agy-token']);
  return url?.searchParams?.get('token') || '';
}

const pairingSecrets = new Map();
const sessionTokens = new Map();

export function createPairingSecret(ttlMs = 5 * 60 * 1000) {
  const secret = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  pairingSecrets.set(secret, {
    createdAt: now,
    expiresAt: now + ttlMs,
  });
  return { secret, expiresAt: now + ttlMs };
}

export function exchangePairingSecret(secret, deviceLabel = 'Mobile Device') {
  if (!secret || typeof secret !== 'string') throw new Error('Pairing secret is required');
  const entry = pairingSecrets.get(secret);
  if (!entry) throw new Error('Invalid or expired pairing secret');
  pairingSecrets.delete(secret); // Single use immediately consumed

  if (Date.now() > entry.expiresAt) throw new Error('Pairing secret has expired');

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    token: sessionToken,
    deviceLabel,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  sessionTokens.set(sessionToken, sessionData);
  return sessionData;
}

export function isAuthorized(req, url, masterToken) {
  const actual = requestToken(req, url);
  if (!actual) return false;

  // 1. Check if it is a valid active device session
  const session = sessionTokens.get(actual);
  if (session) {
    session.lastUsedAt = Date.now();
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

export function revokeSession(token) {
  return sessionTokens.delete(token);
}

export function assertSafeBind(host) {
  if (boolEnv('AGY_REMOTE_ALLOW_PUBLIC_BIND', false)) return;
  const value = String(host || '').toLowerCase();
  if (['localhost', '127.0.0.1', '::1'].includes(value)) return;
  if (['0.0.0.0', '::'].includes(value)) throw new Error(`Refusing wildcard bind ${host}; set AGY_REMOTE_ALLOW_PUBLIC_BIND=1 only if intentional`);
  if (net.isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    if (parts[0] === 10) return;
    if (parts[0] === 192 && parts[1] === 168) return;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return; // Tailscale CGNAT
  }
  throw new Error(`Refusing non-private bind host ${host}; prefer loopback/private/Tailscale`);
}
