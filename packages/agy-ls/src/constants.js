import os from 'node:os';
import path from 'node:path';

export const SERVICE_PREFIX = 'exa.language_server_pb.LanguageServerService';

export function daemonDirectories() {
  const home = os.homedir();
  return [
    path.join(home, '.gemini', 'antigravity', 'daemon'),
    path.join(home, '.gemini', 'antigravity-ide', 'daemon'),
    path.join(home, '.gemini', 'antigravity-cli', 'daemon'),
  ];
}

export const DEFAULT_REMOTE_PORT = 7317;
export const DEFAULT_IDE_VERSION = process.env.AGY_IDE_VERSION || '2.8.1';
export const DEFAULT_MODEL = process.env.AGY_DEFAULT_MODEL || 'MODEL_PLACEHOLDER_M71';
