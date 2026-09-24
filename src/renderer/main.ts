import { LiveBuffer } from "./live-buffer";
import { normalizeAudioSelection, includesAudioApp, audioSelectionLabel, type AudioSelection } from "../shared/audio-selection.mjs";
import { positiveRttMs, selectRttMs } from "../shared/rtt.mjs";
import { startMacAudio, stopMacAudio } from "./macos-audio";
import compatAudioUrl from "./compat-audio.worklet.js?url&no-inline";
import {
  Room,
  RoomEvent,
  ConnectionState,
  Track,
  VideoPreset,
  VideoQuality,
  type LocalTrackPublication,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type LocalVideoTrack,
  type LocalAudioTrack,
  type RemoteVideoTrack,
  type VideoSenderStats,
  type VideoReceiverStats,
} from "livekit-client";

declare global {
  interface Window {
    ez?: {
      isElectron: true;
      platform?: string;
      audioSelectionVersion?: number;
      beginWindowsAudio?: (selection: AudioSelection) => Promise<{ ok: boolean; id: number; label: string }>;
      onWindowsAudio?: (callback: (packet: { id: number; bytes?: Uint8Array; error?: string }) => void) => () => void;
      beginMacAudio?: (selection: AudioSelection) => Promise<{ ok: boolean; id: number; label: string }>;
      onMacAudio?: (callback: (packet: { id: number; bytes?: Uint8Array; error?: string }) => void) => () => void;
      setCaptureAudio?: (on: boolean) => Promise<void>;
      getSources: () => Promise<Source[]>;
      getSourceCatalog?: () => Promise<{ sources: Source[]; desktops: VirtualDesktop[] }>;
      setCapture: (id: string, audio: boolean) => Promise<void>;
      monitorHint: () => Promise<string>;
      copyText: (text: string) => Promise<void>;
      listAudioSources: () => Promise<
        { id: string; label: string; monitor: boolean; running: boolean }[]
      >;
      beginMonitorCapture: (
        sourceId: string | AudioSelection,
      ) => Promise<{ ok: boolean; prev: string; label: string; hints?: string[] }>;
      endMonitorCapture: (prev: string) => Promise<void>;
      releaseAudioTap: () => Promise<void>;
    };
  }
}

type Source = { id: string; name: string; thumbnail: string; kind: "screen" | "window"; desktopId?: string; onCurrentDesktop?: boolean };
type VirtualDesktop = { id: string; name: string; current: boolean };

type CreateResp = {
  roomId: string;
  token: string;
  livekitUrl: string;
  publicUrl: string;
  forceTcp: boolean;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  ingestToken: string;
  showViewers: boolean;
};

type JoinResp = {
  roomId: string;
  token: string;
  livekitUrl: string;
  forceTcp: boolean;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  watchToken: string;
  showViewers?: boolean;
};

const app = document.querySelector("#app")!;
const path = location.pathname;
const viewerMatch = path.match(/^\/r\/([^/]+)\/?$/);
const isElectron = Boolean(window.ez?.isElectron);
const nickKey = "ezscreenshare.nick";
const themeKey = "ezscreenshare.theme";
const hostKey = "ezscreenshare.hostKey";
const statsKey = "ezscreenshare.stats";
const showViewersKey = "ezscreenshare.showViewers";
const FPS_VALUES = [5, 15, 24, 25, 30, 60] as const;

function fpsSelectHtml(id: string, selected = 30): string {
  const opts = FPS_VALUES.map(
    (f) => `<option value="${f}"${f === selected ? " selected" : ""}>${f}</option>`,
  ).join("");
  return `<label class="field">fps
            <select id="${id}">${opts}</select>
          </label>`;
}

function bitrateFor(height: number, fps: number): number {
  const table: Record<number, Record<number, number>> = {
    480: { 5: 350_000, 15: 500_000, 24: 700_000, 25: 700_000, 30: 700_000, 60: 1_000_000 },
    720: { 5: 500_000, 15: 800_000, 24: 1_000_000, 25: 1_050_000, 30: 1_200_000, 60: 2_000_000 },
    1080: { 5: 800_000, 15: 1_400_000, 24: 1_800_000, 25: 1_900_000, 30: 2_500_000, 60: 4_000_000 },
    1440: { 5: 1_200_000, 15: 2_200_000, 24: 3_200_000, 25: 3_400_000, 30: 4_000_000, 60: 6_000_000 },
  };
  const row =
    height <= 480 ? table[480]! : height <= 720 ? table[720]! : height <= 1080 ? table[1080]! : table[1440]!;
  return row[fps] ?? row[30] ?? 1_200_000;
}

function ingestBitrate(height: number, fps: number): number {
  return Math.min(bitrateFor(height, fps), 4_000_000);
}

function contentHintFor(fps: number): "motion" | "detail" {
  return fps >= 24 ? "motion" : "detail";
}

function screenSharePublishOpts(height: number, fps: number) {
  const encoding = { maxBitrate: bitrateFor(height, fps), maxFramerate: fps };
  const lowH = Math.min(480, Math.max(180, Math.round(height / 2)));
  const lowW = Math.round(lowH * (16 / 9));
  return {
    source: Track.Source.ScreenShare,
    stream: "screenshare",
    simulcast: height > 480,
    videoCodec: "h264" as const,
    backupCodec: { codec: "vp8" as const },
    screenShareEncoding: encoding,
    screenShareSimulcastLayers:
      height > 480 ? [new VideoPreset(lowW, lowH, bitrateFor(lowH, fps), fps)] : undefined,
    degradationPreference: "maintain-framerate" as RTCDegradationPreference,
  };
}

async function applySenderQuality(
  pub: LocalTrackPublication | null,
  height: number,
  fps: number,
): Promise<void> {
  const track = pub?.videoTrack ?? (pub?.track as LocalVideoTrack | undefined);
  if (!track) return;
  try {
    await track.setDegradationPreference("maintain-framerate");
  } catch {
    /* older senders */
  }
  const sender = track.sender;
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const n = params.encodings.length;
    params.encodings.forEach((enc, i) => {
      enc.maxFramerate = fps;
      const layerH = i === n - 1 ? height : Math.max(180, Math.round(height / 2 ** (n - 1 - i)));
      enc.maxBitrate = bitrateFor(layerH, fps);
    });
    (params as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference =
      "maintain-framerate";
    await sender.setParameters(params);
  } catch (e) {
    console.warn("[ezscreenshare] setParameters", e);
  }
}

function statsEnabled(): boolean {
  return localStorage.getItem(statsKey) === "1";
}

