import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TailscaleManager } from "../apps/bridge/src/tailscale.js";
import { loadOrCreateToken } from "../apps/bridge/src/auth.js";
import { formatPairingTerminal, generatePairingQrFile } from "../apps/bridge/src/qr.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function isBridgeRunning(port = 7317) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/ping`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startBridgeDaemon() {
  return new Promise((resolve) => {
    const ps = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", "scripts/start-background.ps1"], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    });
    ps.on("close", () => resolve());
    ps.on("error", () => resolve());
  });
}

async function fetchPairSecret(port = 7317) {
  const { token } = loadOrCreateToken();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/pair-secret`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);

  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data.secret || null;
}

async function main() {
  console.log("\n==================================================");
  console.log("   AGY REMOTE - TAILSCALE REMOTE SETUP");
  console.log("==================================================\n");

  const ts = new TailscaleManager();
  const installed = await ts.detectInstalled();

  if (!installed) {
    console.error("[!] Tailscale CLI is not installed or not in PATH.");
    console.error("    Please install Tailscale from https://tailscale.com/download");
    console.error("    After installation and login, rerun: npm run remote:setup\n");
    process.exit(1);
  }
  console.log("[✓] Tailscale CLI detected.");

  const status = await ts.status();
  if (!status.ok || !status.online) {
    console.error("[!] Tailscale is offline or not logged in.");
    console.error("    Please run `tailscale up` or log into your Tailscale client.");
    console.error("    After logging in, rerun: npm run remote:setup\n");
    process.exit(1);
  }
  console.log(`[✓] Tailscale connected. Node: ${status.dnsName || "local"}`);

  console.log("[*] Configuring Tailscale HTTPS Serve for port 7317...");
  const serveRes = await ts.enableServe(7317);
  if (!serveRes.ok) {
    console.warn(`[!] Note on Tailscale Serve: ${serveRes.error}`);
    console.warn("    If this is your first time enabling HTTPS, Tailscale may require web authorization.");
    console.warn("    Run: `tailscale serve --bg 7317` and follow the authorization prompt.");
  } else {
    console.log("[✓] Tailscale Serve configured in background (--bg 7317).");
  }

  // Ensure Bridge is running
  let running = await isBridgeRunning(7317);
  if (!running) {
    console.log("[*] Bridge is not running. Automatically starting background daemon...");
    await startBridgeDaemon();
    for (let i = 0; i < 20; i++) {
      await wait(300);
      if (await isBridgeRunning(7317)) {
        running = true;
        break;
      }
    }
  }

  if (!running) {
    console.error("[!] Failed to start or reach Agy Remote bridge daemon on 127.0.0.1:7317.");
    console.error("    Please check agy-remote.err.log or run `npm start` manually.\n");
    process.exit(1);
  }
  console.log("[✓] Agy Remote Bridge daemon is active on 127.0.0.1:7317.");

  const secret = await fetchPairSecret(7317);
  if (!secret) {
    console.error("[!] Failed to obtain pairing secret from live Bridge process.");
    process.exit(1);
  }

  const httpsUrl = await ts.getHttpsUrl();
  const targetBase = httpsUrl || "http://127.0.0.1:7317";
  const pairUrl = `${targetBase}/#pair=${secret}`;

  console.log("\n--------------------------------------------------");
  console.log(`Remote HTTPS Base:  ${httpsUrl || "http://127.0.0.1:7317 (local only)"}`);
  console.log(`Pairing URL (5m):   ${pairUrl}`);
  console.log("--------------------------------------------------\n");

  try {
    const qrFilePath = await generatePairingQrFile(pairUrl);
    console.log(`[✓] Pairing QR image generated at:\n    ${qrFilePath}\n`);
  } catch {}

  try {
    console.log("Scan with your mobile camera or browser (One-Time Pairing):");
    console.log(await formatPairingTerminal(pairUrl));
  } catch {}

  console.log("\n==================================================");
  console.log("Security: Bridge binds 127.0.0.1 only. Tailscale handles WireGuard encryption & HTTPS.");
  console.log("Setup complete! Your remote PWA is ready for daily use.\n");
}

main().catch((err) => {
  console.error("Fatal error during remote setup:", err);
  process.exit(1);
});
