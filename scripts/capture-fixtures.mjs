import fs from "node:fs";
import path from "node:path";
import { createAgyClient } from "../packages/agy-ls/src/index.js";

const DENYLIST_KEYS = new Set([
  "csrftoken", "csrf_token", "apikey", "api_key", "authorization",
  "accesstoken", "access_token", "refreshtoken", "refresh_token",
  "oauthtoken", "oauth_token", "sessiontoken", "session_token",
  "cookie", "email", "accountid", "account_id", "secret", "password",
  "bearer", "auth_token", "client_secret", "x-codeium-csrf-token"
]);

function scrubValue(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, "00000000-0000-0000-0000-000000000000")
    .replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/gi, "user@example.com")
    .replace(/file:\/\/\/[^\s"',]+/gi, "file:///C:/test/workspace")
    .replace(/([a-zA-Z]:)[\\\/][^"',\s]*/gi, "C:/test/workspace")
    .replace(/\/(home|Users|mnt\/[a-z])[\\\/][^"',\s]*/gi, "/home/test/workspace");
}

function sanitize(obj) {
  const json = JSON.stringify(obj, (key, value) => {
    if (DENYLIST_KEYS.has(key.toLowerCase())) return "***REDACTED***";
    if (typeof value === "string") return scrubValue(value);
    return value;
  }, 2);
  return JSON.parse(json);
}

const agy = createAgyClient({ logger: { debug() {}, info() {}, warn() {}, error: console.error } });
await agy.router.refresh();
const inst = agy.router.instances[0];

const outDir = path.join("fixtures", "v2.8.1", "captures");
fs.mkdirSync(outDir, { recursive: true });

const modelData = await agy.models.raw().catch(() => ({}));
fs.writeFileSync(path.join(outDir, "model-config-raw.json"), JSON.stringify(sanitize(modelData), null, 2), "utf8");

const workspaceData = await agy.transport.unary(inst, "GetWorkspaceInfos", {}).catch(() => ({}));
fs.writeFileSync(path.join(outDir, "workspace-infos-raw.json"), JSON.stringify(sanitize(workspaceData), null, 2), "utf8");

const terminalsData = await agy.transport.unary(inst, "ListTerminals", { conversationId: "" }).catch(() => ({}));
fs.writeFileSync(path.join(outDir, "list-terminals-raw.json"), JSON.stringify(sanitize(terminalsData), null, 2), "utf8");

const pagesData = await agy.transport.unary(inst, "ListPages", {}).catch(() => ({}));
fs.writeFileSync(path.join(outDir, "list-pages-raw.json"), JSON.stringify(sanitize(pagesData), null, 2), "utf8");