function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mb/s`;
  if (bps >= 1000) return `${Math.round(bps / 1000)} kb/s`;
  return `${Math.round(bps)} b/s`;
}

function lossLabel(lost?: number, total?: number): string {
  if (lost == null || total == null || total <= 0) return "";
  const p = (100 * lost) / total;
  if (p < 0.05) return "loss 0%";
  return `loss ${p < 1 ? p.toFixed(1) : Math.round(p)}%`;
}

function senderStatsLine(stats: VideoSenderStats[]): string | undefined {
  if (!stats.length) return undefined;
  const best = stats.reduce((a, b) => ((b.frameHeight || 0) > (a.frameHeight || 0) ? b : a));
  const bits = stats.reduce((n, s) => n + (s.targetBitrate || 0), 0) || best.targetBitrate;
  const parts = ["live"];
  if (best.frameHeight) parts.push(`${best.frameHeight}p`);
  if (best.framesPerSecond) parts.push(`${Math.round(best.framesPerSecond)}fps`);
  if (bits) parts.push(formatBitrate(bits));
  const sent = stats.reduce((n, s) => n + (s.packetsSent || 0), 0);
  const lost = stats.reduce((n, s) => n + (s.packetsLost || 0), 0);
  const loss = lossLabel(lost, sent + lost);
  if (loss) parts.push(loss);
  const reason = best.qualityLimitationReason;
  if (reason && reason !== "none") parts.push(reason === "bandwidth" ? "bw limit" : `${reason} limit`);
  return parts.join(" · ");
}

function receiverStatsLine(
  stats: VideoReceiverStats | undefined,
  bitrate?: number,
): string | undefined {
  if (!stats) return undefined;
  const parts = ["live"];
  if (stats.frameHeight) parts.push(`${stats.frameHeight}p`);
  if (bitrate != null && Number.isFinite(bitrate) && bitrate > 0) parts.push(formatBitrate(bitrate));
  const recv = stats.packetsReceived ?? 0;
  const lost = stats.packetsLost ?? 0;
  const loss = lossLabel(lost, recv + lost);
  if (loss) parts.push(loss);
  return parts.join(" · ");
}

function bindStatsToggle(
  btn: HTMLElement,
  pill: HTMLElement,
  sample: () => Promise<string | undefined>,
): () => void {
  const apply = (): void => {
    const on = statsEnabled();
    pill.classList.toggle("hidden", !on);
    btn.classList.toggle("stats-on", on);
    btn.textContent = on ? "stats on" : "stats";
    if (!on) pill.textContent = "—";
  };
  const tick = async (): Promise<void> => {
    if (!statsEnabled()) return;
    const line = await sample();
    if (line) pill.textContent = line;
  };
  apply();
  btn.addEventListener("click", () => {
    localStorage.setItem(statsKey, statsEnabled() ? "0" : "1");
    apply();
    void tick();
  });
  const id = window.setInterval(() => void tick(), 2000);
  void tick();
  return () => window.clearInterval(id);
}

function currentTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme: "dark" | "light"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(themeKey, theme);
  const btn = document.querySelector("#theme");
  if (btn) btn.textContent = theme === "dark" ? "light" : "dark";
}

function bindThemeToggle(): void {
  applyTheme(currentTheme());
  document.querySelector("#theme")?.addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  });
}

function h(html: string): string {
  return html;
}

function qs<T extends HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as T;
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function roomOpts(kind: "host" | "viewer") {
  return {
    // Hidden <video> is 0×0; adaptiveStream then never requests a layer (iOS).
    adaptiveStream: false,
    dynacast: kind === "host",
    publishDefaults: {
      videoCodec: "h264" as const,
      backupCodec: { codec: "vp8" as const },
      dtx: false,
      red: false,
      simulcast: kind === "host",
      degradationPreference: "maintain-framerate" as RTCDegradationPreference,
    },
    audioCaptureDefaults: {
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
    },
    rtcConfig: {
      // Normal clients may use direct ICE. Proxy-only viewers must enforce
      // relay/proxy restrictions in their browser profile.
      iceTransportPolicy: "all" as RTCIceTransportPolicy,
    },
  };
}

function fallbackUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

function pingClass(ms: number): "ok" | "warn" | "bad" {
  if (ms < 80) return "ok";
  if (ms < 180) return "warn";
  return "bad";
}

function setPingPill(el: HTMLElement | null, ms: number | undefined): void {
  if (!el) return;
  el.classList.remove("ok", "warn", "bad");
  if (ms == null || !Number.isFinite(ms)) {
    el.textContent = "ping —";
    return;
  }
  el.textContent = `${ms} ms`;
  el.classList.add(pingClass(ms));
}

type PersonRow = { name: string; role: string; ms?: number; path?: "live" | "compat" };
type CompatWatcher = {
  name: string;
  id: string;
  rtt?: number;
  jpeg?: boolean;
  mse?: boolean;
  pcm?: boolean;
  rtc?: boolean;
};

function renderPeople(ul: HTMLElement, rows: PersonRow[]): void {
  ul.replaceChildren();
  if (!rows.length) {
    const li = document.createElement("li");
    const s = document.createElement("span");
    s.className = "sub";
    s.textContent = "nobody yet";
    li.appendChild(s);
    ul.appendChild(li);
    return;
  }
  for (const row of rows) {
    const li = document.createElement("li");
    const n = document.createElement("span");
    n.textContent = row.name;
    const right = document.createElement("span");
    right.className = "person-meta";
    if (row.ms != null && Number.isFinite(row.ms)) {
      const p = document.createElement("span");
      p.className = `ping ${pingClass(row.ms)}`;
      p.textContent = `${row.ms} ms`;
      right.appendChild(p);
    }
    const r = document.createElement("span");
    r.className = "sub";
    r.textContent = row.path ? `${row.role} · ${row.path}` : row.role;
    right.appendChild(r);
    li.append(n, right);
    ul.appendChild(li);
  }
}

function rttFromReport(report: RTCStatsReport): number | undefined {
  return selectRttMs(report.values());
}

async function roomRttMs(room: Room): Promise<number | undefined> {
  const pubs = [
    ...room.localParticipant.trackPublications.values(),
    ...[...room.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()]),
  ];
  for (const pub of pubs) {
    const track = pub.track as (LocalVideoTrack & { getSenderStats?: () => Promise<{ roundTripTime?: number }[]> }) | null;
    if (!track) continue;
    if (typeof track.getSenderStats === "function") {
      try {
        const stats = await track.getSenderStats();
        const list = Array.isArray(stats) ? stats : stats ? [stats] : [];
        for (const s of list) {
          const ms = positiveRttMs(s.roundTripTime);
          if (ms != null) return ms;
        }
      } catch {
        /* try RTCStats next */
      }
    }
    try {
      const report = await track.getRTCStatsReport();
      const ms = report ? rttFromReport(report) : undefined;
      if (ms != null) return ms;
    } catch {
      /* next publication */
    }
  }
  return undefined;
}

function bindRoomPing(
  room: Room,
  identity: string,
  pingById: Map<string, number>,
  onUpdate: (ownMs: number | undefined) => void,
): () => void {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const onData = (payload: Uint8Array, participant?: { identity: string }): void => {
    try {
      const msg = JSON.parse(decoder.decode(payload)) as { t?: string; ms?: unknown };
      if (msg.t !== "ezs-ping" || typeof msg.ms !== "number" || !participant) return;
      if (!Number.isFinite(msg.ms) || msg.ms <= 0) return;
      const ms = Math.round(Math.min(60_000, msg.ms));
      pingById.set(participant.identity, ms);
      onUpdate(pingById.get(identity));
    } catch {
      /* ignore */
    }
  };
  room.on(RoomEvent.DataReceived, onData);
  const tick = async (): Promise<void> => {
    const ms = (await roomRttMs(room)) ?? pingById.get(identity);
    if (ms == null) {
      onUpdate(undefined);
      return;
    }
    pingById.set(identity, ms);
    onUpdate(ms);
    try {
      await room.localParticipant.publishData(encoder.encode(JSON.stringify({ t: "ezs-ping", ms })), {
        reliable: false,
        topic: "ezs-ping",
      });
    } catch {
      /* room gone */
    }
  };
  const id = window.setInterval(() => void tick(), 2000);
  void tick();
  return () => {
    window.clearInterval(id);
    room.off(RoomEvent.DataReceived, onData);
  };
}

function openFallback(path: string, token: string): WebSocket {
  return new WebSocket(fallbackUrl(path), ["ezs", token]);
}

const PCM_MAGIC = [0x45, 0x5a, 0x53, 0x41]; // EZSA (legacy; ignored)
const OPUS_MAGIC = [0x45, 0x5a, 0x53, 0x4f]; // EZSO
const VID_MAGIC = [0x45, 0x5a, 0x53, 0x56]; // EZSV
const VID_CFG = 0;
const VID_FRAME = 3;
const VID_JPEG = 5;
const WEB_MAGIC = [0x45, 0x5a, 0x53, 0x57]; // EZSW
const WEB_CFG = 0;
const WEB_CHUNK = 1;
const WEB_ACFG = 2;
const WEB_ACHUNK = 3;
const OPUS_CFG = 0;
const OPUS_FRAME = 1;
const OPUS_BITRATE = 64_000;

function copyAb(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

async function canDecodeOpus(): Promise<boolean> {
  if (typeof AudioDecoder === "undefined") return false;
  const cfg: AudioDecoderConfig = { codec: "opus", sampleRate: 48000, numberOfChannels: 1 };
  try {
    if (typeof AudioDecoder.isConfigSupported === "function") {
      const probe = await AudioDecoder.isConfigSupported(cfg);
      if (probe.supported) return true;
    }
  } catch {
    /* continue */
  }
  try {
    const dec = new AudioDecoder({
      output(frame) {
        frame.close();
      },
      error() {},
    });
    dec.configure(cfg);
    const ok = dec.state === "configured";
    dec.close();
    return ok;
  } catch {
    return false;
  }
}

function packPcm(rate: number, samples: Int16Array): Uint8Array {
  const out = new Uint8Array(8 + samples.byteLength);
  out[0] = PCM_MAGIC[0]!;
  out[1] = PCM_MAGIC[1]!;
  out[2] = PCM_MAGIC[2]!;
  out[3] = PCM_MAGIC[3]!;
  new DataView(out.buffer).setUint32(4, rate, true);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 8);
  return out;
}

async function pickCompatVideo(): Promise<"webcodecs" | "mse" | "jpeg"> {
  const mseType = 'video/webm; codecs="vp8"';
  const mseOk =
    typeof MediaSource !== "undefined" &&
    (MediaSource.isTypeSupported(mseType) || MediaSource.isTypeSupported("video/webm;codecs=vp8"));
  const cfgs: VideoDecoderConfig[] = [
    { codec: "vp8", codedWidth: 640, codedHeight: 360 },
    { codec: "vp8" },
    { codec: "vp08.00.10.08", codedWidth: 640, codedHeight: 360 },
  ];
  if (typeof VideoDecoder !== "undefined") {
    for (const cfg of cfgs) {
      try {
        if (typeof VideoDecoder.isConfigSupported === "function") {
          const probe = await VideoDecoder.isConfigSupported(cfg);
          if (probe.supported) return "webcodecs";
        }
      } catch {
        /* continue */
      }
      try {
        const dec = new VideoDecoder({
          output(frame) {
            frame.close();
          },
          error() {},
        });
        dec.configure(cfg);
        const ok = dec.state === "configured";
        dec.close();
        if (ok) return "webcodecs";
      } catch {
        /* no WebCodecs VP8 */
      }
    }
  }
  if (mseOk) return "mse";
  return "jpeg";
}

function packWeb(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = WEB_MAGIC[0]!;
  out[1] = WEB_MAGIC[1]!;
  out[2] = WEB_MAGIC[2]!;
  out[3] = WEB_MAGIC[3]!;
  out[4] = kind;
  out.set(payload, 5);
  return out;
}

function parseWeb(buf: Uint8Array): { kind: number; payload: Uint8Array } | null {
  if (
    buf.length < 6 ||
    buf[0] !== WEB_MAGIC[0] ||
    buf[1] !== WEB_MAGIC[1] ||
    buf[2] !== WEB_MAGIC[2] ||
    buf[3] !== WEB_MAGIC[3]
  ) {
    return null;
  }
  return { kind: buf[4]!, payload: buf.subarray(5) };
}

function isEbml(u8: Uint8Array): boolean {
  return u8.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3;
}

function webmCluster(u8: Uint8Array): Uint8Array | null {
  for (let i = 0; i <= u8.length - 4; i++) {
    if (u8[i] === 0x1f && u8[i + 1] === 0x43 && u8[i + 2] === 0xb6 && u8[i + 3] === 0x75) {
      return u8.subarray(i);
    }
  }
  return null;
}

function webmMedia(u8: Uint8Array, keepInit: boolean): Uint8Array | null {
  if (!isEbml(u8)) return u8;
  if (keepInit) return u8;
  return webmCluster(u8);
}

function packVid(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = VID_MAGIC[0]!;
  out[1] = VID_MAGIC[1]!;
  out[2] = VID_MAGIC[2]!;
  out[3] = VID_MAGIC[3]!;
  out[4] = kind;
  out.set(payload, 5);
  return out;
}

function parseVid(buf: Uint8Array): { kind: number; payload: Uint8Array } | null {
  if (
    buf.length < 6 ||
    buf[0] !== VID_MAGIC[0] ||
    buf[1] !== VID_MAGIC[1] ||
    buf[2] !== VID_MAGIC[2] ||
    buf[3] !== VID_MAGIC[3]
  ) {
    return null;
  }
  return { kind: buf[4]!, payload: buf.subarray(5) };
}

function isPcmPacket(buf: Uint8Array): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === PCM_MAGIC[0] &&
    buf[1] === PCM_MAGIC[1] &&
    buf[2] === PCM_MAGIC[2] &&
    buf[3] === PCM_MAGIC[3]
  );
}

function packOpus(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = OPUS_MAGIC[0]!;
  out[1] = OPUS_MAGIC[1]!;
  out[2] = OPUS_MAGIC[2]!;
  out[3] = OPUS_MAGIC[3]!;
  out[4] = kind;
  out.set(payload, 5);
  return out;
}

function parseOpus(buf: Uint8Array): { kind: number; payload: Uint8Array } | null {
  if (
    buf.length < 6 ||
    buf[0] !== OPUS_MAGIC[0] ||
    buf[1] !== OPUS_MAGIC[1] ||
    buf[2] !== OPUS_MAGIC[2] ||
    buf[3] !== OPUS_MAGIC[3]
  ) {
    return null;
  }
  return { kind: buf[4]!, payload: buf.subarray(5) };
}

function u8ToB64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}

function b64ToU8(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function startIngest(
  stream: MediaStream,
  roomId: string,
  ingestToken: string,
  onWatchers: (viewers: CompatWatcher[]) => void,
  quality?: { fps: number; bitrate: number },
): {
  stop: () => void;
  setStream: (s: MediaStream) => void;
  setQuality: (fps: number, bitrate: number) => void;
  setViewersVisible: (on: boolean) => void;
} {
  const ws = openFallback(`/ws/ingest/${encodeURIComponent(roomId)}`, ingestToken);
  const tap = document.createElement("video");
  tap.muted = true;
  tap.playsInline = true;
  tap.autoplay = true;
  tap.className = "ingest-tap";
  tap.setAttribute("aria-hidden", "true");
  tap.width = 160;
  tap.height = 90;
  document.body.appendChild(tap);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  let srcStream = stream;
  let fps = Math.max(2, Math.min(30, quality?.fps ?? 15));
  let bitrate = quality?.bitrate ?? 700_000;
  let webmRateScale = 1;
  let webmQualityAt = performance.now();
  const playbackHealth = new Map<string, { at: number; stalls: number }>();
  let drawTimer = 0;
  let frameN = 0;
  let enc: VideoEncoder | null = null;
  let encW = 0;
  let encH = 0;
  let recW = 0;
  let recH = 0;
  let recGen = 0;
  let webmMime = "video/webm;codecs=vp8";
  let webmCfgSent = false;
  let recorder: MediaRecorder | null = null;
  let recStream: MediaStream | null = null;
  let arecorder: MediaRecorder | null = null;
  let arecGen = 0;
  let awebmMime = "audio/webm;codecs=opus";
  let awebmCfgSent = false;
  let wantJpeg = false;
  let wantPcm = false;
  let wantRaw = true;
  let mseWatchers = 0;
  let recAudioTracks: MediaStreamTrack[] = [];
  let recRestartAt = 0;
  let audioGeneration = 0;
  let audioModule: Promise<void> | null = null;
  let jpegBusy = false;
  let ac: AudioContext | null = null;
  let audioSrc: MediaStreamAudioSourceNode | null = null;
  let audioProc: AudioWorkletNode | null = null;
  let audioMute: GainNode | null = null;
  let aenc: AudioEncoder | null = null;
  let audioTs = 0;
  let opusCfgSent = false;
  let lastOpusCfg: Uint8Array | null = null;
  const utf8 = new TextEncoder();

  const bindVideo = (s: MediaStream): void => {
    tap.srcObject = new MediaStream(s.getVideoTracks());
    void tap.play().catch(() => undefined);
  };

  const closeAudioEnc = (): void => {
    try {
      aenc?.close();
    } catch {
      /* ignore */
    }
    aenc = null;
    opusCfgSent = false;
    lastOpusCfg = null;
  };

  const unhookAudio = (): void => {
    audioGeneration++;
    if (audioProc) audioProc.port.onmessage = null;
    try {
      audioSrc?.disconnect();
      audioProc?.disconnect();
      audioMute?.disconnect();
    } catch {
      /* ignore */
    }
    audioSrc = null;
    audioProc = null;
    audioMute = null;
    closeAudioEnc();
    stopAudioRec();
  };

  const sendOpusCfg = (cfg: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
    description?: Uint8Array;
  }): void => {
    const body: { codec: string; sampleRate: number; channels: number; description?: string } = {
      codec: cfg.codec,
      sampleRate: cfg.sampleRate,
      channels: cfg.numberOfChannels,
    };
    if (cfg.description && cfg.description.byteLength) body.description = u8ToB64(cfg.description);
    lastOpusCfg = packOpus(OPUS_CFG, utf8.encode(JSON.stringify(body)));
    ws.send(lastOpusCfg);
    opusCfgSent = true;
  };

  const ensureAudioEnc = (sampleRate: number): AudioEncoder | null => {
    if (typeof AudioEncoder === "undefined") return null;
    if (aenc && aenc.state === "configured") return aenc;
    closeAudioEnc();
    const next = new AudioEncoder({
      output(chunk, meta) {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256_000) return;
        const desc = meta?.decoderConfig?.description;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        if (desc && !opusCfgSent) {
          const u8 = desc instanceof Uint8Array ? desc : new Uint8Array(desc as ArrayBuffer);
          sendOpusCfg({
            codec: meta.decoderConfig?.codec || "opus",
            sampleRate: meta.decoderConfig?.sampleRate || sampleRate,
            numberOfChannels: meta.decoderConfig?.numberOfChannels || 1,
            description: u8,
          });
        } else if (!opusCfgSent) {
          sendOpusCfg({ codec: "opus", sampleRate, numberOfChannels: 1 });
        }
        const payload = new Uint8Array(5 + data.length);
        payload[0] = chunk.type === "key" ? 1 : 0;
        new DataView(payload.buffer).setUint32(1, chunk.timestamp >>> 0, true);
        payload.set(data, 5);
        ws.send(packOpus(OPUS_FRAME, payload));
      },
      error(err) {
        console.warn("[ezscreenshare] opus encode", err);
      },
    });
    next.configure({
      codec: "opus",
      numberOfChannels: 1,
      sampleRate,
      bitrate: OPUS_BITRATE,
    });
    aenc = next;
    return next;
  };

  const restartRec = (): void => {
    const now = performance.now();
    if (recRestartAt !== 0 && now - recRestartAt < 4000) return;
    recRestartAt = now;
    stopRec();
  };

  const hookAudio = (s: MediaStream): void => {
    unhookAudio();
    const generation = audioGeneration;
    const tracks = s.getAudioTracks();
    if (!tracks.length) return;
    ac ??= new AudioContext({ sampleRate: 48000 });
    void ac.resume();
    audioTs = 0;
    const rate = ac.sampleRate || 48000;
    ensureAudioEnc(rate);
    audioModule ??= ac.audioWorklet.addModule(compatAudioUrl);
    void audioModule.then(() => {
      if (generation !== audioGeneration) return;
      const src = ac!.createMediaStreamSource(new MediaStream(tracks));
      const proc = new AudioWorkletNode(ac!, "compat-capture", { outputChannelCount: [1] });
      const mute = ac!.createGain();
      mute.gain.value = 0;
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ac!.destination);
      proc.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = ev.data;
        if (wantPcm && ws.bufferedAmount <= 256_000) {
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const n = Math.max(-1, Math.min(1, input[i]!));
            pcm[i] = n < 0 ? n * 0x8000 : n * 0x7fff;
          }
          ws.send(packPcm(ac!.sampleRate, pcm));
        }
        if (!wantRaw || ws.bufferedAmount > 256_000) return;
        const encoder = ensureAudioEnc(rate);
        if (encoder && encoder.encodeQueueSize < 8) {
          const copy = new Float32Array(input);
          const frames = copy.length;
          const ad = new AudioData({
            format: "f32",
            sampleRate: rate,
            numberOfFrames: frames,
            numberOfChannels: 1,
            timestamp: audioTs,
            data: copy,
          });
          audioTs += Math.round((frames * 1_000_000) / rate);
          try {
            encoder.encode(ad);
          } catch (err) {
            console.warn("[ezscreenshare] opus frame", err);
          }
          ad.close();
        }
      };
      audioSrc = src;
      audioProc = proc;
      audioMute = mute;
    }).catch((err) => console.error("[ezscreenshare] audio capture", err));
  };

  // Pulling the published track into an AudioContext makes Chromium glitch that
  // same track on the live WebRTC send. Only tap while a compat viewer needs it.
  let audioTapWanted = false;
  const syncAudioTap = (): void => {
    const need = wantPcm || wantRaw;
    if (need === audioTapWanted) return;
    audioTapWanted = need;
    if (need) hookAudio(srcStream);
    else unhookAudio();
  };

  const closeEnc = (): void => {
    try {
      enc?.close();
    } catch {
      /* ignore */
    }
    enc = null;
    encW = 0;
    encH = 0;
  };

  const stopRec = (): void => {
    recGen++;
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {
      /* ignore */
    }
    recorder = null;
    recStream?.getVideoTracks().forEach((t) => t.stop());
    recStream = null;
    recW = 0;
    recH = 0;
    webmCfgSent = false;
  };

  const ensureRec = (w: number, h: number): void => {
    if (typeof MediaRecorder === "undefined" || w < 16 || h < 16) return;
    if (recorder && recorder.state !== "inactive" && recW === w && recH === h) return;
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256_000) return;
    stopRec();
    const mime = ["video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) return;
    const gen = recGen;
    webmMime = mime;
    recW = w;
    recH = h;
    // Encode the capture track directly. A hidden video -> timer -> canvas
    // pipeline can stop producing frames when the host tab is occluded.
    recStream = new MediaStream(srcStream.getVideoTracks().map((track) => track.clone()));
    const recBitrate = Math.min(4_000_000, Math.max(bitrate * webmRateScale, 350_000));
    try {
      const options: MediaRecorderOptions & { videoKeyFrameIntervalDuration: number } = {
        mimeType: mime, videoBitsPerSecond: recBitrate, videoKeyFrameIntervalDuration: 500,
      };
      recorder = new MediaRecorder(recStream, options);
    } catch {
      recorder = new MediaRecorder(recStream, { mimeType: mime });
    }
    recorder.ondataavailable = (ev) => {
      if (gen !== recGen) return;
      if (!ev.data || ev.data.size < 16) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 256_000) {
        // Chunks are byte ranges, not independent frames. Restart with a fresh
        // header after congestion instead of punching holes in the WebM file.
        stopRec();
        return;
      }
      if (!webmCfgSent) {
        ws.send(packWeb(WEB_CFG, utf8.encode(JSON.stringify({ mime: webmMime, w: recW, h: recH, pipeline: "capture-track-v1", fps }))));
        webmCfgSent = true;
      }
      void ev.data.arrayBuffer().then((ab) => {
        if (gen !== recGen || ws.readyState !== WebSocket.OPEN) return;
        ws.send(packWeb(WEB_CHUNK, new Uint8Array(ab)));
      });
    };
    recorder.start(100);
  };

  const stopAudioRec = (): void => {
    arecGen++;
    try {
      if (arecorder && arecorder.state !== "inactive") arecorder.stop();
    } catch {
      /* ignore */
    }
    arecorder = null;
    awebmCfgSent = false;
    recAudioTracks.forEach((t) => t.stop());
    recAudioTracks = [];
  };

  const ensureAudioRec = (s: MediaStream): void => {
    const tracks = s.getAudioTracks().filter((t) => t.readyState === "live");
    if (!tracks.length || typeof MediaRecorder === "undefined") {
      stopAudioRec();
      return;
    }
    if (arecorder && arecorder.state !== "inactive") return;
    stopAudioRec();
    const mime = ["audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) return;
    const gen = arecGen;
    awebmMime = mime;
    recAudioTracks = tracks.map((t) => t.clone());
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(new MediaStream(recAudioTracks), {
        mimeType: mime,
        audioBitsPerSecond: 64_000,
      });
    } catch {
      rec = new MediaRecorder(new MediaStream(recAudioTracks), { mimeType: mime });
    }
    rec.ondataavailable = (ev) => {
      if (gen !== arecGen) return;
      if (!ev.data || ev.data.size < 16) return;
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_500_000) return;
      if (!awebmCfgSent) {
        ws.send(packWeb(WEB_ACFG, utf8.encode(JSON.stringify({ mime: awebmMime }))));
        awebmCfgSent = true;
      }
      void ev.data.arrayBuffer().then((ab) => {
        if (gen !== arecGen || ws.readyState !== WebSocket.OPEN) return;
        ws.send(packWeb(WEB_ACHUNK, new Uint8Array(ab)));
      });
    };
    rec.start(1000);
    arecorder = rec;
  };

  const ensureEnc = (w: number, h: number): VideoEncoder | null => {
    if (typeof VideoEncoder === "undefined") return null;
    if (enc && encW === w && encH === h && enc.state === "configured") return enc;
    closeEnc();
    const next = new VideoEncoder({
      output(chunk) {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_500_000) return;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const payload = new Uint8Array(5 + data.length);
        payload[0] = chunk.type === "key" ? 1 : 0;
        new DataView(payload.buffer).setUint32(1, chunk.timestamp >>> 0, true);
        payload.set(data, 5);
        ws.send(packVid(VID_FRAME, payload));
      },
      error(err) {
        console.warn("[ezscreenshare] encode", err);
      },
    });
    next.configure({
      codec: "vp8",
      width: w,
      height: h,
      bitrate,
      framerate: fps,
      latencyMode: "realtime",
    });
    enc = next;
    encW = w;
    encH = h;
    ws.send(packVid(VID_CFG, utf8.encode(JSON.stringify({ codec: "vp8", w, h }))));
    return next;
  };

  const paint = (): void => {
    const settings = srcStream.getVideoTracks()[0]?.getSettings();
    if (mseWatchers > 0) ensureRec(settings?.width || 1280, settings?.height || 720);
    else if (recorder) stopRec();
    if ((!wantRaw && !wantJpeg) || !ctx || tap.videoWidth < 2) return;
    const scale = Math.min(1, 1280 / tap.videoWidth, 720 / tap.videoHeight);
    const w = Math.max(2, Math.round(tap.videoWidth * scale) & ~1);
    const h = Math.max(2, Math.round(tap.videoHeight * scale) & ~1);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(tap, 0, 0, w, h);
    if (wantRaw) {
      const encoder = ensureEnc(w, h);
      if (encoder && encoder.encodeQueueSize < 4) {
        const ts = Math.round((frameN * 1_000_000) / fps);
        const vf = new VideoFrame(canvas, { timestamp: ts });
        encoder.encode(vf, { keyFrame: frameN % 10 === 0 });
        vf.close();
        frameN++;
      }
    } else if (enc) {
      closeEnc();
    }
    if (wantJpeg && !jpegBusy && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 128_000) {
      jpegBusy = true;
      canvas.toBlob(
        (blob) => {
          jpegBusy = false;
          if (!blob || ws.readyState !== WebSocket.OPEN) return;
          void blob.arrayBuffer().then((ab) => ws.send(packVid(VID_JPEG, new Uint8Array(ab))));
        },
        "image/jpeg",
        0.5,
      );
    }
  };

  bindVideo(srcStream);
  syncAudioTap();
  drawTimer = window.setInterval(paint, Math.round(1000 / fps));

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data) as {
        t?: string;
        names?: string[];
        viewers?: CompatWatcher[];
        id?: string;
        stalls?: number;
      };
      if (msg.t === "playback" && msg.id && typeof msg.stalls === "number") {
        const now = performance.now();
        playbackHealth.set(msg.id, { at: now, stalls: msg.stalls });
        for (const [id, health] of playbackHealth) if (now - health.at > 20_000) playbackHealth.delete(id);
        const stalled = [...playbackHealth.values()].some(health => health.stalls >= 2);
        const calm = [...playbackHealth.values()].every(health => health.stalls === 0);
        const next = stalled && now - webmQualityAt > 15_000 ? Math.max(0.3, webmRateScale * 0.8)
          : calm && now - webmQualityAt > 45_000 ? Math.min(1, webmRateScale + 0.1) : webmRateScale;
        if (next !== webmRateScale) {
          const previousBitrate = Math.max(350_000, bitrate * webmRateScale);
          webmRateScale = next;
          webmQualityAt = now;
          const nextBitrate = Math.max(350_000, bitrate * next);
          if (nextBitrate !== previousBitrate) {
            stopRec();
            console.info("[ezscreenshare] compatibility bitrate", Math.round(nextBitrate));
          }
        }
        return;
      }
      if (msg.t === "webmRestart") {
        restartRec();
        return;
      }
      if (msg.t === "watchers" && Array.isArray(msg.viewers)) {
        wantJpeg = msg.viewers.some((v) => v.jpeg);
        wantPcm = msg.viewers.some((v) => v.pcm && !v.rtc);
        wantRaw = msg.viewers.some((v) => !v.rtc && !v.jpeg && !v.mse);
        mseWatchers = msg.viewers.filter((v) => v.mse && !v.rtc).length;
        syncAudioTap();
        onWatchers(msg.viewers);
        if (lastOpusCfg && ws.readyState === WebSocket.OPEN) ws.send(lastOpusCfg);
      } else if (msg.t === "watchers" && Array.isArray(msg.names)) {
        onWatchers(msg.names.map((name) => ({ name, id: "" })));
        if (lastOpusCfg && ws.readyState === WebSocket.OPEN) ws.send(lastOpusCfg);
      }
    } catch {
      /* ignore */
    }
  });
  return {
    setStream(next) {
      srcStream = next;
      bindVideo(next);
      if (audioTapWanted) hookAudio(next);
      closeEnc();
      stopRec();
    },
    setQuality(nextFps, nextBitrate) {
      fps = Math.max(2, Math.min(30, nextFps));
      bitrate = Math.max(120_000, nextBitrate);
      window.clearInterval(drawTimer);
      drawTimer = window.setInterval(paint, Math.round(1000 / fps));
      closeEnc();
      stopRec();
    },
    setViewersVisible(on) {
      const send = (): void => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "viewersVisible", on: Boolean(on) }));
        }
      };
      if (ws.readyState === WebSocket.OPEN) send();
      else ws.addEventListener("open", send, { once: true });
    },
    stop() {
      window.clearInterval(drawTimer);
      closeEnc();
      stopRec();
      stopAudioRec();
      closeAudioEnc();
      unhookAudio();
      void ac?.close();
      tap.srcObject = null;
      tap.remove();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
}

function startWatch(
  canvas: HTMLCanvasElement,
  mseVideo: HTMLVideoElement,
  roomId: string,
  watchToken: string,
  nick: string,
  identity: string,
  opts: {
    isRtcLive: () => boolean;
    onFrame: () => void;
    onPcm: (rate: number, samples: Int16Array) => void;
    onRtt?: (ms: number) => void;
    onViewersVisible?: (on: boolean) => void;
    unlocked?: () => boolean;
    markUnlocked?: () => void;
  },
): { stop: () => void; setRtc: (on: boolean) => void } {
  let stopped = false;
  let pingN = 0;
  const pendingPing = new Map<number, number>();
  const ctx = canvas.getContext("2d", { alpha: false });
  let decoder: VideoDecoder | null = null;
  let waitingKey = true;
  const canDecode = typeof VideoDecoder !== "undefined";
  let audioDec: AudioDecoder | null = null;
  let audioDecReady = false;
  let compatMode: "webcodecs" | "mse" | "jpeg" = "jpeg";
  let probed = false;
  const pendingVid: { kind: number; payload: Uint8Array }[] = [];
  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  const mseQueue: Uint8Array[] = [];
  let mseReady = false;
  let mseShown = false;
  let mseHasAudio = false;
  let mseResetAt = 0;
  let mseGen = 0;
  let lastWebAt = 0;
  let statsAt = performance.now();
  let statsFrames = 0;
  let presentedFrames = 0;
  let frameCallback = 0;
  const countPresentedFrame = (): void => {
    if (stopped) return;
    presentedFrames++;
    frameCallback = mseVideo.requestVideoFrameCallback(countPresentedFrame);
  };
  if (typeof mseVideo.requestVideoFrameCallback === "function") {
    frameCallback = mseVideo.requestVideoFrameCallback(countPresentedFrame);
  }
  let statsBytes = 0;
  let lastNeedInitAt = 0;
  let lastWebmMime: string | undefined;
  const pendingWeb: { kind: number; payload: Uint8Array }[] = [];
  const mseAudio = document.querySelector<HTMLAudioElement>("#compatAudio");
  let audioSource: MediaSource | null = null;
  let audioBuffer: SourceBuffer | null = null;
  const audioQueue: Uint8Array[] = [];
  let audioReady = false;
  let audioGen = 0;
  let audioMime: string | undefined;
  let audioStalled = false;
  let audioHadInit = false;

  const closeDec = (): void => {
    try {
      decoder?.close();
    } catch {
      /* ignore */
    }
    decoder = null;
    waitingKey = true;
  };

  const flushMse = (): void => {
    if (!sourceBuffer || sourceBuffer.updating || !mseQueue.length) return;
    if (mseVideo.error) {
      mseQueue.length = 0;
      return;
    }
    const next = mseQueue.shift();
    if (!next) return;
    try {
      sourceBuffer.appendBuffer(copyAb(next));
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "QuotaExceededError") {
        try {
          const b = sourceBuffer.buffered;
          if (b.length) {
            const end = b.end(b.length - 1);
            const start = b.start(0);
            if (end - start > 2) sourceBuffer.remove(start, end - 1.5);
          }
        } catch {
          /* ignore */
        }
        mseQueue.unshift(next);
        return;
      }
      mseQueue.length = 0;
      console.warn("[ezscreenshare] mse append", err);
    }
  };

  const isUnlocked = (): boolean => Boolean(opts.unlocked?.());

  const showTapPlay = (need: boolean): void => {
    const el = document.querySelector("#tapPlay");
    if (!el) return;
    if (need && !isUnlocked()) el.classList.remove("hidden");
    else el.classList.add("hidden");
  };

  const bufferEnd = (): number => {
    try {
      const b = mseVideo.buffered;
      if (!b.length) return 0;
      return b.end(b.length - 1);
    } catch {
      return 0;
    }
  };

  let lastPlayTry = 0;
  let liveBuffer = new LiveBuffer();
  let recentStalls = 0;
  const keepPlaying = (): void => {
    if (stopped || opts.isRtcLive() || !mseVideo.src) return;
    if (!mseVideo.buffered.length) return;
    const now = performance.now();
    if (now - lastPlayTry < 120) return;
    lastPlayTry = now;
    mseVideo.muted = true;
    mseVideo.volume = 0;
    mseVideo.controls = true;
    try {
      const b = mseVideo.buffered;
      const lastStart = b.start(b.length - 1);
      const lastEnd = b.end(b.length - 1);
      const cur = mseVideo.currentTime;
      const ahead = lastEnd - Math.max(cur, lastStart);
      const decision = liveBuffer.update(now, ahead);
      if (!decision.play) {
        if (!mseVideo.paused) mseVideo.pause();
        return;
      }
      if (cur < lastStart || decision.seekBehind !== null) {
        mseVideo.currentTime = Math.max(lastStart, lastEnd - (decision.seekBehind ?? liveBuffer.target));
      }
      // PCM uses its own audio clock: do not time-stretch only the video.
      if (mseVideo.playbackRate !== 1) mseVideo.playbackRate = 1;
    } catch {
      /* ignore */
    }
    const p = mseVideo.play();
    if (!p) return;
    void p.then(() => opts.markUnlocked?.()).catch((err: unknown) => {
      const name = err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : "";
      if (name === "NotAllowedError" && compatMode !== "mse") showTapPlay(true);
    });
  };

  const requestJpeg = (): void => {
    if (stopped || opts.isRtcLive() || compatMode === "jpeg") return;
    // MSE was chosen: never fall back to stills. JPEG is only for browsers
    // that cannot play WebM at all (pickCompatVideo === "jpeg").
    if (compatMode === "mse") return;
    compatMode = "jpeg";
    teardownMse(true);
    canvas.classList.remove("hidden");
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "hello", name: nick, id: identity, jpeg: true, mse: false }));
    }
  };

  const askNeedInit = (): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - lastNeedInitAt < 8000) return;
    lastNeedInitAt = now;
    ws.send(JSON.stringify({ t: "needInit" }));
  };

  const teardownMse = (hide: boolean): void => {
    mseGen++;
    mseReady = false;
    mseShown = false;
    recentStalls = 0;
    liveBuffer = new LiveBuffer();
    mseResetAt = performance.now();
    mseQueue.length = 0;
    try {
      sourceBuffer?.abort();
    } catch {
      /* ignore */
    }
    sourceBuffer = null;
    // Do not endOfStream() — Firefox marks the video as errored and we used
    // to "recover" by switching the viewer to JPEG stills.
    mediaSource = null;
    const blobUrl = mseVideo.src;
    mseVideo.removeAttribute("src");
    mseVideo.load();
    if (hide) mseVideo.classList.add("hidden");
    if (blobUrl.startsWith("blob:")) URL.revokeObjectURL(blobUrl);
  };

  const closeMse = (): void => teardownMse(compatMode !== "jpeg");

  const ensureMse = (mime?: string): void => {
    if (sourceBuffer || mediaSource) return;
    const gen = ++mseGen;
    const ms = new MediaSource();
    mediaSource = ms;
    mseVideo.controls = true;
    mseVideo.muted = true;
    mseVideo.volume = 0;
    mseVideo.playsInline = true;
    mseVideo.autoplay = true;
    const onOpen = (): void => {
      if (gen !== mseGen || sourceBuffer || stopped) return;
      try {
        ms.duration = Number.POSITIVE_INFINITY;
      } catch {
        try {
          ms.duration = 1e9;
        } catch {
          /* ignore */
        }
      }
      const candidates = [
        mime,
        "video/webm;codecs=vp8",
        'video/webm; codecs="vp8"',
        "video/webm",
      ].filter((t): t is string => Boolean(t));
      const type = candidates.find((t) => MediaSource.isTypeSupported(t)) ?? "video/webm";
      try {
        const sb = ms.addSourceBuffer(type);
        sb.addEventListener("updateend", () => {
          if (gen !== mseGen) return;
          try {
            if (sb.buffered.length && !sb.updating) {
              const start = sb.buffered.start(0);
              const end = sb.buffered.end(sb.buffered.length - 1);
              const cur = mseVideo.currentTime;
              if (end - start > 8 && cur - start > 4) sb.remove(start, Math.max(start, cur - 2));
            }
          } catch {
            /* ignore */
          }
          flushMse();
          if (mseVideo.buffered.length) keepPlaying();
        });
        sourceBuffer = sb;
        mseReady = true;
        flushMse();
      } catch (err) {
        console.warn("[ezscreenshare] mse open", err);
      }
    };
    ms.addEventListener("sourceopen", onOpen, { once: true });
    mseVideo.src = URL.createObjectURL(ms);
    mseVideo.classList.remove("hidden");
    canvas.classList.add("hidden");
    showTapPlay(false);
  };

  const flushAudioMse = (): void => {
    if (!audioBuffer || audioBuffer.updating || !audioQueue.length || !mseAudio) return;
    if (mseAudio.error) {
      audioQueue.length = 0;
      return;
    }
    const next = audioQueue.shift();
    if (!next) return;
    try {
      audioBuffer.appendBuffer(copyAb(next));
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "QuotaExceededError") {
        try {
          const b = audioBuffer.buffered;
          if (b.length) audioBuffer.remove(b.start(0), Math.max(b.start(0), b.end(b.length - 1) - 1));
        } catch {
          /* ignore */
        }
        audioQueue.unshift(next);
        return;
      }
      audioQueue.length = 0;
      console.warn("[ezscreenshare] audio mse append", err);
    }
  };

  const keepAudioPlaying = (): void => {
    if (stopped || opts.isRtcLive() || !mseAudio?.src) return;
    const hud = document.querySelector<HTMLInputElement>("#vol");
    const g = hud ? Math.max(0, Math.min(1, Number(hud.value) / 100)) : 1;
    mseAudio.volume = g;
    try {
      const b = mseAudio.buffered;
      if (!b.length) return;
      const end = b.end(b.length - 1);
      const remain = end - mseAudio.currentTime;
      if (remain < 0.3) {
        audioStalled = true;
        mseAudio.muted = true;
        mseAudio.dataset.stalled = "1";
        if (remain < 0.05) return;
      } else if (remain > 0.7) {
        audioStalled = false;
        delete mseAudio.dataset.stalled;
        mseAudio.muted = g === 0;
      }
      if (mseAudio.paused && end - b.start(0) < 0.8) return;
    } catch {
      return;
    }
    if (!audioStalled) mseAudio.muted = g === 0;
    void mseAudio.play().then(() => opts.markUnlocked?.()).catch(() => undefined);
  };

  const teardownAudioMse = (): void => {
    audioGen++;
    audioReady = false;
    audioHadInit = false;
    audioQueue.length = 0;
    try {
      audioBuffer?.abort();
    } catch {
      /* ignore */
    }
    audioBuffer = null;
    audioSource = null;
    if (!mseAudio) return;
    const blobUrl = mseAudio.src;
    mseAudio.removeAttribute("src");
    mseAudio.load();
    if (blobUrl.startsWith("blob:")) URL.revokeObjectURL(blobUrl);
  };

  const ensureAudioMse = (mime?: string): void => {
    if (!mseAudio || audioBuffer || audioSource) return;
    const gen = ++audioGen;
    const ms = new MediaSource();
    audioSource = ms;
    mseAudio.autoplay = true;
    mseAudio.controls = false;
    const onOpen = (): void => {
      if (gen !== audioGen || audioBuffer || stopped) return;
      try {
        ms.duration = Number.POSITIVE_INFINITY;
      } catch {
        try {
          ms.duration = 1e9;
        } catch {
          /* ignore */
        }
      }
      const candidates = [
        mime,
        "audio/webm;codecs=opus",
        'audio/webm; codecs="opus"',
        "audio/webm",
      ].filter((t): t is string => Boolean(t));
      const type = candidates.find((t) => MediaSource.isTypeSupported(t)) ?? "audio/webm";
      try {
        const sb = ms.addSourceBuffer(type);
        try {
          sb.mode = "sequence";
        } catch {
          /* Firefox may lock this after the first append */
        }
        sb.addEventListener("updateend", () => {
          if (gen !== audioGen) return;
          flushAudioMse();
          if (mseAudio.buffered.length) keepAudioPlaying();
        });
        audioBuffer = sb;
        audioReady = true;
        flushAudioMse();
      } catch (err) {
        console.warn("[ezscreenshare] audio mse open", err);
      }
    };
    ms.addEventListener("sourceopen", onOpen, { once: true });
    mseAudio.src = URL.createObjectURL(ms);
  };

  const closeAudioDec = (): void => {
    try {
      audioDec?.close();
    } catch {
      /* ignore */
    }
    audioDec = null;
    audioDecReady = false;
  };

  const ensureDec = (codec: string, w: number, h: number): VideoDecoder | null => {
    if (!canDecode) return null;
    if (decoder && decoder.state === "configured") return decoder;
    closeDec();
    const next = new VideoDecoder({
      output(frame) {
        if (!ctx || opts.isRtcLive()) {
          frame.close();
          return;
        }
        if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
        ctx.drawImage(frame, 0, 0);
        frame.close();
        canvas.classList.remove("hidden");
        opts.onFrame();
      },
      error(err) {
        console.warn("[ezscreenshare] decode", err);
      },
    });
    next.configure({ codec, codedWidth: w, codedHeight: h });
    decoder = next;
    waitingKey = true;
    return next;
  };

  const ensureAudioDec = (cfg: {
    codec: string;
    sampleRate: number;
    channels: number;
    description?: Uint8Array;
  }): AudioDecoder | null => {
    if (typeof AudioDecoder === "undefined") return null;
    if (audioDec && audioDec.state === "configured") return audioDec;
    closeAudioDec();
    const next = new AudioDecoder({
      output(frame) {
        if (opts.isRtcLive()) {
          frame.close();
          return;
        }
        const n = frame.numberOfFrames;
        const f32 = new Float32Array(n);
        frame.copyTo(f32, { planeIndex: 0 });
        const samples = new Int16Array(n);
        for (let i = 0; i < n; i++) {
          const v = Math.max(-1, Math.min(1, f32[i]!));
          samples[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        opts.onPcm(frame.sampleRate, samples);
        frame.close();
      },
      error(err) {
        console.warn("[ezscreenshare] opus decode", err);
        audioDecReady = false;
      },
    });
    const init: AudioDecoderConfig = {
      codec: cfg.codec || "opus",
      sampleRate: cfg.sampleRate,
      numberOfChannels: cfg.channels || 1,
    };
    if (cfg.description && cfg.description.byteLength) init.description = copyAb(cfg.description);
    try {
      next.configure(init);
    } catch {
      delete init.description;
      next.configure(init);
    }
    audioDec = next;
    audioDecReady = true;
    return next;
  };

  const handleOpus = (kind: number, payload: Uint8Array): void => {
    if (opts.isRtcLive() || mseHasAudio || compatMode === "mse") return;
    if (kind === OPUS_CFG) {
      try {
        const cfg = JSON.parse(new TextDecoder().decode(payload)) as {
          codec?: string;
          sampleRate?: number;
          channels?: number;
          description?: string;
        };
        if (!cfg.sampleRate) return;
        ensureAudioDec({
          codec: cfg.codec || "opus",
          sampleRate: cfg.sampleRate,
          channels: cfg.channels || 1,
          description: cfg.description ? b64ToU8(cfg.description) : undefined,
        });
      } catch {
        /* ignore */
      }
      return;
    }
    if (kind === OPUS_FRAME) {
      if (payload.length < 6 || !audioDec || audioDec.state !== "configured" || !audioDecReady) return;
      if (audioDec.decodeQueueSize > 16) return;
      const key = payload[0] === 1;
      const ts = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(1, true);
      try {
        audioDec.decode(
          new EncodedAudioChunk({
            type: key ? "key" : "delta",
            timestamp: ts,
            data: copyAb(payload.subarray(5)),
          }),
        );
      } catch (err) {
        console.warn("[ezscreenshare] opus chunk", err);
        audioDecReady = false;
      }
    }
  };

  const showCompatVideo = (): void => {
    canvas.classList.add("hidden");
    mseVideo.classList.remove("hidden");
    opts.onFrame();
  };

  const handleVid = (kind: number, payload: Uint8Array): void => {
    if (opts.isRtcLive()) return;
    if (!probed) {
      pendingVid.push({ kind, payload: new Uint8Array(payload) });
      return;
    }
    if (kind === VID_CFG) {
      try {
        const cfg = JSON.parse(new TextDecoder().decode(payload)) as {
          codec?: string;
          w?: number;
          h?: number;
        };
        if (cfg.codec && cfg.w && cfg.h && compatMode !== "mse") {
          ensureDec(cfg.codec, cfg.w, cfg.h);
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (kind === VID_JPEG) {
      if (compatMode !== "jpeg") return;
      const blob = new Blob([copyAb(payload)], { type: "image/jpeg" });
      void createImageBitmap(blob).then((bmp) => {
        if (stopped || opts.isRtcLive() || !ctx) {
          bmp.close();
          return;
        }
        if (canvas.width !== bmp.width) canvas.width = bmp.width;
        if (canvas.height !== bmp.height) canvas.height = bmp.height;
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        canvas.classList.remove("hidden");
        opts.onFrame();
      });
      return;
    }
    if (kind === VID_FRAME) {
      if (payload.length < 6) return;
      const key = payload[0] === 1;
      const ts = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(1, true);
      const data = payload.subarray(5);
      if (compatMode === "mse") return;
      if (!decoder || decoder.state !== "configured") return;
      if (waitingKey && !key) return;
      if (decoder.decodeQueueSize > 8 && !key) return;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: key ? "key" : "delta",
            timestamp: ts,
            data: copyAb(data),
          }),
        );
        if (key) waitingKey = false;
      } catch (err) {
        console.warn("[ezscreenshare] decode chunk", err);
        waitingKey = true;
      }
    }
  };

  const handleWeb = (kind: number, payload: Uint8Array): void => {
    if (opts.isRtcLive()) return;
    if (!probed) {
      pendingWeb.push({ kind, payload: new Uint8Array(payload) });
      return;
    }
    if (compatMode !== "mse") return;
    if (kind === WEB_CFG) {
      try {
        const cfg = JSON.parse(new TextDecoder().decode(payload)) as {
          mime?: string; pipeline?: string; fps?: number; w?: number; h?: number;
        };
        console.info("[ezscreenshare] compatibility host", {
          pipeline: cfg.pipeline || "unreported (older host build)",
          requestedFps: cfg.fps ?? null,
          width: cfg.w, height: cfg.h,
        });
        // Video-only WebM. Muxed Opus in Chrome MediaRecorder corrupts LibreWolf.
        mseHasAudio = false;
        lastWebmMime = cfg.mime;
      } catch {
        lastWebmMime = undefined;
      }
      teardownMse(false);
      ensureMse(lastWebmMime);
      return;
    }
    if (kind === WEB_CHUNK) {
      lastWebAt = performance.now();
      statsBytes += payload.byteLength;
      const chunk = new Uint8Array(payload);
      if (isEbml(chunk) && mseShown) {
        teardownMse(false);
        ensureMse(lastWebmMime);
      }
      mseQueue.push(chunk);
      if (mseQueue.length > 16) {
        teardownMse(false);
        askNeedInit();
        return;
      }
      if (mseReady) flushMse();
      return;
    }
    if (kind === WEB_ACFG || kind === WEB_ACHUNK) {
      return;
    }
  };

  const handleBuf = (buf: Uint8Array): void => {
    const web = parseWeb(buf);
    if (web) {
      handleWeb(web.kind, web.payload);
      return;
    }
    const vid = parseVid(buf);
    if (vid) {
      handleVid(vid.kind, vid.payload);
      return;
    }
    const opus = parseOpus(buf);
    if (opus) {
      handleOpus(opus.kind, opus.payload);
      return;
    }
    if (isPcmPacket(buf)) {
      if (opts.isRtcLive()) return;
      const rate = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(4, true);
      const samples = new Int16Array(
        buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + buf.byteLength),
      );
      opts.onPcm(rate, samples);
    }
  };

  let wantPcm = false;
  const sendHello = (): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        t: "hello",
        name: nick,
        id: identity,
        jpeg: compatMode === "jpeg",
        mse: compatMode === "mse",
        pcm: wantPcm,
      }),
    );
  };

  mseVideo.addEventListener("loadeddata", () => {
    mseShown = true;
    showCompatVideo();
    if (isUnlocked()) {
      showTapPlay(false);
      keepPlaying();
    }
    opts.onFrame();
  });
  mseVideo.addEventListener("playing", () => {
    opts.markUnlocked?.();
    showTapPlay(false);
    opts.onFrame();
  });
  mseVideo.addEventListener("pause", () => {
    if (stopped || opts.isRtcLive() || compatMode !== "mse" || !isUnlocked()) return;
    if (mseVideo.buffered.length) keepPlaying();
  });
  mseVideo.addEventListener("waiting", () => {
    if (opts.isRtcLive()) return;
    if (mseShown && !liveBuffer.waiting) recentStalls++;
    liveBuffer.stalled(performance.now());
    if (isUnlocked()) keepPlaying();
  });
  mseAudio?.addEventListener("waiting", () => {
    audioStalled = true;
    if (mseAudio) {
      mseAudio.muted = true;
      mseAudio.dataset.stalled = "1";
    }
  });
  mseAudio?.addEventListener("playing", () => {
    audioStalled = false;
    if (mseAudio) delete mseAudio.dataset.stalled;
    opts.markUnlocked?.();
    keepAudioPlaying();
  });
  mseAudio?.addEventListener("pause", () => {
    if (stopped || opts.isRtcLive() || compatMode !== "mse") return;
    keepAudioPlaying();
  });
  const onVis = (): void => {
    if (!mseAudio || compatMode !== "mse") return;
    if (document.hidden) {
      audioStalled = true;
      mseAudio.muted = true;
      mseAudio.dataset.stalled = "1";
      return;
    }
    keepAudioPlaying();
  };
  document.addEventListener("visibilitychange", onVis);

  const ws = openFallback(`/ws/watch/${encodeURIComponent(roomId)}`, watchToken);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    void (async () => {
      compatMode = await pickCompatVideo();
      wantPcm = compatMode !== "webcodecs";
      probed = true;
      console.info("[ezscreenshare] compatibility ready", compatMode, wantPcm ? "pcm" : "opus");
      sendHello();
      if (compatMode === "mse") {
        mseVideo.controls = true;
        mseVideo.classList.remove("hidden");
        showTapPlay(false);
        if (isUnlocked()) keepPlaying();
        opts.onFrame();
      } else {
        showTapPlay(true);
      }
      const queued = pendingVid.splice(0, pendingVid.length);
      for (const p of queued) handleVid(p.kind, p.payload);
      const queuedWeb = pendingWeb.splice(0, pendingWeb.length);
      for (const p of queuedWeb) handleWeb(p.kind, p.payload);
    })();
  });
  const pingTimer = window.setInterval(() => {
    if (stopped || ws.readyState !== WebSocket.OPEN) return;
    pingN = (pingN + 1) % 1_000_000;
    pendingPing.set(pingN, performance.now());
    if (pendingPing.size > 8) pendingPing.delete(pendingPing.keys().next().value!);
    ws.send(JSON.stringify({ t: "ping", n: pingN }));
  }, 2000);
  const stallTimer = window.setInterval(() => {
    if (stopped || opts.isRtcLive() || compatMode !== "mse") return;
    const now = performance.now();
    if (now - statsAt >= 5000) {
      const seconds = (now - statsAt) / 1000;
      console.info("[ezscreenshare] compatibility video", {
        presentedFps: frameCallback ? Math.round((presentedFrames - statsFrames) / seconds) : null,
        kbps: Math.round(statsBytes * 8 / seconds / 1000),
        bufferedSeconds: Number(Math.max(0, bufferEnd() - mseVideo.currentTime).toFixed(2)),
        visible: !document.hidden,
        targetBufferSeconds: liveBuffer.target,
      });
      if (ws.readyState === WebSocket.OPEN && !document.hidden && mseShown) {
        ws.send(JSON.stringify({ t: "playback", stalls: recentStalls, buffered: Math.max(0, bufferEnd() - mseVideo.currentTime) }));
      }
      recentStalls = 0;
      statsAt = now;
      statsFrames = presentedFrames;
      statsBytes = 0;
    }
    if (lastWebAt && now - lastWebAt > 2500) askNeedInit();
    if (mseVideo.buffered.length && lastWebAt && now - lastWebAt < 1000) keepPlaying();
    if (mseAudio && mseAudio.buffered.length) keepAudioPlaying();
  }, 400);
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data) as { t?: string; n?: number; on?: boolean; showViewers?: boolean };
        if (msg.t === "pong" && typeof msg.n === "number") {
          const t0 = pendingPing.get(msg.n);
          pendingPing.delete(msg.n);
          if (t0 != null) {
            const ms = Math.round(performance.now() - t0);
            ws.send(JSON.stringify({ t: "rtt", ms }));
            opts.onRtt?.(ms);
          }
        } else if (msg.t === "viewersVisible" && typeof msg.on === "boolean") {
          opts.onViewersVisible?.(msg.on);
        } else if (msg.t === "hello" && typeof msg.showViewers === "boolean") {
          opts.onViewersVisible?.(msg.showViewers);
        }
      } catch {
        /* ignore */
      }
      return;
    }
    handleBuf(new Uint8Array(ev.data as ArrayBuffer));
  });
  const setRtc = (on: boolean): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "rtc", on }));
    if (on) {
      canvas.classList.add("hidden");
      mseVideo.classList.add("hidden");
      showTapPlay(false);
    } else if (compatMode === "mse") {
      mseVideo.controls = true;
      mseVideo.classList.remove("hidden");
      showTapPlay(false);
      keepPlaying();
    }
  };
  return {
    setRtc,
    stop() {
      stopped = true;
      window.clearInterval(pingTimer);
      window.clearInterval(stallTimer);
      if (frameCallback) mseVideo.cancelVideoFrameCallback(frameCallback);
      closeDec();
      closeAudioDec();
      closeMse();
      teardownAudioMse();
      document.removeEventListener("visibilitychange", onVis);
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
}

function viewerIdentity(): string {
  const key = "ezscreenshare.viewerId";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `v-${crypto.randomUUID()}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function applyQuality(track: MediaStreamTrack, height: number, fps: number): void {
  const width = Math.round(height * (16 / 9));
  const hint = contentHintFor(fps);
  try {
    (track as MediaStreamTrack & { contentHint?: string }).contentHint = hint;
  } catch {
    /* ignore */
  }
  void track.applyConstraints({
    frameRate: { ideal: fps, max: fps },
    width: { ideal: width, max: width },
    height: { ideal: height, max: height },
    // @ts-expect-error Chromium desktop capture
    resizeMode: "crop-and-scale",
  });
}

