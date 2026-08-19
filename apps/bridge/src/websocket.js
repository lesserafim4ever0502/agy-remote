import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = !!(first & 0x80);
    const opcode = first & 0x0f;
    const masked = !!(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
      length = Number(big);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const total = headerLength + maskLength + length;
    if (buffer.length - offset < total) break;
    if (!fin) throw new Error('Fragmented WebSocket frames are not supported by the minimal server');
    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, payload });
    offset += total;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

export function acceptWebSocket(req, socket, head, handlers = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key) throw new Error('Missing Sec-WebSocket-Key');
  const accept = crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));

  const client = {
    socket,
    closed: false,
    subscriptions: new Set(),
    sendJson(value) {
      if (!this.closed && socket.writable) socket.write(encodeFrame(JSON.stringify(value)));
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      try { socket.write(encodeFrame('', 0x8)); } catch {}
      socket.end();
    },
  };

  let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  const processBuffer = () => {
    let parsed;
    try { parsed = decodeFrames(buffer); }
    catch (error) { handlers.onError?.(error, client); client.close(); return; }
    buffer = Buffer.from(parsed.remaining);
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) { client.close(); return; }
      if (frame.opcode === 0x9) { socket.write(encodeFrame(frame.payload, 0xA)); continue; }
      if (frame.opcode !== 0x1) continue;
      try { handlers.onMessage?.(JSON.parse(frame.payload.toString('utf8')), client); }
      catch (error) { client.sendJson({ type: 'error', message: error.message }); }
    }
  };

  socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); processBuffer(); });
  socket.on('close', () => { client.closed = true; handlers.onClose?.(client); });
  socket.on('error', (error) => { handlers.onError?.(error, client); });
  handlers.onOpen?.(client);
  if (buffer.length) processBuffer();
  return client;
}

export { encodeFrame, decodeFrames };
