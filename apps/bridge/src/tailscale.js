import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function execTailscale(args, timeoutMs = 8000) {
  return execFileAsync("tailscale", args, {
    windowsHide: true,
    timeout: timeoutMs,
  }).catch((err) => {
    return { stdout: "", stderr: err.message, error: err };
  });
}

export class TailscaleManager {
  async detectInstalled() {
    const res = await execTailscale(["version"]);
    return !res.error && res.stdout.trim().length > 0;
  }

  async status() {
    const res = await execTailscale(["status", "--json"]);
    if (res.error || !res.stdout) {
      return { ok: false, error: res.stderr || "Tailscale status unavailable" };
    }

    try {
      const json = JSON.parse(res.stdout);
      const self = json.Self || {};
      const dnsName = (self.DNSName || self.HostName || "").replace(/\.$/, "");
      const ips = self.TailscaleIPs || [];
      const ipv4 = ips.find((ip) => ip.includes(".")) || null;
      const online = Boolean(self.Online);
      const tailnet = json.MagicDNSSuffix || null;

      return {
        ok: true,
        online,
        dnsName,
        ipv4,
        tailnet,
        nodeKey: self.PublicKey || null,
        raw: json,
      };
    } catch (e) {
      return { ok: false, error: `Failed to parse Tailscale status JSON: ${e.message}` };
    }
  }

  async serveStatus() {
    const res = await execTailscale(["serve", "status", "--json"]);
    if (res.error || !res.stdout) {
      return { ok: false, active: false, error: res.stderr || "Serve status unavailable" };
    }

    try {
      const json = JSON.parse(res.stdout);
      const active = Boolean(json.Web || json.TCP || (Object.keys(json).length > 0 && !json.empty));
      return { ok: true, active, raw: json };
    } catch {
      // Non-JSON or empty
      const active = res.stdout.includes("http://127.0.0.1") || res.stdout.includes("https://");
      return { ok: true, active, raw: res.stdout };
    }
  }

  async enableServe(port = 7317) {
    // Official command: tailscale serve --bg 7317 (or tailscale serve --bg localhost:7317)
    const res = await execTailscale(["serve", "--bg", String(port)]);
    if (res.error) {
      return { ok: false, error: res.stderr || res.error.message };
    }
    return { ok: true };
  }

  async disableServe() {
    // Official command: tailscale serve reset
    const res = await execTailscale(["serve", "reset"]);
    if (res.error) {
      return { ok: false, error: res.stderr || res.error.message };
    }
    return { ok: true };
  }

  async getHttpsUrl() {
    const st = await this.status();
    if (!st.ok || !st.dnsName) return null;
    return `https://${st.dnsName}`;
  }

  async health() {
    const installed = await this.detectInstalled();
    if (!installed) {
      return {
        installed: false,
        connected: false,
        dnsName: null,
        serveEnabled: false,
        httpsUrl: null,
        status: "BLOCKED",
        message: "Tailscale CLI is not installed or not in PATH.",
      };
    }

    const st = await this.status();
    if (!st.ok || !st.online) {
      return {
        installed: true,
        connected: false,
        dnsName: st.dnsName || null,
        serveEnabled: false,
        httpsUrl: null,
        status: "DEGRADED",
        message: st.error || "Tailscale is offline or not logged in.",
      };
    }

    const serve = await this.serveStatus();
    const httpsUrl = st.dnsName ? `https://${st.dnsName}` : null;

    return {
      installed: true,
      connected: true,
      dnsName: st.dnsName,
      ipv4: st.ipv4,
      serveEnabled: serve.active,
      httpsUrl,
      status: serve.active ? "OK" : "DEGRADED",
      message: serve.active
        ? `Serving HTTPS at ${httpsUrl}`
        : "Tailscale connected, but Tailscale Serve is not enabled. Run `npm run remote:setup`.",
    };
  }
}
