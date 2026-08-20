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

  let httpsUrl = null;
  if (!installed) {
    console.warn("[!] Tailscale CLI is not installed or not in PATH.");
    console.warn("    To access remotely over 5G/WAN without port forwarding, install Tailscale:");
    console.warn("    https://tailscale.com/download (then log in and rerun `npm run remote:setup`)");
    console.warn("    Proceeding in Localhost mode...\n");
  } else {
    console.log("[✓] Tailscale CLI detected.");
    const status = await ts.status();
    if (!status.ok || !status.online) {
      console.warn("[!] Tailscale is offline or not logged in.");
      console.warn("    Run `tailscale up` to connect to your tailnet.\n");
    } else {
      console.log(`[✓] Tailscale connected. Node: ${status.dnsName || "local"}`);
      console.log("[*] Configuring Tailscale HTTPS Serve for port 7317...");
      const serveRes = await ts.enableServe(7317);
      if (!serveRes.ok) {
        console.warn(`[!] Tailscale Serve note: ${serveRes.error}`);
      } else {
        console.log("[✓] Tailscale Serve configured in background (--bg 7317).");
      }
      httpsUrl = await ts.getHttpsUrl();
    }
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

  const targetBase = httpsUrl || "http://127.0.0.1:7317";
  const pairUrl = `${targetBase}/#pair=${secret}`;

  console.log("\n--------------------------------------------------");
  console.log(`Access Base:        ${targetBase}`);
  console.log(`Pairing URL (5m):   ${pairUrl}`);
  console.log("--------------------------------------------------\n");

  const qrFilePath = path.join(process.cwd(), "pairing-qr.png");
  try {
    await generatePairingQrFile(pairUrl, qrFilePath);
    console.log(`[✓] Pairing QR image generated at:\n    ${qrFilePath}\n`);
  } catch {}

  try {
    console.log("Scan with your mobile camera or browser (One-Time Pairing):");
    console.log(await formatPairingTerminal(pairUrl));
  } catch {}

  console.log("\n==================================================");
  console.log("Security: Bridge binds 127.0.0.1 only.");
  if (httpsUrl) {
    console.log("Tailscale handles WireGuard encryption & HTTPS certificates.");
  }
  console.log("Setup complete! Your remote PWA is ready for acceptance.\n");
}

main().catch((err) => {
  console.error("Fatal error during remote setup:", err);
  process.exit(1);
});
