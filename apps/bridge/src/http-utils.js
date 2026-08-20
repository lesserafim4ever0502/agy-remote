export async function readJson(req, { limit = 2 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

export function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

export function sendError(res, error) {
  const errObj = typeof error === "object" && error !== null ? error : new Error(String(error));
  const status = Number(errObj.statusCode || errObj.status || 500);
  const errType =
    status === 404
      ? "not_found"
      : status === 400
      ? "bad_request"
      : status === 413
      ? "payload_too_large"
      : status === 401
      ? "unauthorized"
      : "internal_error";
  sendJson(res, status, { error: errType, message: errObj.message || "Unknown error" });
}
