import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual, scryptSync, createHash } from "node:crypto";
import { readFileSync, existsSync, statSync, watchFile } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { acceptWebsocket, type WsClient } from "./fallback-ws.ts";

type Watcher = { ws: WsClient; name: string; id: string; rtt?: number };
type RoomRecord = {
  id: string;
  passwordHash: Buffer | null;
  forceTcp: boolean;
  createdAt: number;
  ingestToken: string;
  watchTokens: Map<string, number>;
  ingest: WsClient | null;
  watchers: Set<Watcher>;
  lastFrame: Buffer | null;
  gcAt: number;
};

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WEB_DIR = join(ROOT, "dist/web");

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

function loadDotEnv(): void {
  const files = [join(ROOT, ".env.prod"), join(ROOT, ".env")];
  const pick = process.env.NODE_ENV === "production" ? files : files.reverse();
  for (const file of pick) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnvFile(file))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}

loadDotEnv();

const envFiles = [join(ROOT, ".env.prod"), join(ROOT, ".env")];
let hostPassword = "";

function reloadHostPassword(): void {
  const order =
    process.env.NODE_ENV === "production" ? envFiles : [...envFiles].reverse();
  for (const file of order) {
    const parsed = parseEnvFile(file);
    if (parsed.HOST_PASSWORD !== undefined) {
      hostPassword = parsed.HOST_PASSWORD;
      console.log(`host password loaded from ${file} (${hostPassword ? "set" : "empty"})`);
      return;
    }
  }
  hostPassword = process.env.HOST_PASSWORD ?? "";
  console.log(`host password loaded from env (${hostPassword ? "set" : "empty"})`);
}

reloadHostPassword();
for (const file of envFiles) {
  if (!existsSync(file)) continue;
  watchFile(file, { interval: 1000 }, () => reloadHostPassword());
}

function hostKeyOk(given: string): boolean {
  if (!hostPassword) return process.env.NODE_ENV !== "production";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(hostPassword).digest();
  return timingSafeEqual(a, b);
}

const API_PORT = Number(env("API_PORT", "8787"));
const PUBLIC_URL = env("PUBLIC_URL", "http://127.0.0.1:5173").replace(/\/$/, "");
const LIVEKIT_WS_URL = env("LIVEKIT_WS_URL", "ws://127.0.0.1:7880");
const LIVEKIT_API_KEY = env("LIVEKIT_API_KEY", "ezs");
const LIVEKIT_API_SECRET = env("LIVEKIT_API_SECRET");
const LIVEKIT_TURN_URL = env("LIVEKIT_TURN_URL");
const LIVEKIT_HTTP = env(
  "LIVEKIT_HTTP_URL",
  LIVEKIT_WS_URL.replace(/^ws/, "http"),
).replace(/\/$/, "");

if (!LIVEKIT_API_SECRET || LIVEKIT_API_SECRET.length < 32) {
  console.error("LIVEKIT_API_SECRET must be at least 32 characters");
  process.exit(1);
}

const rooms = new Map<string, RoomRecord>();
const roomApi = new RoomServiceClient(LIVEKIT_HTTP, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

const ALLOW_ORIGIN = new Set(
  [PUBLIC_URL, "http://127.0.0.1:5173", "http://localhost:5173"].filter(Boolean),
);

function requestOrigin(req: IncomingMessage): string | null {
  const o = req.headers.origin;
  if (typeof o === "string" && ALLOW_ORIGIN.has(o)) return o;
  return null;
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const o = requestOrigin(req);
  if (o) {
    res.setHeader("access-control-allow-origin", o);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  }
}

function applySecHeaders(res: ServerResponse, html = false): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("permissions-policy", "camera=(), geolocation=(), microphone=(self)");
  if (html) {
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  }
}