async function getStream(opts: {
  sourceId?: string;
  audio: boolean;
  height: number;
  fps: number;
}): Promise<MediaStream> {
  if (isElectron && window.ez && opts.sourceId) {
    await window.ez.setCapture(opts.sourceId, opts.audio);
  }
  const selection = readAudioSelection();
  const windowsLoopback = isElectron && desktopPlatform() === "win32" && (!selection.apps.length || !window.ez?.beginWindowsAudio);
  if (opts.audio && windowsLoopback && selection.apps.length) throw new Error("Restart the updated desktop app to select Windows audio applications.");
  const wantsAudio = opts.audio && !(isElectron && selection.mode === "include" && !selection.apps.length);
  if (windowsLoopback) {
    stopMacAudio();
    await window.ez?.releaseAudioTap();
    await window.ez?.setCaptureAudio?.(wantsAudio);
  }
  const display: DisplayMediaStreamOptions = {
    video: {
      frameRate: { ideal: opts.fps },
      height: { ideal: opts.height },
      width: { ideal: Math.round(opts.height * (16 / 9)) },
    },
    // Electron/Linux: PipeWire loopback is silent. Monitor is added below.
    audio: wantsAudio && (!isElectron || windowsLoopback)
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : false,
  };
  if (!isElectron && opts.audio) {
    (display as DisplayMediaStreamOptions & { systemAudio?: string }).systemAudio = "include";
  }
  const stream = await navigator.mediaDevices.getDisplayMedia(display);
  const video = stream.getVideoTracks()[0];
  if (video) applyQuality(video, opts.height, opts.fps);
  if (wantsAudio && windowsLoopback) {
    lastAudioLabel = stream.getAudioTracks().length ? "Entire system" : "";
    if (!stream.getAudioTracks().length) console.warn("[ezscreenshare] Windows loopback returned no audio track");
  } else if (wantsAudio && isElectron) {
    try { await addSystemAudio(stream); }
    catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  } else if (opts.audio) {
    const a = stream.getAudioTracks()[0];
    if (a) a.contentHint = "music";
    lastAudioLabel = a?.label || (a ? "tab audio" : "");
    if (!a) {
      console.warn("[ezscreenshare] browser capture has no audio track — tick Share tab audio, or use the desktop app");
    }
  }
  return stream;
}

