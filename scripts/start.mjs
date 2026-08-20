import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { TailscaleManager } from "../apps/bridge/src/tailscale.js";
import { loadOrCreateToken, createPairingSecret } from "../apps/bridge/src/auth.js";
import { formatPairingTerminal, generatePairingQrFile } from "../apps/bridge/src/qr.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal && !net.address.startsWith("169.254")) {
        return net.address;
      }
    }
  }
  return null;
}

async function main() {
  console.log("\n==================================================");
  console.log("          AGY REMOTE - UNIFIED LAUNCHER");
  console.log("==================================================\n");

  const ts = new TailscaleManager();
  const tsInstalled = await ts.detectInstalled();
  const tsStatus = tsInstalled ? await ts.status() : { ok: false, online: false };
  const lanIp = getLanIp();

  let host = "127.0.0.1";
  let targetBase = "http://127.0.0.1:7317";
  let modeName = "Localhost Only";

  if (tsInstalled && tsStatus.online) {
    console.log(`[✓] Tailscale connected: ${tsStatus.dnsName || "local"}`);
    const serveRes = await ts.enableServe(7317);
    if (serveRes.ok) {
      console.log("[✓] Tailscale HTTPS Serve active (--bg 7317).");
    }
    const httpsUrl = await ts.getHttpsUrl();
    if (httpsUrl) {
      targetBase = httpsUrl;
      modeName = "Tailscale HTTPS (Zero-Config WAN/5G)";
    }
  } else {
    // Tailscale not active: enable LAN Wi-Fi Remote mode
    host = "0.0.0.0";
    process.env.AGY_REMOTE_ALLOW_NON_LOOPBACK = "1";
    process.env.AGY_REMOTE_HOST = "0.0.0.0";
    if (lanIp) {
      targetBase = `http://${lanIp}:7317`;
      modeName = `LAN Wi-Fi Remote (${lanIp})`;
    }
    console.log(`[*] Tailscale not detected/online. LAN Remote mode activated.`);
  }

  // Set environment variables for child Bridge process
  process.env.AGY_REMOTE_HOST = host;
  process.env.AGY_REMOTE_PORT = "7317";

  // Import and start Bridge server directly
  const { server } = await import("../apps/bridge/src/server.js");

  server.listen(7317, host, async () => {
    const { secret } = createPairingSecret();
    const pairUrl = `${targetBase}/#pair=${secret}`;

    const qrPngPath = path.join(root, "pairing-qr.png");
    try {
      await generatePairingQrFile(pairUrl, qrPngPath);
    } catch {}

    // Copy to artifact directory if it exists
    const artifactQr = "C:\\Users\\ljr13\\.gemini\\antigravity\\brain\\fdf60586-ca07-4bdd-98a4-eca84f483a63\\pairing-qr.png";
    try {
      if (fs.existsSync(path.dirname(artifactQr))) {
        fs.copyFileSync(qrPngPath, artifactQr);
      }
    } catch {}

    console.log("\n--------------------------------------------------");
    console.log(`Network Mode:       ${modeName}`);
    console.log(`Local Access:       http://127.0.0.1:7317`);
    if (lanIp && host === "0.0.0.0") {
      console.log(`LAN Wi-Fi Access:   http://${lanIp}:7317`);
    }
    console.log(`Pairing URL (5m):   ${pairUrl}`);
    console.log(`QR Code File:       ${qrPngPath}`);
    console.log("--------------------------------------------------\n");

    try {
      console.log("Scan with your phone to pair (One-Time Pairing):");
      console.log(await formatPairingTerminal(pairUrl));
    } catch {}

    console.log("==================================================");
    console.log("Ready! Service is running. Press Ctrl+C to stop.\n");
  });
}

main().catch((err) => {
  console.error("Launcher error:", err);
  process.exit(1);
});
