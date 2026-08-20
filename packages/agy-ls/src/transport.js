import http from 'node:http';
import https from 'node:https';
import { SERVICE_PREFIX } from './constants.js';

export class RpcError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RpcError';
    Object.assign(this, details);
  }
}

function protocolModule(protocol) {
  return protocol === 'https' ? https : http;
}

export function buildConnectEnvelope(value, flags = 0) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt8(flags, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

export function parseConnectEnvelopes(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const flags = buffer.readUInt8(offset);
    const length = buffer.readUInt32BE(offset + 1);
    if (buffer.length - offset < 5 + length) break;
    const payload = buffer.subarray(offset + 5, offset + 5 + length);
    let json;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch (error) {
      throw new RpcError('Invalid Connect JSON frame', { cause: error, flags });
    }
    messages.push({ flags, value: json });
    offset += 5 + length;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

export class ConnectTransport {
  constructor({ timeoutMs = 2500, logger = console } = {}) {
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  async unary(instance, method, body = {}, { timeoutMs = this.timeoutMs } = {}) {
    const protocols = instance.protocol ? [instance.protocol] : ['http', 'https'];
    let lastError;
    for (const protocol of protocols) {
      try {
        const value = await this.#unaryProtocol(instance, protocol, method, body, timeoutMs);
        instance.protocol = protocol;
        return value;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  #unaryProtocol(instance, protocol, method, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const request = protocolModule(protocol).request({
        hostname: instance.host || '127.0.0.1',
        port: instance.port,
        path: `/${SERVICE_PREFIX}/${method}`,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': instance.csrfToken || '',
          'content-length': payload.length,
        },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          if (text) {
            try { parsed = JSON.parse(text); }
            catch { parsed = { raw: text }; }
          }
          if ((response.statusCode || 500) >= 400) {
            reject(new RpcError(`RPC ${method} failed with HTTP ${response.statusCode}`, {
              statusCode: response.statusCode,
              response: parsed,
              method,
              protocol,
            }));
            return;
          }
          resolve(parsed);
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`RPC ${method} timed out`)));
      request.on('error', (error) => reject(new RpcError(`RPC ${method} transport error: ${error.message}`, { cause: error, method, protocol })));
      request.end(payload);
    });
  }

  stream(instance, method, body, handlers = {}) {
    const controller = {
      aborted: false,
      request: null,
      abort() {
        this.aborted = true;
        this.request?.destroy();
      },
    };

    const start = (protocols, index = 0) => {
      if (controller.aborted) return;
      const protocol = protocols[index];
      const envelope = buildConnectEnvelope(body);
      const request = protocolModule(protocol).request({
        hostname: instance.host || '127.0.0.1',
        port: instance.port,
        path: `/${SERVICE_PREFIX}/${method}`,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'content-type': 'application/connect+json',
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': instance.csrfToken || '',
          'content-length': envelope.length,
        },
      }, (response) => {
        if ((response.statusCode || 500) >= 400) {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const error = new RpcError(`Stream ${method} failed with HTTP ${response.statusCode}`, {
              response: Buffer.concat(chunks).toString('utf8'),
              statusCode: response.statusCode,
            });
            if (index + 1 < protocols.length && !controller.aborted) start(protocols, index + 1);
            else handlers.onError?.(error);
          });
          return;
        }
        instance.protocol = protocol;
        handlers.onOpen?.();
        let buffer = Buffer.alloc(0);
        response.on('data', (chunk) => {
          if (controller.aborted) return;
          buffer = Buffer.concat([buffer, chunk]);
          let parsed;
          try { parsed = parseConnectEnvelopes(buffer); }
          catch (error) { handlers.onError?.(error); controller.abort(); return; }
          buffer = Buffer.from(parsed.remaining);
          for (const frame of parsed.messages) {
            if ((frame.flags & 0x01) !== 0) {
              handlers.onError?.(new RpcError('Compressed Connect frame received; compression is not implemented'));
              controller.abort();
              return;
            }
            if ((frame.flags & 0x02) !== 0) {
              if (frame.value?.error) handlers.onError?.(new RpcError(frame.value.error.message || 'Connect stream ended with error', { response: frame.value }));
              handlers.onEnd?.(frame.value);
              continue;
            }
            handlers.onMessage?.(frame.value);
          }
        });
        response.on('end', () => !controller.aborted && handlers.onEnd?.());
        response.on('error', (error) => !controller.aborted && handlers.onError?.(error));
      });
      controller.request = request;
      request.on('error', (error) => {
        if (controller.aborted) return;
        if (index + 1 < protocols.length) start(protocols, index + 1);
        else handlers.onError?.(new RpcError(`Stream ${method} transport error: ${error.message}`, { cause: error }));
      });
      request.end(envelope);
    };

    const protocols = instance.protocol ? [instance.protocol] : ['http', 'https'];
    start(protocols);
    return controller;
  }
}