let lastAudioLabel = "";

function desktopPlatform(): string {
  return window.ez?.platform ?? (/Win/.test(navigator.platform) ? "win32" : /Mac/.test(navigator.platform) ? "darwin" : "linux");
}

function readAudioSelection(): AudioSelection {
  try {
    const saved = localStorage.getItem("ezscreenshare.audioSelection");
    if (saved) return normalizeAudioSelection(JSON.parse(saved));
  } catch { /* migrate the previous single-source setting */ }
  return normalizeAudioSelection(localStorage.getItem("ezscreenshare.audioSrc") || "system");
}

async function addSystemAudio(stream: MediaStream): Promise<void> {
  stopMacAudio();
  lastAudioLabel = "";
  for (const t of stream.getAudioTracks()) {
    stream.removeTrack(t);
    t.stop();
  }
  const constraints: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  const wanted = readAudioSelection();
  if (wanted.mode === "include" && !wanted.apps.length) {
    await window.ez?.releaseAudioTap();
    return;
  }
  if (desktopPlatform() === "darwin" || (desktopPlatform() === "win32" && wanted.apps.length > 0 && window.ez?.beginWindowsAudio)) {
    lastAudioLabel = await startMacAudio(stream, wanted, error => {
      const status = document.querySelector("#audioState");
      if (status) status.textContent = error;
    });
    return;
  }
  if (desktopPlatform() === "win32") {
    if (wanted.apps.length) throw new Error("Restart the updated desktop app to select Windows audio applications.");
    await window.ez?.releaseAudioTap();
    await window.ez?.setCaptureAudio?.(true);
    const extra = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: constraints });
    extra.getVideoTracks().forEach(track => track.stop());
    extra.getAudioTracks().forEach(track => stream.addTrack(track));
    lastAudioLabel = extra.getAudioTracks().length ? "Entire system" : "";
    return;
  }
  if (window.ez?.beginMonitorCapture) {
    let request: string | AudioSelection = wanted;
    if (!window.ez.audioSelectionVersion) {
      if (wanted.mode === "exclude" && !wanted.apps.length) request = "system";
      else if (wanted.mode === "include" && wanted.apps.length === 1) request = `app:${wanted.apps[0]}`;
      else throw new Error("Restart the desktop app from the updated project to select multiple audio sources.");
    }
    const session = await window.ez.beginMonitorCapture(request);
    try {
      if (session.ok) {
        const hints = (session.hints?.length ? session.hints : [session.label, "ezscreenshare"])
          .filter(Boolean)
          .map((h) => h.toLowerCase());
        let pick: MediaDeviceInfo | undefined;
        for (let i = 0; i < 10 && !pick; i++) {
          if (i) await new Promise((r) => setTimeout(r, 80));
          const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
            (d) => d.kind === "audioinput",
          );
          pick = inputs.find((d) => {
            const l = d.label.toLowerCase();
            return hints.some((h) => l === h || l.includes(h) || h.includes(l));
          });
          if (!pick && i === 9) {
            console.warn(
              "[ezscreenshare] virtual source not in Chromium device list",
              inputs.map((d) => d.label),
            );
          }
        }
        if (!pick) return;
        const extra = await navigator.mediaDevices.getUserMedia({
          audio: { ...constraints, deviceId: { exact: pick.deviceId } },
        });
        for (const t of extra.getAudioTracks()) {
          t.contentHint = "music";
          stream.addTrack(t);
        }
        lastAudioLabel = session.label || pick.label;
        console.info("[ezscreenshare] system audio", lastAudioLabel, pick.deviceId);
        return;
      }
    } catch (e) {
      console.warn("[ezscreenshare] monitor capture failed", e);
    } finally {
      await window.ez.endMonitorCapture(session.prev);
    }
  }
  throw new Error("Could not capture the selected applications. Check PipeWire and restart the desktop app.");
}