function json(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): void {
  if (req) applyCors(req, res);
  applySecHeaders(res);
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

const rateBuckets = new Map<string, { n: number; t: number }>();

function clientIp(req: IncomingMessage): string {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
    return hops[hops.length - 1] || "unknown";
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimit(req: IncomingMessage, bucket: string, limit = 20, windowMs = 60_000): boolean {
  const id = `${clientIp(req)}:${bucket}`;
  const now = Date.now();
  let b = rateBuckets.get(id);
  if (!b || now - b.t > windowMs) {
    b = { n: 0, t: now };
    rateBuckets.set(id, b);
  }
  b.n += 1;
  return b.n <= limit;
}

function bearerToken(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const protos = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "ezs");
  return protos[0] ?? "";
}

function tokenEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

function originAllowed(req: IncomingMessage): boolean {
  const o = req.headers.origin;
  if (o === undefined) return true;
  return typeof o === "string" && ALLOW_ORIGIN.has(o);
}

function hashPassword(password: string, salt?: Buffer): Buffer {
  const s = salt ?? randomBytes(16);
  const hash = scryptSync(password, s, 32);
  return Buffer.concat([s, hash]);
}

function checkPassword(password: string, stored: Buffer): boolean {
  const salt = stored.subarray(0, 16);
  const expected = stored.subarray(16);
  const got = scryptSync(password, salt, 32);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

function roomId(): string {
  return randomBytes(6).toString("base64url");
}

function iceServers(_forceTcp: boolean) {
  // Credentials are minted by LiveKit on join. Bare turns: URLs here crash Chromium:
  // "username and credential are required when the URL scheme is turn/turns".
  return [];
}

function freshToken(): string {
  return randomBytes(18).toString("base64url");
}

function notifyHost(rec: RoomRecord): void {
  rec.ingest?.send(
    JSON.stringify({
      t: "watchers",
      viewers: [...rec.watchers].map((w) => ({ name: w.name, id: w.id, rtt: w.rtt })),
    }),
  );
}

async function mintToken(opts: {
  room: string;
  identity: string;
  name: string;
  canPublish: boolean;
}): Promise<string> {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: opts.identity,
    name: opts.name,
    ttl: "6h",
  });
  at.addGrant({
    roomJoin: true,
    room: opts.room,
    canPublish: opts.canPublish,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: opts.canPublish,
  });
  return at.toJwt();
}

async function readBody(req: IncomingMessage, max = 64_000): Promise<string> {
  return (await readBuffer(req, max)).toString("utf8");
}

