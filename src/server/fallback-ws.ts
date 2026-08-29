import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type WsClient = {
  send: (data: Buffer | string) => void;
  close: () => void;
  ping: () => void;
  ready: boolean;
};

type Handlers = {
  onMessage?: (data: Buffer, isBinary: boolean) => void;
  onClose?: () => void;
};

export function acceptWebsocket(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  handlers: Handlers,
): WsClient | null {
  const key = req.headers["sec-websocket-key"];
  if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }
  const proto = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .find((s) => s === "ezs");
  if (!proto) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (proto ? "Sec-WebSocket-Protocol: ezs\r\n" : "") +
      "\r\n",
  );
  if (head.length) socket.unshift(head);

  let buf = Buffer.alloc(0);
  let ready = true;
  let fragOp = 0;
  let frag: Buffer[] = [];
  let fragBytes = 0;

  const finish = (): void => {
    if (!ready) return;
    ready = false;
    handlers.onClose?.();
    try {
      socket.end();
    } catch {
      /* ignore */
    }
  };

  const ws: WsClient = {
    get ready() {
      return ready;
    },
    send(data) {
      if (!ready) return;
      const payload = typeof data === "string" ? Buffer.from(data) : data;
      socket.write(encodeFrame(typeof data === "string" ? 1 : 2, payload));
    },
    ping() {
      if (ready) socket.write(encodeFrame(9, Buffer.alloc(0)));
    },
    close() {
      if (!ready) return;
      try {
        socket.write(encodeFrame(8, Buffer.alloc(0)));
      } catch {
        /* ignore */
      }
      finish();
    },
  };

  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 1_510_000) {
      ws.close();
      return;
    }
    while (true) {
      const parsed = decodeFrame(buf);
      if (!parsed) break;
      if (parsed === "overflow") {
        ws.close();
        return;
      }
      buf = parsed.rest;
      const { opcode, payload, fin } = parsed;
      if (opcode === 8) {
        ws.close();
        return;
      }
      if (opcode === 9) {
        socket.write(encodeFrame(10, payload));
        continue;
      }
      if (opcode === 10) continue;
      if (opcode === 0) {
        fragBytes += payload.length;
        if (frag.length > 64 || fragBytes > 1_500_000) {
          ws.close();
          return;
        }
        frag.push(payload);
        if (fin) {
          const body = Buffer.concat(frag);
          const op = fragOp;
          frag = [];
          fragOp = 0;
          fragBytes = 0;
          handlers.onMessage?.(body, op === 2);
        }
        continue;
      }
      if (!fin) {
        fragOp = opcode;
        frag = [payload];
        fragBytes = payload.length;
        continue;
      }
      handlers.onMessage?.(payload, opcode === 2);
    }
  });
  socket.on("close", finish);
  socket.on("error", finish);
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15_000);
  return ws;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(
  buf: Buffer,
): { opcode: number; payload: Buffer; fin: boolean; rest: Buffer } | "overflow" | null {
  if (buf.length < 2) return null;
  const fin = (buf[0]! & 0x80) !== 0;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const n = buf.readBigUInt64BE(2);
    if (n > 1_500_000n) return "overflow";
    len = Number(n);
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]!;
  }
  return { opcode, payload, fin, rest: buf.subarray(offset + maskLen + len) };
}