async function copyText(text: string): Promise<void> {
  if (window.ez?.copyText) {
    await window.ez.copyText(text);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* execCommand fallback */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

function renderHost(): void {
  app.innerHTML = h(`
    <div class="wrap">
      <div class="top">
        <div>
          <div class="brand">ez<span>screenshare</span></div>
          <div class="sub">${isElectron ? "desktop host" : "browser host (Linux/macOS system audio needs the app)"}</div>
        </div>
        <button class="btn secondary" id="theme" type="button">light</button>
      </div>
      <form id="setup" class="panel">
        <div class="row">
          <label class="field">nickname
            <input id="nick" type="text" maxlength="32" />
          </label>
          <label class="field">host key
            <input id="hostKey" type="password" autocomplete="off" />
          </label>
          <label class="field">viewer password (optional)
            <input id="password" type="password" autocomplete="off" />
          </label>
        </div>
        <div class="row">
          <label class="field">resolution
            <select id="res">
              <option value="480">480p</option>
              <option value="720" selected>720p</option>
              <option value="1080">1080p</option>
              <option value="1440">1440p</option>
            </select>
          </label>
          ${fpsSelectHtml("fps", 30)}
        </div>
        <div class="row">
          <label class="check ${isElectron ? "" : "hidden"}"><input id="audio" type="checkbox" checked /> share audio</label>
          <label class="check"><input id="tcp" type="checkbox" checked /> force TCP</label>
          <label class="check"><input id="showViewers" type="checkbox" checked /> viewers see who's watching</label>
          <label class="check"><input id="linkPreviews" type="checkbox" /> embeds have thumbnail preview (only passwordless streams; updated every minute)</label>
        </div>
        <div class="desktop-filter-wrap hidden" id="desktopFilters">
          <div class="source-heading">desktops</div>
          <div class="desktop-tabs" role="group" aria-label="Show video sources from desktops"></div>
        </div>
        <div class="row ${isElectron ? "" : "hidden"}" id="audioSrcRow">
          <div class="field">audio sources
            <details class="audio-picker" id="audioSrc"><summary>Entire system</summary><div class="audio-menu"><input class="audio-search" type="search" placeholder="Search audio sources…" aria-label="Search audio sources" /><div class="audio-options"></div><p class="audio-empty hidden" role="status">No matching sources</p></div></details>
          </div>
        </div>
        <div id="sourceWrap" class="${isElectron ? "" : "hidden"}">
          <p class="source-heading">video sources</p>
          <div id="sources" class="sources"></div>
        </div>
        <div class="row">
          <button class="btn" id="start" type="submit">start stream</button>
          <button class="btn secondary ${isElectron ? "" : "hidden"}" id="refresh" type="button">refresh sources</button>
        </div>
        <div class="err" id="err"></div>
      </form>
      <div id="live" class="hidden">
        <div class="stage"><video id="preview" autoplay muted playsinline></video></div>
        <div class="hud">
          <div class="hud-status">
            <span class="pill live">LIVE</span>
            <span class="pill" id="ping">ping —</span>
            <span class="pill hidden" id="stats">—</span>
            <span class="pill" id="audioState">audio ?</span>
          </div>
          <div class="linkbox">
            <input id="link" class="mono" type="text" readonly />
            <button class="btn secondary" id="copy" type="button">copy link</button>
          </div>
          <div class="hud-actions">
            <label class="check"><input id="showViewersLive" type="checkbox" checked /> viewers see who's watching</label>
            <label class="check"><input id="linkPreviewsLive" type="checkbox" /> embeds have thumbnail preview (only passwordless streams; updated every minute)</label>
            <button class="btn secondary" id="statsToggle" type="button">stats</button>
            <button class="btn secondary" id="switch" type="button">change source</button>
            <button class="btn secondary ${isElectron ? "" : "hidden"}" id="refreshLive" type="button">refresh sources</button>
            <button class="btn secondary" id="stop" type="button">stop</button>
          </div>
        </div>
        <div class="err" id="liveErr" role="status"></div>
        <div id="liveSources" class="live-sources hidden">
          <p class="source-heading">video sources</p>
          <div id="liveSourceGrid" class="sources"></div>
        </div>
        <div class="row">
          <label class="field">resolution
            <select id="resLive">
              <option value="480">480p</option>
              <option value="720">720p</option>
              <option value="1080">1080p</option>
              <option value="1440">1440p</option>
            </select>
          </label>
          ${fpsSelectHtml("fpsLive")}
          <div class="desktop-filter-wrap hidden" id="desktopFiltersLive">
            <div class="source-heading">desktops</div>
            <div class="desktop-tabs" role="group" aria-label="Show video sources from desktops"></div>
          </div>
          <div class="field ${isElectron ? "" : "hidden"}" id="audioSrcLiveWrap">audio sources
            <details class="audio-picker" id="audioSrcLive"><summary>Entire system</summary><div class="audio-menu"><input class="audio-search" type="search" placeholder="Search audio sources…" aria-label="Search audio sources" /><div class="audio-options"></div><p class="audio-empty hidden" role="status">No matching sources</p></div></details>
          </div>
        </div>
        <div class="panel people-panel">
          <div class="sub">connected</div>
          <ul class="people" id="people"></ul>
        </div>
      </div>
    </div>
  `);

  bindThemeToggle();
  const nick = qs<HTMLInputElement>("#nick");
  nick.value = localStorage.getItem(nickKey) || "host";
  const hostKeyInput = qs<HTMLInputElement>("#hostKey");
  const showViewersSetup = qs<HTMLInputElement>("#showViewers");
  const showViewersLive = qs<HTMLInputElement>("#showViewersLive");
  showViewersSetup.checked = localStorage.getItem(showViewersKey) !== "0";
  showViewersLive.checked = showViewersSetup.checked;
  hostKeyInput.value = localStorage.getItem(hostKey) || "";
  const resolutionInput = qs<HTMLSelectElement>("#res");
  const fpsInput = qs<HTMLSelectElement>("#fps");
  const viewerPasswordInput = qs<HTMLInputElement>("#password");
  const linkPreviews = qs<HTMLInputElement>("#linkPreviews");
  const linkPreviewsLive = qs<HTMLInputElement>("#linkPreviewsLive");
  linkPreviews.checked = localStorage.getItem("ezscreenshare.linkPreviews") !== "0";
  function syncPreviewPassword(): void {
    linkPreviews.disabled = Boolean(viewerPasswordInput.value.trim());
  }
  viewerPasswordInput.addEventListener("input", syncPreviewPassword);
  const audioInput = qs<HTMLInputElement>("#audio");
  const tcpInput = qs<HTMLInputElement>("#tcp");
  for (const [input, key] of [[resolutionInput, "resolution"], [fpsInput, "fps"]] as const) {
    const saved = localStorage.getItem(`ezscreenshare.${key}`);
    if (saved && [...input.options].some(option => option.value === saved)) input.value = saved;
  }
  viewerPasswordInput.value = localStorage.getItem("ezscreenshare.viewerPassword") || "";
  syncPreviewPassword();
  audioInput.checked = localStorage.getItem("ezscreenshare.shareAudio") !== "0";
  tcpInput.checked = localStorage.getItem("ezscreenshare.forceTcp") !== "0";
  function saveHostSettings(): void {
    localStorage.setItem("ezscreenshare.linkPreviews", linkPreviews.checked ? "1" : "0");
    localStorage.setItem(nickKey, nick.value.trim() || "host");
    localStorage.setItem(hostKey, hostKeyInput.value);
    localStorage.setItem("ezscreenshare.resolution", resolutionInput.value);
    localStorage.setItem("ezscreenshare.fps", fpsInput.value);
    localStorage.setItem("ezscreenshare.viewerPassword", viewerPasswordInput.value);
    localStorage.setItem("ezscreenshare.shareAudio", audioInput.checked ? "1" : "0");
    localStorage.setItem("ezscreenshare.forceTcp", tcpInput.checked ? "1" : "0");
    localStorage.setItem(showViewersKey, showViewersSetup.checked ? "1" : "0");
  }
  qs("#setup").addEventListener("input", saveHostSettings);
  qs("#setup").addEventListener("change", saveHostSettings);
  const err = qs("#err");
  const liveErr = qs("#liveErr");
  let selected: Source | null = null;
  let room: Room | null = null;
  let localStream: MediaStream | null = null;
  let videoPub: LocalTrackPublication | null = null;
  let audioPub: LocalTrackPublication | null = null;
  let ingest: ReturnType<typeof startIngest> | null = null;
  let previewSession: CreateResp | null = null;
  let previewTimer: number | undefined;
  let previewBusy = false;
  async function uploadPreview(): Promise<boolean> {
    const session = previewSession;
    if (!session || !linkPreviewsLive.checked || linkPreviewsLive.disabled || previewBusy) return false;
    const video = qs<HTMLVideoElement>("#preview");
    if (video.readyState < 2 || !video.videoWidth || !localStream?.getVideoTracks().some(t => t.readyState === "live")) return false;
    previewBusy = true;
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 960 / video.videoWidth, 540 / video.videoHeight);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.75));
      if (!blob || previewSession !== session || !linkPreviewsLive.checked) return false;
      const response = await fetch(`/api/rooms/${session.roomId}/preview`, {
        method: "POST", headers: { authorization: `Bearer ${session.ingestToken}`, "content-type": "image/jpeg" }, body: blob,
      });
      if (!response.ok) throw new Error("Preview upload failed");
      return true;
    } catch (error) { console.warn("Link preview", error); return false; }
    finally { previewBusy = false; }
  }
  linkPreviewsLive.addEventListener("change", async () => {
    const session = previewSession;
    if (!session) return;
    linkPreviewsLive.disabled = true;
    try {
      const response = await fetch(`/api/rooms/${session.roomId}/preview`, {
        method: "POST", headers: { authorization: `Bearer ${session.ingestToken}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: linkPreviewsLive.checked }),
      });
      if (!response.ok) throw new Error("Could not change link previews. Please retry.");
      linkPreviews.checked = linkPreviewsLive.checked;
      saveHostSettings();
    } catch (error) {
      linkPreviewsLive.checked = !linkPreviewsLive.checked;
      liveErr.textContent = String(error);
    } finally { linkPreviewsLive.disabled = false; }
    void uploadPreview();
  });
  let fallbackWatchers: CompatWatcher[] = [];
  const pingById = new Map<string, number>();
  let stopPing: (() => void) | null = null;
  let stopStats: (() => void) | null = null;
  let virtualDesktops: VirtualDesktop[] = [];
  const excludedDesktops = new Set<string>();
  function applyDesktopFilter(): void {
    for (const card of document.querySelectorAll<HTMLElement>(".source")) {
      card.classList.toggle("hidden", Boolean(card.dataset.desktopId && excludedDesktops.has(card.dataset.desktopId)));
    }
    // Filtering changes the list, never the live capture. Before a stream,
    // require a visible source so a hidden selection cannot be shared by mistake.
    if (!room && selected?.desktopId && excludedDesktops.has(selected.desktopId)) {
      selected = null;
      qs("#sources").querySelectorAll(".selected").forEach(card => card.classList.remove("selected"));
    }
  }
  function drawDesktopFilters(): void {
    for (const id of ["desktopFilters", "desktopFiltersLive"]) {
      const root = qs(`#${id}`);
      root.classList.toggle("hidden", virtualDesktops.length === 0);
      const tabs = root.querySelector(".desktop-tabs")!;
      tabs.replaceChildren();
      for (const desktop of virtualDesktops) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "desktop-tab";
        button.dataset.desktopId = desktop.id;
        button.textContent = desktop.name;
        button.setAttribute("aria-pressed", String(!excludedDesktops.has(desktop.id)));
        button.title = desktop.current ? `${desktop.name} (current)` : desktop.name;
        button.addEventListener("click", () => {
          if (excludedDesktops.has(desktop.id)) excludedDesktops.delete(desktop.id);
          else excludedDesktops.add(desktop.id);
          drawDesktopFilters();
          applyDesktopFilter();
          root.querySelector<HTMLButtonElement>(`[data-desktop-id="${desktop.id}"]`)?.focus();
        });
        tabs.append(button);
      }
    }
  }

  async function loadSources(box: HTMLElement, onPick?: (s: Source) => void, errorTarget = err): Promise<void> {
    if (!window.ez) return;
    let sources: Source[] = [];
    try {
      if (window.ez.getSourceCatalog) {
        const catalog = await window.ez.getSourceCatalog();
        sources = catalog.sources;
        virtualDesktops = catalog.desktops;
        drawDesktopFilters();
      } else sources = await window.ez.getSources();
    } catch (e) {
      errorTarget.textContent = e instanceof Error ? e.message : String(e);
      return;
    }
    box.innerHTML = "";
    for (const s of sources) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "source";
      if (s.desktopId) btn.dataset.desktopId = s.desktopId;
      const desktopName = virtualDesktops.find(desktop => desktop.id === s.desktopId)?.name;
      btn.title = [s.name, desktopName, s.onCurrentDesktop === false ? "Switch to this desktop if the window is paused or unavailable." : ""].filter(Boolean).join(" · ");
      if (selected?.id === s.id) btn.classList.add("selected");
      const img = document.createElement("img");
      img.alt = "";
      img.src = s.thumbnail;
      const cap = document.createElement("figcaption");
      cap.textContent = s.kind === "screen" && desktopPlatform() === "win32" ? `Full display: ${s.name}` : s.name;
      if (s.thumbnail) btn.append(img);
      else {
        const placeholder = document.createElement("span");
        placeholder.className = "source-placeholder";
        placeholder.textContent = desktopName || "window";
        btn.append(placeholder);
      }
      btn.append(cap);
      btn.addEventListener("click", () => {
        selected = s;
        for (const el of box.querySelectorAll(".source")) el.classList.remove("selected");
        btn.classList.add("selected");
        onPick?.(s);
      });
      box.appendChild(btn);
    }
    if (!selected && !onPick) {
      const first = sources.find(source => !source.desktopId || !excludedDesktops.has(source.desktopId));
      if (first) {
        selected = first;
        [...box.querySelectorAll(".source")][sources.indexOf(first)]?.classList.add("selected");
      }
    }
    applyDesktopFilter();
  }

  qs("#refresh").addEventListener("click", () => {
    void Promise.all([loadSources(qs("#sources")), fillAudioSelects()]).catch(error => {
      err.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  void loadSources(qs("#sources"));

  let audioSourceOptions: { id: string; label: string }[] = [];
  function filterAudioPicker(root: HTMLElement): void {
    const query = root.querySelector<HTMLInputElement>(".audio-search")!.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const row of root.querySelectorAll<HTMLElement>(".audio-option")) {
      const show = (row.textContent || "").toLocaleLowerCase().includes(query);
      row.hidden = !show;
      if (show) matches++;
    }
    root.querySelector(".audio-empty")!.classList.toggle("hidden", matches > 0);
  }
  function drawAudioPickers(): void {
    const selection = readAudioSelection();
    const apps = audioSourceOptions.filter(source => source.id.startsWith("app:"));
    for (const app of selection.apps) {
      if (!apps.some(source => source.id === `app:${app}`)) apps.push({ id: `app:${app}`, label: `${app} (not running)` });
    }
    for (const id of ["audioSrc", "audioSrcLive"]) {
      const root = qs<HTMLElement>(`#${id}`);
      root.querySelector("summary")!.textContent = audioSelectionLabel({
        ...selection, apps: selection.apps.map(name => apps.find(source => source.id === `app:${name}`)?.label || name),
      });
      const list = root.querySelector(".audio-options")!;
      list.replaceChildren();
      for (const source of [{ id: "system", label: "Entire system" }, ...apps]) {
        const label = document.createElement("label");
        label.className = "audio-option";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.audioSource = source.id;
        input.checked = source.id === "system" ? selection.mode === "exclude" : includesAudioApp(selection, source.id.slice(4));
        const name = document.createElement("span");
        name.className = "audio-option-name";
        name.textContent = source.label;
        if (source.id === "system") {
          const hint = document.createElement("small");
          hint.textContent = "Uncheck apps below to exclude them";
          name.append(hint);
        }
        const mark = document.createElement("span");
        mark.className = "audio-checkmark";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = "✓";
        label.append(name, input, mark);
        list.append(label);
      }
      filterAudioPicker(root);
    }
  }
  let audioRefreshGeneration = 0;
  async function fillAudioSelects(): Promise<void> {
    const generation = ++audioRefreshGeneration;
    const sources = (await window.ez?.listAudioSources?.()) ?? [];
    if (generation !== audioRefreshGeneration) return;
    audioSourceOptions = sources;
    drawAudioPickers();
  }
  let audioChange = Promise.resolve();
  function changeAudioSelection(event: Event): void {
    const input = event.target as HTMLInputElement;
    const id = input.dataset.audioSource;
    if (!id) return;
    const selection = readAudioSelection();
    if (id === "system") {
      selection.mode = input.checked ? "exclude" : "include";
      selection.apps = [];
    } else {
      const name = id.slice(4);
      const listed = selection.mode === "include" ? input.checked : !input.checked;
      selection.apps = selection.apps.filter(app => app !== name);
      if (listed) selection.apps.push(name);
    }
    localStorage.setItem("ezscreenshare.audioSelection", JSON.stringify(normalizeAudioSelection(selection)));
    drawAudioPickers();
    const root = event.currentTarget as HTMLElement;
    [...root.querySelectorAll<HTMLInputElement>("input")].find(item => item.dataset.audioSource === id)?.focus();
    audioChange = audioChange.then(reattachAudio).catch(error => {
      err.textContent = error instanceof Error ? error.message : String(error);
    });
  }

  function syncAudioRow(): void {
    if (!isElectron) {
      qs("#audioSrcRow").classList.add("hidden");
      document.querySelector("#audioSrcLiveWrap")?.classList.add("hidden");
      return;
    }
    const on = qs<HTMLInputElement>("#audio").checked;
    qs("#audioSrcRow").classList.toggle("hidden", !on);
    document.querySelector("#audioSrcLiveWrap")?.classList.toggle("hidden", !on);
  }

  if (isElectron) void fillAudioSelects().catch(error => { err.textContent = String(error.message || error); });
  qs("#audio").addEventListener("change", syncAudioRow);
  syncAudioRow();
  for (const id of ["audioSrc", "audioSrcLive"]) {
    const picker = qs<HTMLDetailsElement>(`#${id}`);
    picker.querySelector(".audio-search")!.addEventListener("input", () => filterAudioPicker(picker));
    picker.addEventListener("keydown", event => {
      if (event.key === "Escape") { picker.open = false; picker.querySelector("summary")!.focus(); }
    });
    picker.addEventListener("change", changeAudioSelection);
    picker.addEventListener("toggle", () => {
      if (!picker.open) return;
      picker.querySelector<HTMLInputElement>(".audio-search")!.focus();
      void fillAudioSelects().catch(error => { err.textContent = String(error.message || error); });
    });
  }

  function people(): void {
    const ul = qs("#people");
    const rtcPeople = room
      ? [room.localParticipant, ...Array.from(room.remoteParticipants.values())]
      : [];
    const rtcIds = new Set(rtcPeople.map((p) => p.identity));
    const rtcNames = new Set(rtcPeople.map((p) => (p.name || "").toLowerCase()).filter(Boolean));
    const rows: PersonRow[] = [];
    const rttOf = (id: string, name: string): number | undefined => {
      const mapped = pingById.get(id);
      if (mapped != null) return mapped;
      const lower = name.toLowerCase();
      for (const w of fallbackWatchers) {
        if (w.rtt == null) continue;
        if (w.id && w.id === id) return w.rtt;
        if (w.name && w.name.toLowerCase() === lower) return w.rtt;
      }
      return undefined;
    };
    const watcherOf = (id: string, name: string) => {
      const lower = name.toLowerCase();
      return fallbackWatchers.find(
        (w) => (w.id && w.id === id) || (w.name && w.name.toLowerCase() === lower),
      );
    };
    const pathOf = (id: string, name: string): "live" | "compat" | undefined => {
      if (id === "host") return undefined;
      const w = watcherOf(id, name);
      if (w?.jpeg) return "compat";
      if (w?.rtc) return "live";
      if (w && w.rtc === false) return "compat";
      if (rtcIds.has(id)) return "live";
      if (w) return "compat";
      return undefined;
    };
    for (const p of rtcPeople) {
      const you = room && p === room.localParticipant ? " (you)" : "";
      const name = p.name || p.identity;
      rows.push({
        name: `${name}${you}`,
        role: p.identity === "host" ? "host" : "viewer",
        ms: rttOf(p.identity, name),
        path: pathOf(p.identity, name),
      });
    }
    for (const w of fallbackWatchers) {
      if (w.id && rtcIds.has(w.id)) continue;
      if (w.name && rtcNames.has(w.name.toLowerCase())) continue;
      rows.push({
        name: w.name || w.id || "viewer",
        role: "viewer",
        ms: w.rtt ?? (w.id ? pingById.get(w.id) : undefined),
        path: w.jpeg || w.rtc === false ? "compat" : w.rtc ? "live" : "compat",
      });
    }
    renderPeople(ul, rows);
    setPingPill(document.querySelector("#ping"), pingById.get("host"));
  }

  async function publish(stream: MediaStream, height: number, fps: number): Promise<void> {
    if (!room) return;
    const prev = localStream;
    localStream = stream;
    if (prev && prev !== stream) {
      for (const t of prev.getTracks()) {
        if (!stream.getTracks().includes(t)) t.stop();
      }
    }
    const preview = qs<HTMLVideoElement>("#preview");
    preview.muted = true;
    preview.volume = 0;
    preview.srcObject = new MediaStream(stream.getVideoTracks());
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];
    if (videoPub && video) {
      await (videoPub.track as LocalVideoTrack).replaceTrack(video);
      await applySenderQuality(videoPub, height, fps);
    } else if (video) {
      videoPub = await room.localParticipant.publishTrack(video, screenSharePublishOpts(height, fps));
      await applySenderQuality(videoPub, height, fps);
    }
    if (audio) {
      if (audioPub) await (audioPub.track as LocalAudioTrack).replaceTrack(audio);
      else {
        audioPub = await room.localParticipant.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          stream: "screenshare",
          red: false,
          dtx: false,
        });
      }
    }
    if (!audio) {
      stopMacAudio();
      await window.ez?.releaseAudioTap();
      if (audioPub?.track) {
        await room.localParticipant.unpublishTrack(audioPub.track);
        audioPub = null;
      }
    }
    video?.addEventListener("ended", () => void stop());
    const audioOn = (localStream?.getAudioTracks().length ?? 0) > 0;
    const audioState = document.querySelector<HTMLElement>("#audioState");
    if (audioState) {
      audioState.textContent = audioOn
        ? `audio on${lastAudioLabel ? ` · ${lastAudioLabel}` : ""}`
        : "no audio";
      audioState.title = lastAudioLabel;
      audioState.classList.toggle("live", !audioOn);
    }
  }

  async function start(): Promise<void> {
    err.textContent = "";
    saveHostSettings();
    if (isElectron && !selected) { err.textContent = "Choose a video source first."; return; }
    const height = Number(qs<HTMLSelectElement>("#res").value);
    const fps = Number(qs<HTMLSelectElement>("#fps").value);
    const audio = qs<HTMLInputElement>("#audio").checked;
    const forceTcp = qs<HTMLInputElement>("#tcp").checked;
    const showViewers = showViewersSetup.checked;
    localStorage.setItem(showViewersKey, showViewers ? "1" : "0");
    showViewersLive.checked = showViewers;
    let captured: MediaStream | undefined;
    try {
      const created = await api<CreateResp>("/api/rooms", {
        hostPassword: hostKeyInput.value,
        password: qs<HTMLInputElement>("#password").value,
        forceTcp,
        previews: linkPreviews.checked && !linkPreviews.disabled,
        showViewers,
        nickname: nick.value.trim() || "host",
      });
      const stream = await getStream({
        sourceId: selected?.id,
        audio,
        height,
        fps,
      });
      captured = stream;
      room = new Room(roomOpts("host"));
      room.on(RoomEvent.ParticipantConnected, people);
      room.on(RoomEvent.ParticipantDisconnected, people);
      room.on(RoomEvent.Disconnected, () => void stop());
      await room.connect(created.livekitUrl, created.token);
      stopPing?.();
      pingById.clear();
      stopPing = bindRoomPing(room, "host", pingById, () => people());
      await publish(stream, height, fps);
      ingest?.stop();
      ingest = startIngest(
        stream,
        created.roomId,
        created.ingestToken,
        (viewers) => {
          fallbackWatchers = viewers;
          for (const w of viewers) {
            // A live viewer's media RTT arrives on the data channel. Replacing
            // it with this websocket sample every couple of seconds flickers.
            if (!w.id || !(w.rtt != null && w.rtt > 0)) continue;
            if (w.rtc && (pingById.get(w.id) ?? 0) > 0) continue;
            pingById.set(w.id, w.rtt);
          }
          people();
        },
        { fps, bitrate: ingestBitrate(height, fps) },
      );
      ingest.setViewersVisible(showViewers);
      previewSession = created;
      linkPreviewsLive.disabled = Boolean(viewerPasswordInput.value.trim());
      linkPreviewsLive.checked = linkPreviews.checked && !linkPreviewsLive.disabled;
      // Retry initial capture until video and ingest are ready, then update once a minute.
      let nextPreview = 0;
      previewTimer = window.setInterval(() => {
        if (Date.now() < nextPreview || !qs<HTMLVideoElement>("#preview").videoWidth) return;
        nextPreview = Date.now() + 5000;
        void uploadPreview().then(uploaded => {
          if (uploaded) nextPreview = Date.now() + 60_000;
        });
      }, 1000);
      stopStats?.();
      stopStats = bindStatsToggle(qs("#statsToggle"), qs("#stats"), async () => {
        const track = videoPub?.videoTrack ?? (videoPub?.track as LocalVideoTrack | undefined);
        if (!track) return undefined;
        try {
          const stats = await track.getSenderStats();
          return senderStatsLine(Array.isArray(stats) ? stats : stats ? [stats] : []);
        } catch {
          return undefined;
        }
      });
      people();
      qs("#setup").classList.add("hidden");
      qs("#live").classList.remove("hidden");
      qs<HTMLInputElement>("#link").value = created.publicUrl;
      qs<HTMLSelectElement>("#resLive").value = String(height);
      qs<HTMLSelectElement>("#fpsLive").value = String(fps);
      history.replaceState(null, "", `/r/${created.roomId}`);
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      captured?.getTracks().forEach((t) => t.stop());
      await stop();
    }
  }

  async function stop(): Promise<void> {
    previewSession = null;
    window.clearInterval(previewTimer);
    previewTimer = undefined;
    stopPing?.();
    stopPing = null;
    stopStats?.();
    stopStats = null;
    pingById.clear();
    ingest?.stop();
    ingest = null;
    fallbackWatchers = [];
    stopMacAudio();
    void window.ez?.releaseAudioTap?.();
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    videoPub = null;
    audioPub = null;
    await room?.disconnect();
    room = null;
    qs("#setup").classList.remove("hidden");
    qs("#live").classList.add("hidden");
    history.replaceState(null, "", "/");
  }

  qs("#setup").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void start();
  });
  qs("#stop").addEventListener("click", () => void stop());
  const onShowViewers = (): void => {
    const on = showViewersLive.checked;
    showViewersSetup.checked = on;
    localStorage.setItem(showViewersKey, on ? "1" : "0");
    ingest?.setViewersVisible(on);
  };
  showViewersLive.addEventListener("change", onShowViewers);
  showViewersSetup.addEventListener("change", () => {
    showViewersLive.checked = showViewersSetup.checked;
    localStorage.setItem(showViewersKey, showViewersSetup.checked ? "1" : "0");
  });
  qs("#copy").addEventListener("click", async () => {
    const btn = qs("#copy");
    try {
      await copyText(qs<HTMLInputElement>("#link").value);
      btn.textContent = "copied";
      btn.classList.add("copied");
    } catch {
      btn.textContent = "copy failed";
    }
    window.setTimeout(() => {
      btn.textContent = "copy link";
      btn.classList.remove("copied");
    }, 1600);
  });
  async function switchLiveSource(source?: Source): Promise<void> {
    const height = Number(qs<HTMLSelectElement>("#resLive").value);
    const fps = Number(qs<HTMLSelectElement>("#fpsLive").value);
    const audio = qs<HTMLInputElement>("#audio").checked;
    liveErr.textContent = "";
    try {
      localStream?.getAudioTracks().forEach((track) => {
        track.stop();
        localStream?.removeTrack(track);
      });
      const stream = await getStream({ sourceId: source?.id, audio, height, fps });
      await publish(stream, height, fps);
      ingest?.setStream(stream);
      ingest?.setQuality(fps, ingestBitrate(height, fps));
      if (isElectron && audio && stream.getAudioTracks().length === 0) await reattachAudio();
      qs("#liveSources").classList.add("hidden");
    } catch (e) {
      liveErr.textContent = e instanceof Error ? e.message : String(e);
    }
  }
  function loadLiveSources(): Promise<void> {
    return loadSources(qs("#liveSourceGrid"), source => { void switchLiveSource(source); }, liveErr);
  }
  qs("#switch").addEventListener("click", async () => {
    if (!isElectron) { await switchLiveSource(); return; }
    const panel = qs("#liveSources");
    const showing = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !showing);
    if (showing) await loadLiveSources();
  });
  qs<HTMLButtonElement>("#refreshLive").addEventListener("click", async () => {
    const button = qs<HTMLButtonElement>("#refreshLive");
    button.disabled = true;
    liveErr.textContent = "";
    try {
      await Promise.all([loadLiveSources(), fillAudioSelects()]);
    } catch (error) {
      liveErr.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
    }
  });
  const onQuality = () => {
    const height = Number(qs<HTMLSelectElement>("#resLive").value);
    const fps = Number(qs<HTMLSelectElement>("#fpsLive").value);
    resolutionInput.value = String(height);
    fpsInput.value = String(fps);
    saveHostSettings();
    const video = localStream?.getVideoTracks()[0];
    if (video) applyQuality(video, height, fps);
    ingest?.setQuality(fps, ingestBitrate(height, fps));
    void applySenderQuality(videoPub, height, fps);
  };
  qs("#resLive").addEventListener("change", onQuality);
  qs("#fpsLive").addEventListener("change", onQuality);
  async function reattachAudio(): Promise<void> {
    if (!localStream || !room || !qs<HTMLInputElement>("#audio").checked) return;
    for (const t of localStream.getAudioTracks()) {
      localStream.removeTrack(t);
      t.stop();
    }
    const currentStream = localStream;
    const currentRoom = room;
    const tmp = new MediaStream(localStream.getVideoTracks());
    await addSystemAudio(tmp);
    if (localStream !== currentStream || room !== currentRoom) {
      tmp.getAudioTracks().forEach(track => track.stop());
      stopMacAudio();
      await window.ez?.releaseAudioTap();
      return;
    }
    const audio = tmp.getAudioTracks()[0];
    if (audio) {
      localStream.addTrack(audio);
      if (audioPub) await (audioPub.track as LocalAudioTrack).replaceTrack(audio);
      else {
        audioPub = await room.localParticipant.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          stream: "screenshare",
          red: false,
          dtx: false,
        });
      }
    } else if (audioPub?.track) {
      await room.localParticipant.unpublishTrack(audioPub.track);
      audioPub = null;
    }
    ingest?.setStream(localStream);
    const audioState = document.querySelector<HTMLElement>("#audioState");
    const audioOn = localStream.getAudioTracks().length > 0;
    if (audioState) {
      audioState.textContent = audioOn
        ? `audio on${lastAudioLabel ? ` · ${lastAudioLabel}` : ""}`
        : "no audio";
      audioState.classList.toggle("live", !audioOn);
    }
  }


}