async function readBuffer(req: IncomingMessage, max = 1_500_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    n += (chunk as Buffer).length;
    if (n > max) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function pushFrame(rec: RoomRecord, frame: Buffer): void {
  rec.lastFrame = frame;
  for (const w of rec.watchers) w.ws.send(frame);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
};

function serveStatic(reqPath: string, res: ServerResponse): boolean {
  if (!existsSync(WEB_DIR)) return false;
  const raw = reqPath === "/" || reqPath.startsWith("/r/") ? "/index.html" : reqPath;
  const safe = normalize(raw).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = join(WEB_DIR, safe);
  if (!file.startsWith(WEB_DIR + "/") && file !== WEB_DIR) {
    json(res, 403, { error: "bad path" });
    return true;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const fallback = join(WEB_DIR, "index.html");
    if (!existsSync(fallback)) return false;
    applySecHeaders(res, true);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(fallback));
    return true;
  }
  const html = extname(file) === ".html";
  applySecHeaders(res, html);
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
  return true;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "OPTIONS") {
      applyCors(req, res);
      applySecHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health") {
      json(res, 200, { ok: true }, req);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      json(
        res,
        200,
        {
          livekitUrl: LIVEKIT_WS_URL,
          publicUrl: PUBLIC_URL,
          turn: Boolean(LIVEKIT_TURN_URL),
          hostKeyRequired: Boolean(hostPassword) || process.env.NODE_ENV === "production",
        },
        req,
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/rooms") {
      if (!rateLimit(req, "create", 8, 60_000)) {
        json(res, 429, { error: "too many attempts" }, req);
        return;
      }
      const body = JSON.parse((await readBody(req)) || "{}") as {
        password?: string;
        hostPassword?: string;
        forceTcp?: boolean;
        nickname?: string;
      };
      if (!hostPassword && process.env.NODE_ENV === "production") {
        json(res, 503, { error: "host key not configured" }, req);
        return;
      }
      if (!hostKeyOk((body.hostPassword ?? "").trim())) {
        json(res, 403, { error: "wrong host key" }, req);
        return;
      }
      const id = roomId();
      const password = (body.password ?? "").trim();
      const forceTcp = Boolean(body.forceTcp);
      const nickname = (body.nickname ?? "host").trim().slice(0, 32) || "host";
      const ingestToken = freshToken();
      rooms.set(id, {
        id,
        passwordHash: password ? hashPassword(password) : null,
        forceTcp,
        createdAt: Date.now(),
        ingestToken,
        watchTokens: new Map(),
        ingest: null,
        watchers: new Set(),
        lastFrame: null,
        gcAt: 0,
      });
      try {
        await roomApi.createRoom({
          name: id,
          emptyTimeout: 600,
          departureTimeout: 30,
          maxParticipants: 32,
          metadata: JSON.stringify({ forceTcp }),
        });
      } catch (e) {
        console.warn("createRoom", e);
      }
      const token = await mintToken({
        room: id,
        identity: "host",
        name: nickname,
        canPublish: true,
      });
      json(
        res,
        200,
        {
          roomId: id,
          token,
          livekitUrl: LIVEKIT_WS_URL,
          publicUrl: `${PUBLIC_URL}/r/${id}`,
          forceTcp,
          iceServers: iceServers(forceTcp),
          ingestToken,
        },
        req,
      );
      return;
    }

    const frameMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/frame$/);
    if (frameMatch && (req.method === "GET" || req.method === "HEAD" || req.method === "POST")) {
      const id = decodeURIComponent(frameMatch[1]);
      const rec = rooms.get(id);
      if (!rec) {
        json(res, 404, { error: "room not found" }, req);
        return;
      }
      const given = bearerToken(req);
      if (req.method === "POST") {
        if (!tokenEq(given, rec.ingestToken)) {
          json(res, 403, { error: "bad token" }, req);
          return;
        }
        const frame = await readBuffer(req);
        if (frame.length < 32) {
          json(res, 400, { error: "empty frame" }, req);
          return;
        }
        pushFrame(rec, frame);
        applyCors(req, res);
        res.writeHead(204);
        res.end();
        return;
      }
      if (!rec.watchTokens.has(given)) {
        json(res, 403, { error: "bad token" }, req);
        return;
      }
      if (!rec.lastFrame) {
        applyCors(req, res);
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      applyCors(req, res);
      applySecHeaders(res);
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "content-length": rec.lastFrame.length,
      });
      if (req.method !== "HEAD") res.write(rec.lastFrame);
      res.end();
      return;
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
    if (req.method === "POST" && joinMatch) {
      if (!rateLimit(req, "join", 20, 60_000)) {
        json(res, 429, { error: "too many attempts" }, req);
        return;
      }
      const id = decodeURIComponent(joinMatch[1]);
      const rec = rooms.get(id);
      const body = JSON.parse((await readBody(req)) || "{}") as {
        password?: string;
        nickname?: string;
        identity?: string;
      };
      const pwOk = rec
        ? !rec.passwordHash || checkPassword(body.password ?? "", rec.passwordHash)
        : false;
      if (!rec || !pwOk) {
        json(res, 403, { error: "invalid room or password" }, req);
        return;
      }
      if (rec.watchTokens.size >= 64) {
        let oldest = "";
        let oldestT = Infinity;
        for (const [tok, t] of rec.watchTokens) {
          if (t < oldestT) {
            oldestT = t;
            oldest = tok;
          }
        }
        if (oldest) rec.watchTokens.delete(oldest);
      }
      const nickname = (body.nickname ?? "viewer").trim().slice(0, 32) || "viewer";
      const requested = (body.identity ?? "").trim();
      const identity = /^v-[0-9a-f-]{8,}$/i.test(requested)
        ? requested.slice(0, 64)
        : `v-${randomBytes(4).toString("hex")}`;
      const token = await mintToken({
        room: id,
        identity,
        name: nickname,
        canPublish: false,
      });
      const watchToken = freshToken();
      rec.watchTokens.set(watchToken, Date.now());
      rec.gcAt = 0;
      json(
        res,
        200,
        {
          roomId: id,
          token,
          livekitUrl: LIVEKIT_WS_URL,
          forceTcp: rec.forceTcp,
          iceServers: iceServers(rec.forceTcp),
          watchToken,
        },
        req,
      );
      return;
    }

    if (req.method === "GET" && (url.pathname.startsWith("/api") || url.pathname === "/health")) {
      json(res, 404, { error: "not found" });
      return;
    }

    if (req.method === "GET" && serveStatic(url.pathname, res)) return;

    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: "server error" });
  }
});

