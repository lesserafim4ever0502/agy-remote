import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import webpush from "web-push";

let vapidKeys = null;
const subscriptions = new Map(); // endpoint -> subscriptionObj

function getStorageDir() {
  const dir = process.env.AGY_REMOTE_STATE_DIR || path.join(os.homedir(), ".agy-remote");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function initWebPush() {
  const dir = getStorageDir();
  const vapidFile = path.join(dir, "vapid.json");
  const subFile = path.join(dir, "subscriptions.json");

  // 1. Load or generate VAPID keys
  if (fs.existsSync(vapidFile)) {
    try {
      vapidKeys = JSON.parse(fs.readFileSync(vapidFile, "utf8"));
    } catch {}
  }
  if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(vapidFile, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
  }

  webpush.setVapidDetails(
    "mailto:agy-remote@localhost",
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );

  // 2. Load persisted subscriptions
  if (fs.existsSync(subFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(subFile, "utf8"));
      if (Array.isArray(saved)) {
        for (const sub of saved) {
          if (sub.endpoint) subscriptions.set(sub.endpoint, sub);
        }
      }
    } catch {}
  }
}

function persistSubscriptions() {
  try {
    const subFile = path.join(getStorageDir(), "subscriptions.json");
    fs.writeFileSync(subFile, JSON.stringify([...subscriptions.values()], null, 2), { mode: 0o600 });
  } catch {}
}

export function getVapidPublicKey() {
  if (!vapidKeys) initWebPush();
  return vapidKeys.publicKey;
}

export function saveSubscription(subscription) {
  if (!subscription || !subscription.endpoint) throw new Error("Invalid push subscription");
  subscriptions.set(subscription.endpoint, subscription);
  persistSubscriptions();
  return { ok: true, total: subscriptions.size };
}

export function removeSubscription(endpoint) {
  const deleted = subscriptions.delete(endpoint);
  if (deleted) persistSubscriptions();
  return { ok: true, deleted };
}

export async function sendPushNotification({ title, body, data } = {}) {
  if (!vapidKeys) initWebPush();
  if (subscriptions.size === 0) return { sent: 0, failed: 0 };

  const payload = JSON.stringify({
    title: title || "Antigravity Remote",
    body: body || "Action required",
    data: data || { url: "/" },
  });

  const deadEndpoints = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    [...subscriptions.values()].map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (err) {
        failed++;
        if (err.statusCode === 404 || err.statusCode === 410) {
          deadEndpoints.push(sub.endpoint);
        }
      }
    })
  );

  for (const endpoint of deadEndpoints) {
    subscriptions.delete(endpoint);
  }
  if (deadEndpoints.length > 0) persistSubscriptions();

  return { sent, failed, total: subscriptions.size };
}