function renderViewer(roomId: string): void {
  app.innerHTML = h(`
    <div class="wrap">
      <div class="top">
        <div>
          <div class="brand">ez<span>screenshare</span></div>
          <div class="sub">viewer</div>
        </div>
        <button class="btn secondary" id="theme" type="button">light</button>
      </div>
      <form id="gate" class="panel">
        <div class="row">
          <label class="field">nickname
            <input id="nick" type="text" maxlength="32" />
          </label>
          <label class="field">password
            <input id="password" type="password" autocomplete="current-password" />
          </label>
        </div>
        <div class="row"><button class="btn" id="join" type="submit">join</button></div>
        <div class="err" id="err"></div>
      </form>
      <div id="watch" class="hidden">
        <div class="stage">
          <video id="remote" class="hidden" autoplay playsinline webkit-playsinline></video>
          <video id="compatVid" class="compat hidden" autoplay playsinline webkit-playsinline controls></video>
          <canvas id="compat" class="compat hidden"></canvas>
          <button type="button" id="tapPlay" class="tap-play hidden">click to play</button>
        </div>
        <div class="hud">
          <div class="hud-status">
            <span class="pill" id="status">connecting</span>
            <span class="pill" id="ping">ping —</span>
            <span class="pill hidden" id="stats">—</span>
          </div>
          <div class="hud-actions">
            <label class="hud-field">quality
              <select id="vq">
                <option value="auto" selected>auto</option>
                <option value="low">480</option>
                <option value="high">full</option>
              </select>
            </label>
            <label id="compatVolume" class="hud-field hidden">volume
              <input id="vol" type="range" min="0" max="100" value="100" />
            </label>
            <button class="btn secondary" id="statsToggle" type="button">stats</button>
          </div>
        </div>
        <div id="proxyHelp" class="panel hidden" role="region" aria-labelledby="proxyHelpTitle">
          <p id="proxyHelpTitle">Try lower-delay live playback</p>
          <p>Using Tor or a proxy? Firefox may need microphone permission to establish a live connection, even though you are only watching.</p>
          <p>If you continue, your browser briefly opens the microphone and we immediately stop it. No microphone audio is recorded or sent. Choose “Remember this decision” if Firefox offers it. This grants the site microphone access; you can revoke it in site settings.</p>
          <p>If playback does not switch to live after allowing microphone access, reload this page and rejoin the stream.</p>
          <div class="row">
            <button id="proxyEnable" class="btn" type="button">allow microphone and retry live</button>
            <button id="proxyDismiss" class="btn secondary" type="button">stay in compatibility mode</button>
          </div>
          <p id="proxyHelpResult" class="sub" role="status"></p>
        </div>
        <div class="panel people-panel">
          <div class="sub">connected</div>
          <ul class="people" id="people"></ul>
        </div>
      </div>
    </div>
  `);

  bindThemeToggle();
  const nick = qs<HTMLInputElement>("#nick");
  nick.value = localStorage.getItem(nickKey) || "";
  const video = qs<HTMLVideoElement>("#remote");
  const compat = qs<HTMLCanvasElement>("#compat");
  const compatVid = qs<HTMLVideoElement>("#compatVid");
  const err = qs("#err");
  let room: Room | null = null;
  let stopWatch: { stop: () => void; setRtc: (on: boolean) => void } | null = null;
  let stopPing: (() => void) | null = null;
  let stopStats: (() => void) | null = null;
  let hostVideoPub: RemoteTrackPublication | null = null;
  let rtcLive = false;
  let rtcGaveUp = false;
  let showViewers = true;
  let pcmCtx: AudioContext | null = null;
  let pcmGain: GainNode | null = null;
  let pcmPlayer: AudioWorkletNode | null = null;
  let pcmModule: Promise<void> | null = null;
  const pingById = new Map<string, number>();
  const selfId = viewerIdentity();
  let recvBytes = 0;
  let recvAt = 0;

  qs("#vq").addEventListener("change", () => applyViewerQuality());
  new ResizeObserver(() => {
    if ((document.querySelector<HTMLSelectElement>("#vq")?.value ?? "auto") === "auto") {
      applyViewerQuality();
    }
  }).observe(video);
  stopStats = bindStatsToggle(qs("#statsToggle"), qs("#stats"), async () => {
    if (rtcLive && hostVideoPub?.videoTrack) {
      try {
        const stats = await (hostVideoPub.videoTrack as RemoteVideoTrack).getReceiverStats();
        const now = performance.now();
        let br: number | undefined;
        if (stats?.bytesReceived != null && recvAt) {
          const dt = (now - recvAt) / 1000;
          if (dt > 0) br = ((stats.bytesReceived - recvBytes) * 8) / dt;
        }
        if (stats?.bytesReceived != null) {
          recvBytes = stats.bytesReceived;
          recvAt = now;
        }
        const line = receiverStatsLine(stats, br);
        const fps = hostVideoPub.videoTrack.mediaStreamTrack.getSettings().frameRate;
        if (line && fps) return line.replace("live", `live · ${Math.round(fps)}fps`);
        return line;
      } catch {
        return undefined;
      }
    }
    if (!compatVid.classList.contains("hidden") && compatVid.videoHeight > 1) {
      return `compat · ${compatVid.videoHeight}p`;
    }
    if (!compat.classList.contains("hidden") && compat.width > 1) {
      return `compat · ${compat.height}p`;
    }
    return undefined;
  });

  function people(): void {
    const ul = document.querySelector<HTMLElement>("#people");
    if (!ul) return;
    const rtcPeople = room
      ? [room.localParticipant, ...Array.from(room.remoteParticipants.values())]
      : [];
    const selfPath: "live" | "compat" | undefined = rtcLive
      ? "live"
      : !compat.classList.contains("hidden") || !compatVid.classList.contains("hidden")
        ? "compat"
        : undefined;
    const rows: PersonRow[] = rtcPeople
      .filter((p) => {
        if (showViewers) return true;
        if (p.identity === "host") return true;
        return Boolean(room && p === room.localParticipant);
      })
      .map((p) => {
      const you = room && p === room.localParticipant ? " (you)" : "";
      const isYou = Boolean(you);
      return {
        name: `${p.name || p.identity}${you}`,
        role: p.identity === "host" ? "host" : "viewer",
        ms: pingById.get(isYou ? selfId : p.identity) ?? pingById.get(p.identity),
        path:
          p.identity === "host"
            ? rtcLive
              ? "live"
              : selfPath === "compat"
                ? "compat"
                : undefined
            : isYou
              ? selfPath
              : "live",
      };
    });
    if (!rows.length) {
      const n = document.querySelector<HTMLInputElement>("#nick")?.value.trim() || "viewer";
      rows.push({
        name: `${n} (you)`,
        role: "viewer",
        ms: pingById.get(selfId),
        path: selfPath,
      });
    }
    renderPeople(ul, rows);
    setPingPill(document.querySelector("#ping"), pingById.get(selfId) ?? pingById.get(room?.localParticipant.identity ?? ""));
  }

  function setStatus(text: string, live: boolean): void {
    const el = qs("#status");
    el.textContent = text;
    el.classList.toggle("live", live);
    qs("#compatVolume").classList.toggle("hidden", text !== "compatibility");
    if (text === "live") qs("#proxyHelp").classList.add("hidden");
    if (text === "compatibility") void maybeOfferProxyHelp();
  }

  function showWatch(): void {
    qs("#gate").classList.add("hidden");
    qs("#watch").classList.remove("hidden");
  }

  function promoteRtc(): void {
    if (rtcGaveUp || rtcLive || video.videoWidth < 2) return;
    rtcLive = true;
    pcmPlayer?.port.postMessage({ reset: true });
    compat.classList.add("hidden");
    compatVid.classList.add("hidden");
    document.querySelector("#tapPlay")?.classList.add("hidden");
    video.classList.remove("hidden");
    video.controls = true;
    video.muted = false;
    video.volume = 1;
    showWatch();
    setStatus("live", true);
    console.info("[ezscreenshare] live WebRTC");
    stopWatch?.setRtc(true);
    applyViewerQuality();
    people();
  }

  function dropRtc(giveUp: boolean): void {
    if (giveUp) rtcGaveUp = true;
    rtcLive = false;
    video.classList.add("hidden");
    video.controls = false;
    stopWatch?.setRtc(false);
    if (!compat.classList.contains("hidden") || !compatVid.classList.contains("hidden")) {
      setStatus("compatibility", true);
    }
    people();
    if (giveUp && room) void room.disconnect();
  }

  function attach(track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (participant.identity !== "host") return;
    if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;
    // Same cushion for audio and video so they stay in sync. 100ms underruns on
    // this path and the gaps sound like clipping; 200ms covers ordinary jitter.
    const receiver = track.receiver;
    try {
      if (receiver && "jitterBufferTarget" in receiver) {
        (receiver as RTCRtpReceiver & { jitterBufferTarget: number }).jitterBufferTarget = 200;
      } else if (receiver && "playoutDelayHint" in receiver) {
        track.setPlayoutDelay(0.2);
      }
    } catch { /* Browser retains its automatic jitter buffer. */ }
    track.attach(video);
    video.playsInline = true;
    video.disablePictureInPicture = false;
    if (track.kind === Track.Kind.Audio) {
      try {
        (track as RemoteTrack & { setVolume?: (n: number) => void }).setVolume?.(1);
      } catch {
        /* ignore */
      }
      if (rtcLive) {
        video.muted = false;
        video.volume = 1;
      }
      return;
    }
    hostVideoPub = pub;
    applyViewerQuality();
    const onFrame = (): void => {
      if (video.videoWidth > 1) promoteRtc();
    };
    video.requestVideoFrameCallback?.(onFrame);
    video.addEventListener("playing", onFrame);
    video.addEventListener("loadeddata", onFrame);
    void video.play().catch(() => undefined);
  }

  function applyViewerQuality(): void {
    if (!hostVideoPub) return;
    const mode = document.querySelector<HTMLSelectElement>("#vq")?.value ?? "auto";
    try {
      if (mode === "low") hostVideoPub.setVideoQuality(VideoQuality.LOW);
      else if (mode === "high") hostVideoPub.setVideoQuality(VideoQuality.HIGH);
      else {
        const w = Math.max(320, video.clientWidth || 1280);
        const h = Math.max(180, video.clientHeight || 720);
        hostVideoPub.setVideoDimensions({ width: w, height: h });
      }
    } catch {
      /* publication not ready */
    }
  }

  const volKey = "ezscreenshare.volume";

  function sliderGain(): number {
    if (rtcLive) {
      if (video.muted) return 0;
      return Number.isFinite(video.volume) ? video.volume : 1;
    }
    const hud = document.querySelector<HTMLInputElement>("#vol");
    if (!hud) return 1;
    return Math.max(0, Math.min(1, Number(hud.value) / 100));
  }

  function applyVolume(): void {
    const g = sliderGain();
    if (pcmGain) pcmGain.gain.value = g;
    const a = document.querySelector<HTMLAudioElement>("#compatAudio");
    if (a) {
      a.volume = g;
      if (a.dataset.stalled !== "1") a.muted = g === 0;
    }
    const hud = document.querySelector<HTMLInputElement>("#vol");
    if (hud) hud.value = String(Math.round(g * 100));
    localStorage.setItem(volKey, hud?.value ?? String(Math.round(g * 100)));
  }

  function setVolumeFromHud(raw: string): void {
    const n = Math.max(0, Math.min(100, Number(raw) || 0));
    const g = n / 100;
    compatVid.muted = true;
    video.muted = n === 0 && rtcLive;
    video.volume = g;
    applyVolume();
  }

  function playPcm(rate: number, samples: Int16Array): void {
    if (rtcLive || !samples.length) return;
    pcmCtx ??= new AudioContext({ sampleRate: rate });
    if (!pcmGain) {
      pcmGain = pcmCtx.createGain();
      pcmGain.connect(pcmCtx.destination);
    }
    void pcmCtx.resume();
    pcmGain.gain.value = sliderGain();
    if (!pcmPlayer) {
      pcmModule ??= pcmCtx.audioWorklet.addModule(compatAudioUrl).then(() => {
        pcmPlayer = new AudioWorkletNode(pcmCtx!, "compat-playback", { outputChannelCount: [1] });
        pcmPlayer.connect(pcmGain!);
      }).catch((err) => console.error("[ezscreenshare] audio playback", err));
      return;
    }
    pcmPlayer.port.postMessage({ rate, samples }, [samples.buffer]);
  }

  // Websites cannot read proxy settings. An empty host-only ICE probe is only
  // a restriction heuristic; offer an explanation, never automatic capture.
  let proxyHelpDismissed = false;
  let proxyProbe: Promise<boolean> | null = null;
  let viewerGeneration = 0;
  async function restrictedFirefoxIce(): Promise<boolean> {
    if (!/Firefox\//.test(navigator.userAgent) || !window.RTCPeerConnection ||
        !navigator.mediaDevices?.getUserMedia) return false;
    try {
      const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
      if (permission.state !== "prompt") return false;
    } catch { /* Some Firefox versions do not expose microphone permission. */ }
    let pc: RTCPeerConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      let candidates = 0;
      const finished = new Promise<boolean>((resolve) => {
        pc!.addEventListener("icecandidate", (event) => {
          if (event.candidate) candidates++;
          else resolve(candidates === 0);
        });
        pc!.addEventListener("icegatheringstatechange", () => {
          if (pc!.iceGatheringState === "complete") resolve(candidates === 0);
        });
        pc!.addEventListener("iceconnectionstatechange", () => {
          if (pc!.iceConnectionState === "failed") resolve(candidates === 0);
        });
        // Timeout is inconclusive, not evidence that a proxy is configured.
        timer = setTimeout(() => resolve(false), 5000);
      });
      pc.createDataChannel("connection-check");
      await pc.setLocalDescription(await pc.createOffer());
      return await finished;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      pc?.close();
    }
  }
  async function maybeOfferProxyHelp(): Promise<void> {
    if (proxyHelpDismissed || rtcLive) return;
    const generation = viewerGeneration;
    proxyProbe ??= restrictedFirefoxIce();
    const restricted = await proxyProbe;
    if (restricted && generation === viewerGeneration && !rtcLive && !proxyHelpDismissed &&
        qs("#status").textContent === "compatibility") {
      qs("#proxyHelp").classList.remove("hidden");
    }
  }
  qs("#proxyDismiss").addEventListener("click", () => {
    proxyHelpDismissed = true;
    qs("#proxyHelp").classList.add("hidden");
  });
  qs("#proxyEnable").addEventListener("click", async () => {
    const button = qs<HTMLButtonElement>("#proxyEnable");
    const result = qs("#proxyHelpResult");
    const generation = viewerGeneration;
    button.disabled = true;
    result.textContent = "Choose Allow in your browser’s permission prompt.";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // Never attach, inspect, record, or publish this stream. Stop every track
      // before any asynchronous retry or UI work, including stale requests.
      for (const track of stream.getTracks()) track.stop();
      if (generation !== viewerGeneration || rtcLive || proxyHelpDismissed || !button.isConnected) return;
      result.textContent = "Microphone stopped. Retrying live playback. If it stays in compatibility mode, reload this page and rejoin the stream. If needed, use Ctrl+I → Permissions → Use the microphone → Allow, then rejoin. This grants the site microphone access; you can revoke it afterwards.";
      proxyHelpDismissed = true;
      qs<HTMLFormElement>("#gate").requestSubmit();
    } catch {
      result.textContent = "Microphone access was not granted or no device was available. You can keep watching in compatibility mode. To set permission without opening a microphone, use Ctrl+I → Permissions → Use the microphone → Allow, then rejoin.";
    } finally {
      button.disabled = false;
    }
  });

  const joinBtn = qs<HTMLButtonElement>("#join");
  let mediaUnlocked = false;
  const tapPlay = (): void => {
    mediaUnlocked = true;
    document.querySelector("#tapPlay")?.classList.add("hidden");
    compatVid.muted = true;
    compatVid.controls = true;
    void compatVid.play().catch(() => undefined);
    void document.querySelector<HTMLAudioElement>("#compatAudio")?.play().catch(() => undefined);
    void video.play().catch(() => undefined);
    pcmCtx ??= new AudioContext();
    void pcmCtx.resume();
  };
  qs("#tapPlay")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    tapPlay();
  });
  const savedVol = localStorage.getItem(volKey);
  if (savedVol != null) setVolumeFromHud(savedVol);
  qs<HTMLInputElement>("#vol").addEventListener("input", (ev) => {
    setVolumeFromHud((ev.target as HTMLInputElement).value);
  });
  compatVid.addEventListener("volumechange", () => {
    compatVid.muted = true;
    applyVolume();
  });
  video.addEventListener("volumechange", () => applyVolume());
  qs("#gate").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    localStorage.setItem(nickKey, nick.value.trim() || "viewer");
    joinBtn.disabled = true;
    rtcGaveUp = false;
    rtcLive = false;
    viewerGeneration++;
    setStatus("connecting", false);
    pcmCtx ??= new AudioContext();
    void pcmCtx.resume();
    try {
      if (room) {
        await room.disconnect();
        room = null;
      }
      const joined = await api<JoinResp>(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
        password: qs<HTMLInputElement>("#password").value,
        nickname: nick.value.trim() || "viewer",
        identity: viewerIdentity(),
      });
      showViewers = joined.showViewers !== false;
      room = new Room(roomOpts("viewer"));
      room.on(RoomEvent.TrackSubscribed, (track, pub, p) => attach(track, pub, p));
      room.on(RoomEvent.TrackPublished, (pub, p) => {
        if (p.identity === "host") void pub.setSubscribed(true);
      });
      room.on(RoomEvent.ParticipantConnected, people);
      room.on(RoomEvent.ParticipantDisconnected, people);
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (rtcLive || rtcGaveUp) return;
        if (
          state === ConnectionState.Reconnecting ||
          state === ConnectionState.SignalReconnecting
        ) {
          dropRtc(false);
        } else if (state === ConnectionState.Disconnected) {
          dropRtc(false);
        }
      });
      room.on(RoomEvent.Disconnected, () => dropRtc(false));
      stopWatch?.stop();
      stopPing?.();
      pingById.clear();
      pcmCtx ??= new AudioContext();
      void pcmCtx.resume();
      video.muted = false;
      video.volume = 1;
      video.playsInline = true;
      video.disablePictureInPicture = false;
      showWatch();
      stopWatch = startWatch(
        compat,
        compatVid,
        joined.roomId,
        joined.watchToken,
        nick.value.trim() || "viewer",
        viewerIdentity(),
        {
          isRtcLive: () => rtcLive,
          unlocked: () => mediaUnlocked,
          markUnlocked: () => {
            mediaUnlocked = true;
          },
          onFrame: () => {
            if (!rtcLive) {
              video.classList.add("hidden");
              showWatch();
              setStatus("compatibility", true);
              people();
            }
          },
          onPcm: playPcm,
          onViewersVisible: (on) => {
            showViewers = on;
            people();
          },
          onRtt: (ms) => {
            // Compatibility ping. Once live playback has a real media RTT, the
            // websocket sample must not overwrite it or the number flickers.
            if (!(ms > 0)) return;
            const liveId = room?.localParticipant.identity;
            if (rtcLive && ((liveId && (pingById.get(liveId) ?? 0) > 0) || (pingById.get(selfId) ?? 0) > 0)) return;
            pingById.set(selfId, ms);
            if (liveId) pingById.set(liveId, ms);
            people();
            if (room) {
              void room.localParticipant
                .publishData(new TextEncoder().encode(JSON.stringify({ t: "ezs-ping", ms })), {
                  reliable: false,
                  topic: "ezs-ping",
                })
                .catch(() => undefined);
            }
          },
        },
      );
      people();
      void room
        .connect(joined.livekitUrl, joined.token, {
          // Tor signaling and TURN/TLS handshakes can be slow. Compatibility
          // playback starts independently while this connection is attempted.
          websocketTimeout: 60_000,
          peerConnectionTimeout: 45_000,
          maxRetries: 1,
        })
        .then(() => {
          stopPing?.();
          stopPing = bindRoomPing(room!, room!.localParticipant.identity || selfId, pingById, () =>
            people(),
          );
          for (const p of room!.remoteParticipants.values()) {
            for (const pub of p.trackPublications.values()) {
              if (pub.track) attach(pub.track as RemoteTrack, pub as RemoteTrackPublication, p);
            }
          }
          people();
        })
        .catch((error) => {
          console.info("[ezscreenshare] WebRTC unavailable; continuing compatibility", error);
        });
      window.setTimeout(() => {
        if (
          !rtcLive &&
          compat.classList.contains("hidden") &&
          compatVid.classList.contains("hidden")
        ) {
          err.textContent = "waiting for the host stream — keep this page, or join again";
          joinBtn.disabled = false;
        }
      }, 8_000);
      joinBtn.disabled = false;
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      joinBtn.disabled = false;
    }
  });

  function enterPip(): void {
    if (video.paused || video.readyState < 2) return;
    const el = video as HTMLVideoElement & {
      webkitSetPresentationMode?: (mode: string) => void;
      webkitPresentationMode?: string;
    };
    if (el.webkitSetPresentationMode && el.webkitPresentationMode !== "picture-in-picture") {
      try {
        el.webkitSetPresentationMode("picture-in-picture");
        return;
      } catch {
        /* try standard */
      }
    }
    if (document.pictureInPictureEnabled && !document.pictureInPictureElement) {
      void video.requestPictureInPicture().catch(() => undefined);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) enterPip();
  });
}

if (viewerMatch && !isElectron) renderViewer(decodeURIComponent(viewerMatch[1]));
else renderHost();