server.on("upgrade", (req, socket, head) => {
  if (!originAllowed(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const ingest = url.pathname.match(/^\/ws\/ingest\/([^/]+)$/);
  const watch = url.pathname.match(/^\/ws\/watch\/([^/]+)$/);
  const given = bearerToken(req);
  const id = decodeURIComponent((ingest ?? watch)?.[1] ?? "");
  const rec = rooms.get(id);
  if (!rec) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (ingest) {
    if (!tokenEq(given, rec.ingestToken)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    rec.ingest?.close();
    let ingestWs: WsClient | null = null;
    ingestWs = acceptWebsocket(req, socket, head, {
      onMessage(data, isBinary) {
        if (!isBinary) return;
        if (data.length > 1_500_000) return;
        for (const w of rec.watchers) w.ws.send(data);
      },
      onClose() {
        if (rec.ingest === ingestWs) rec.ingest = null;
        for (const w of rec.watchers) w.ws.send(JSON.stringify({ t: "gone" }));
        if (!rec.ingest && rec.watchers.size === 0) rec.gcAt = Date.now() + 90_000;
      },
    });
    if (ingestWs) {
      rec.ingest = ingestWs;
      notifyHost(rec);
    }
    return;
  }
  if (watch) {
    if (!rec.watchTokens.has(given)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (rec.watchers.size >= 32) {
      socket.write("HTTP/1.1 429 Too Many\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    let watcher: Watcher | null = null;
    const ws = acceptWebsocket(req, socket, head, {
      onMessage(data, isBinary) {
        if (isBinary || !watcher) return;
        try {
          const msg = JSON.parse(data.toString()) as {
            t?: string;
            name?: string;
            id?: string;
            n?: number;
            ms?: number;
          };
          if (msg.t === "hello") {
            if (typeof msg.name === "string") watcher.name = msg.name.trim().slice(0, 32) || watcher.name;
            if (typeof msg.id === "string") watcher.id = msg.id.trim().slice(0, 64);
            notifyHost(rec);
          } else if (msg.t === "ping") {
            watcher.ws.send(JSON.stringify({ t: "pong", n: msg.n }));
          } else if (msg.t === "rtt" && typeof msg.ms === "number" && Number.isFinite(msg.ms)) {
            watcher.rtt = Math.round(Math.min(60_000, Math.max(0, msg.ms)));
            notifyHost(rec);
          }
        } catch {
          /* ignore */
        }
      },
      onClose() {
        if (watcher) rec.watchers.delete(watcher);
        notifyHost(rec);
        if (!rec.ingest && rec.watchers.size === 0) rec.gcAt = Date.now() + 90_000;
      },
    });
    if (ws) {
      watcher = { ws, name: "viewer", id: "" };
      rec.watchers.add(watcher);
      ws.send(JSON.stringify({ t: "hello", hasHost: Boolean(rec.ingest) }));
      notifyHost(rec);
    }
    return;
  }
  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
});

setInterval(() => {
  const now = Date.now();
  for (const [id, b] of rateBuckets) {
    if (now - b.t > 120_000) rateBuckets.delete(id);
  }
  for (const [id, rec] of rooms) {
    rec.ingest?.ping();
    for (const w of rec.watchers) w.ws.ping();
    if (rec.ingest || rec.watchers.size) {
      rec.gcAt = 0;
      continue;
    }
    if (!rec.gcAt) rec.gcAt = now + 90_000;
    if (now >= rec.gcAt) {
      rooms.delete(id);
      void roomApi.deleteRoom(id).catch(() => undefined);
    }
  }
}, 15_000).unref();

server.listen(API_PORT, "127.0.0.1", () => {
  console.log(`ezscreenshare api on 127.0.0.1:${API_PORT}  livekit ${LIVEKIT_WS_URL}  public ${PUBLIC_URL}`);
});
