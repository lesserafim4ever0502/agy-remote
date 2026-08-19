import { fileURLToPath, pathToFileURL } from 'node:url';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

export function entriesLike(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => [entry.key, entry.value]);
  }
  if (typeof value === 'object') return Object.entries(value);
  return [];
}

export function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

export function fileUriToPath(uri) {
  if (!uri) return '';
  if (!String(uri).startsWith('file:')) return String(uri);
  try {
    return fileURLToPath(uri);
  } catch {
    return decodeURIComponent(String(uri).replace(/^file:\/\//, ''));
  }
}

export function pathToFileUri(value) {
  if (!value) return '';
  if (String(value).startsWith('file:')) return String(value);
  return pathToFileURL(String(value)).href;
}

export function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

export function redactInstance(instance) {
  return {
    pid: instance.pid,
    port: instance.port,
    protocol: instance.protocol,
    workspaceId: instance.workspaceId,
    workspaceUris: instance.workspaceUris || [],
    source: instance.source,
  };
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function extractArg(commandLine, name) {
  if (!commandLine) return undefined;
  const pattern = new RegExp(`--${name}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|(\\S+))`);
  const match = String(commandLine).match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function normalizeStatus(status) {
  if (!status) return 'unknown';
  const value = String(status).toLowerCase();
  if (value.includes('running') || value.includes('busy')) return 'running';
  if (value.includes('cancel')) return 'cancelled';
  if (value.includes('error')) return 'error';
  if (value.includes('idle') || value.includes('done')) return 'idle';
  return value;
}
