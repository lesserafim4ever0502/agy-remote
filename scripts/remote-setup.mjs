import { TailscaleManager } from "../apps/bridge/src/tailscale.js";
import { loadOrCreateToken } from "../apps/bridge/src/auth.js";
import { formatPairingTerminal, generatePairingQrFile } from "../apps/bridge/src/qr.js";

async function fetchPairSecret(port = 7317) {
  const { token } = loadOrCreateToken();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/pair-secret`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
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

  // Request Pair Secret from the live Bridge server process
  let secret = await fetchPairSecret(7317);
  if (!secret) {
    console.log("[*] Bridge is not currently running. Starting temporary daemon to generate pair secret...");
    // If not running, inform user or start bridge
    console.log("    Tip: Run `npm start` or `npm run remote:start` to launch the bridge, then run `npm run remote:setup`.");
    console.log("    Generating standalone pairing URL for when bridge starts with master token...");
  }

  const httpsUrl = await ts.getHttpsUrl();
  const targetBase = httpsUrl || "http://127.0.0.1:7317";
  const pairUrl = secret ? `${targetBase}/#pair=${secret}` : `${targetBase}`;

  console.log("\n--------------------------------------------------");
  console.log(`Remote HTTPS Base:  ${httpsUrl || "http://127.0.0.1:7317 (local only)"}`);
  if (secret) {
    console.log(`Pairing URL (5m):   ${pairUrl}`);
  } else {
    console.log(`Base URL:           ${pairUrl}`);
  }
  console.log("--------------------------------------------------\n");

  if (secret) {
    try {
      const qrFilePath = await generatePairingQrFile(pairUrl);
      console.log(`[✓] Pairing QR image generated at:\n    ${qrFilePath}\n`);
    } catch {}

    try {
      console.log("Scan with your mobile camera or browser:");
      console.log(await formatPairingTerminal(pairUrl));
    } catch {}
  }

  console.log("\n==================================================");
  console.log("Security: Bridge binds 127.0.0.1 only. Tailscale handles WireGuard encryption & HTTPS.");
  console.log("Ready. Start background daemon with: npm run remote:start\n");
}

main().catch((err) => {
  console.error("Fatal error during remote setup:", err);
  process.exit(1);
});
