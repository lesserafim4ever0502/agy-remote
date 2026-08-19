import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function stateDbCandidates() {
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const name of ['Antigravity IDE', 'Antigravity', 'antigravity', 'Antigravity-IDE', 'Code', 'Trae']) {
      candidates.push(path.join(appData, name, 'User', 'globalStorage', 'state.vscdb'));
    }
  } else if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    for (const name of ['Antigravity IDE', 'Antigravity', 'antigravity', 'Antigravity-IDE', 'Code', 'Trae']) {
      candidates.push(path.join(appSupport, name, 'User', 'globalStorage', 'state.vscdb'));
    }
  } else {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const name of ['Antigravity IDE', 'Antigravity', 'antigravity', 'Antigravity-IDE', 'Code', 'Trae']) {
      candidates.push(path.join(config, name, 'User', 'globalStorage', 'state.vscdb'));
    }
  }
  return candidates;
}

function findApiKeyDeep(value, depth = 0) {
  if (!value || depth > 6) return undefined;
  if (typeof value === 'string') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findApiKeyDeep(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    for (const key of ['apiKey', 'api_key']) {
      if (typeof value[key] === 'string' && value[key]) return value[key];
    }
    for (const nested of Object.values(value)) {
      const found = findApiKeyDeep(nested, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function readAntigravityApiKey() {
  if (process.env.AGY_API_KEY) return process.env.AGY_API_KEY;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return undefined;
  }

  for (const dbPath of stateDbCandidates()) {
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus' LIMIT 1").get();
      if (!row?.value) continue;
      const parsed = JSON.parse(String(row.value));
      const key = findApiKeyDeep(parsed);
      if (key) return key;
    } catch {
      // Antigravity may have the DB locked or the schema/key may have changed.
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return undefined;
}
