import QRCode from "qrcode";

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
