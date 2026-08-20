import QRCode from "qrcode";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export async function formatPairingTerminal(url) {
  try {
    return await QRCode.toString(url, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "M",
    });
  } catch (err) {
    return null;
  }
}

export async function generateQrDataUrl(url) {
  try {
    return await QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 2,
    });
  } catch {
    return null;
  }
}

export async function generatePairingQrFile(url, outPath) {
  const file = outPath || path.join(process.env.AGY_REMOTE_STATE_DIR || path.join(os.homedir(), ".agy-remote"), "pairing-qr.png");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await QRCode.toFile(file, url, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
  });
  return file;
}
