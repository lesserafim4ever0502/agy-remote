import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { daemonDirectories } from './constants.js';
import { boolEnv, extractArg, redactInstance, safeJsonParse } from './utils.js';

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeDaemonRecord(record, source) {
  const pid = Number(record.pid || 0);
  const csrfToken = record.csrfToken || record.csrf_token || '';
  const workspaceId = record.workspaceId || record.workspace_id;
  const appDataDir = record.appDataDir || record.app_data_dir;
  const candidates = [];
  const add = (port, protocol, field) => {
    const value = Number(port || 0);
    if (value > 0) candidates.push({
      pid,
      host: '127.0.0.1',
      port: value,
      protocol,
      csrfToken,
      workspaceId,
      appDataDir,
      source: `${source}:${field}`,
      workspaceUris: [],
    });
  };
  add(record.httpsPort ?? record.https_port, 'https', 'httpsPort');
  add(record.httpPort ?? record.http_port, 'http', 'httpPort');
  // Some builds have historically served HTTP on a field named httpsPort. Transport fallback handles that.
  return candidates;
}

function readDaemonFiles() {
  const instances = [];
  for (const dir of daemonDirectories()) {
    if (!fs.existsSync(dir)) continue;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^ls_.*\.json$/i.test(name)) continue;
      const file = path.join(dir, name);
      let parsed;
      try { parsed = safeJsonParse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!parsed) continue;
      for (const instance of normalizeDaemonRecord(parsed, file)) {
        if (!instance.pid || isPidAlive(instance.pid)) instances.push(instance);
      }
    }
  }
  return instances;
}

function runPowerShell(scriptText, timeout = 10000) {
  try {
    const b64 = Buffer.from(scriptText, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], {
      encoding: 'utf8',
      timeout,
    });
    if (result.status === 0 && result.stdout && result.stdout.trim()) {
      return safeJsonParse(result.stdout.trim(), null);
    }
  } catch {}
  return null;
}

function scanProcesses() {
  const rows = [];
  if (process.platform === 'win32') {
    const script = "$procs = Get-CimInstance Win32_Process -Filter \"Name LIKE '%language_server%'\" | Select-Object ProcessId, CommandLine; $res = @(); foreach ($p in $procs) { $ports = Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort; $res += @{ pid = $p.ProcessId; command = $p.CommandLine; ports = @($ports) } }; $res | ConvertTo-Json -Compress -Depth 3";
    const parsed = runPowerShell(script, 8000);
    if (parsed) {
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item && item.pid) {
          const rawPorts = Array.isArray(item.ports) ? item.ports : (item.ports ? [item.ports] : []);
          rows.push({
            pid: Number(item.pid),
            command: item.command || '',
            ports: rawPorts.map(Number).filter((p) => p > 0),
          });
        }
      }
    }
  } else {
    const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0) {
      for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.includes('language_server')) continue;
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (match) rows.push({ pid: Number(match[1]), command: match[2], ports: [] });
      }
    }
  }
  return rows;
}

function listeningPorts(pid) {
  const ports = new Set();
  if (process.platform === 'win32') {
    const script = `Get-NetTCPConnection -OwningProcess ${Number(pid)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress`;
    const parsed = runPowerShell(script, 5000);
    if (parsed) {
      for (const port of Array.isArray(parsed) ? parsed : [parsed]) if (Number(port) > 0) ports.add(Number(port));
    }
  } else {
    const result = spawnSync('lsof', ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0) {
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.match(/:(\d+)\s+\(LISTEN\)/);
        if (match) ports.add(Number(match[1]));
      }
    }
  }
  return [...ports];
}

function processInstances() {
  const instances = [];
  for (const row of scanProcesses()) {
    const csrfToken = extractArg(row.command, 'csrf_token') || '';
    const workspaceId = extractArg(row.command, 'workspace_id');
    const appDataDir = extractArg(row.command, 'app_data_dir');
    const ideVersion = extractArg(row.command, 'override_ide_version') || '';
    const declaredHttps = Number(extractArg(row.command, 'https_server_port') || 0);
    const declaredHttp = Number(extractArg(row.command, 'http_server_port') || 0);
    const ports = new Set();
    if (declaredHttps > 0) ports.add(declaredHttps);
    if (declaredHttp > 0) ports.add(declaredHttp);
    if (Array.isArray(row.ports) && row.ports.length > 0) {
      for (const p of row.ports) ports.add(p);
    } else if (ports.size === 0) {
      for (const port of listeningPorts(row.pid)) ports.add(port);
    }
    for (const port of ports) {
      const proto = (declaredHttps > 0 && port === declaredHttps)
        ? 'https'
        : ((declaredHttp > 0 && port === declaredHttp) ? 'http' : undefined);
      instances.push({
        pid: row.pid,
        host: '127.0.0.1',
        port,
        protocol: proto,
        csrfToken,
        workspaceId,
        appDataDir,
        ideVersion: ideVersion || undefined,
        source: 'process-scan',
        workspaceUris: [],
      });
    }
  }
  return instances;
}

function manualInstance() {
  const port = Number(process.env.AGY_LS_PORT || 0);
  if (!port) return null;
  return {
    pid: 0,
    host: '127.0.0.1',
    port,
    protocol: process.env.AGY_LS_PROTOCOL === 'http' ? 'http' : 'https',
    csrfToken: process.env.AGY_LS_CSRF || '',
    workspaceUris: [],
    source: 'environment',
  };
}

function dedupe(instances) {
  const map = new Map();
  for (const instance of instances) {
    const key = `${instance.pid}:${instance.port}`;
    if (!map.has(key) || (instance.csrfToken && !map.get(key).csrfToken)) map.set(key, instance);
  }
  return [...map.values()];
}

export async function discoverLanguageServers(transport, { logger = console } = {}) {
  const forced = manualInstance();
  const probe = async (candidates) => {
    const probed = await Promise.all(dedupe(candidates).map(async (instance) => {
      try {
        const response = await transport.unary(instance, 'GetWorkspaceInfos', {}, { timeoutMs: 5000 });
        instance.workspaceUris = (response.workspaceInfos || response.workspace_infos || [])
          .map((info) => info.workspaceUri || info.workspace_uri)
          .filter(Boolean);
        instance.homeDirPath = response.homeDirPath || response.home_dir_path;
        await transport.unary(instance, 'GetAllCascadeTrajectories', { excludeSubtrajectories: false }, { timeoutMs: 5000 });
        return instance;
      } catch (error) {
        logger.debug?.(`[discovery] rejected ${JSON.stringify(redactInstance(instance))}: ${error.message}`);
        return null;
      }
    }));

    const seenPids = new Set();
    return probed.filter((instance) => {
      if (!instance) return false;
      if (instance.pid > 0 && seenPids.has(instance.pid)) return false;
      if (instance.pid > 0) seenPids.add(instance.pid);
      return true;
    });
  };

  if (forced) return probe([forced]);

  // Daemon files are fast and normally authoritative. Process scanning is a
  // slower fallback and may be permission-blocked on managed Windows systems.
  const fromDaemon = await probe(readDaemonFiles());
  if (fromDaemon.length || !boolEnv('AGY_DISCOVERY_PROCESS_SCAN', true)) return fromDaemon;
  return probe(processInstances());
}
