/**
 * Minimal RFC 6455 client, just enough for the Chrome DevTools Protocol.
 *
 * The project has no dependencies and targets Node >= 18, where a global
 * `WebSocket` is not guaranteed (it became stable in Node 22). The harness only
 * needs text frames in both directions, ping/pong and close, so a small client
 * on `node:net` keeps `npm run e2e` runnable on every supported Node version.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024;

function frameHeader(opcode, length, masked) {
  const maskBit = masked ? 0x80 : 0;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = maskBit | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = maskBit | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return header;
}

function encodeFrame(opcode, payload) {
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([frameHeader(opcode, payload.length, true), mask, masked]);
}

function encodeText(text) {
  return encodeFrame(0x1, Buffer.from(text, 'utf8'));
}

/**
 * Parses one frame from the front of `buffer`.
 * @returns {{fin: boolean, opcode: number, payload: Buffer, rest: Buffer}|null}
 */
function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE)) throw new Error(`WebSocket frame too large: ${big} bytes`);
    length = Number(big);
    offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  let payload = buffer.subarray(offset, offset + length);
  if (mask) {
    const copy = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) copy[i] = payload[i] ^ mask[i & 3];
    payload = copy;
  }
  return { fin, opcode, payload, rest: buffer.subarray(offset + length) };
}

/**
 * Opens a WebSocket and resolves once the upgrade is accepted.
 * @returns {Promise<{send: Function, close: Function, onmessage: Function|null, onclose: Function|null}>}
 */
export function openWebSocket(url, { timeoutMs = 10000 } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return Promise.reject(new Error(`invalid WebSocket URL: ${url}`));
  }
  if (target.protocol !== 'ws:') {
    return Promise.reject(new Error(`only ws:// is supported, got ${target.protocol}//`));
  }
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + GUID).digest('base64');
  const socket = connect({ host: target.hostname, port: Number(target.port || 80) });
  socket.setNoDelay(true);

  const api = { send: null, close: null, onmessage: null, onclose: null, closed: false };
  let upgraded = false;
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentBytes = 0;
  let settled = false;
  let resolveOpen;
  let rejectOpen;
  const opened = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectOpen(new Error(`WebSocket handshake timed out after ${timeoutMs} ms`));
    socket.destroy();
  }, timeoutMs);

  const fail = (err) => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      rejectOpen(err);
    } else if (!api.closed) {
      api.closed = true;
      if (api.onclose) api.onclose(err);
    }
    socket.destroy();
  };

  const deliver = (text) => {
    if (!api.onmessage) return;
    try {
      api.onmessage(text);
    } catch (err) {
      fail(err);
    }
  };

  const handleFrame = (frame) => {
    if (frame.opcode === 0x8) {
      api.closed = true;
      socket.end(encodeFrame(0x8, Buffer.alloc(0)));
      if (api.onclose) api.onclose(null);
      return;
    }
    if (frame.opcode === 0x9) {
      socket.write(encodeFrame(0xa, frame.payload));
      return;
    }
    if (frame.opcode === 0xa) return;
    if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
      fragments.push(frame.payload);
      fragmentBytes += frame.payload.length;
      if (fragmentBytes > MAX_MESSAGE) throw new Error('WebSocket message too large');
      if (frame.fin) {
        const message = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        fragmentBytes = 0;
        deliver(message);
      }
      return;
    }
    throw new Error(`unsupported WebSocket opcode ${frame.opcode}`);
  };

  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 16384) fail(new Error('WebSocket handshake response is too large'));
        return;
      }
      const head = buffer.subarray(0, end).toString('latin1');
      buffer = buffer.subarray(end + 4);
      const lines = head.split('\r\n');
      const status = lines[0] || '';
      if (!/^HTTP\/1\.1 101\b/.test(status)) {
        fail(new Error(`WebSocket upgrade rejected: ${status}`));
        return;
      }
      const headers = new Map();
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
      }
      if (headers.get('sec-websocket-accept') !== expected) {
        fail(new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept'));
        return;
      }
      upgraded = true;
      settled = true;
      clearTimeout(timer);
      resolveOpen(api);
    }
    try {
      for (;;) {
        const frame = readFrame(buffer);
        if (!frame) break;
        buffer = frame.rest;
        handleFrame(frame);
        if (api.closed) break;
      }
    } catch (err) {
      fail(err);
    }
  });

  socket.on('error', (err) => fail(err));
  socket.on('close', () => {
    if (api.closed) return;
    api.closed = true;
    if (api.onclose) api.onclose(new Error('WebSocket closed'));
    if (!settled) fail(new Error('WebSocket closed before the handshake finished'));
  });

  api.send = (text) => {
    if (api.closed) throw new Error('WebSocket is closed');
    socket.write(encodeText(text));
  };
  api.close = () => {
    if (api.closed) return;
    api.closed = true;
    try {
      socket.write(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {
      /* the socket may already be gone */
    }
    socket.end();
  };

  socket.write(
    [
      `GET ${target.pathname || '/'}${target.search || ''} HTTP/1.1`,
      `Host: ${target.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );

  return opened;
}
