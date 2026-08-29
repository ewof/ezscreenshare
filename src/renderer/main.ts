import {
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type LocalVideoTrack,
  type LocalAudioTrack,
} from "livekit-client";

declare global {
  interface Window {
    ez?: {
      isElectron: true;
      getSources: () => Promise<Source[]>;
      setCapture: (id: string, audio: boolean) => Promise<void>;
      monitorHint: () => Promise<string>;
      copyText: (text: string) => Promise<void>;
      listAudioSources: () => Promise<
        { id: string; label: string; monitor: boolean; running: boolean }[]
      >;
      beginMonitorCapture: (
        sourceId: string,
      ) => Promise<{ ok: boolean; prev: string; label: string; hints?: string[] }>;
      endMonitorCapture: (prev: string) => Promise<void>;
      releaseAudioTap: () => Promise<void>;
    };
  }
}

type Source = { id: string; name: string; thumbnail: string; kind: "screen" | "window" };

type CreateResp = {
  roomId: string;
  token: string;
  livekitUrl: string;
  publicUrl: string;
  forceTcp: boolean;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  ingestToken: string;
};

type JoinResp = {
  roomId: string;
  token: string;
  livekitUrl: string;
  forceTcp: boolean;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  watchToken: string;
};

const app = document.querySelector("#app")!;
const path = location.pathname;
const viewerMatch = path.match(/^\/r\/([^/]+)\/?$/);
const isElectron = Boolean(window.ez?.isElectron);
const nickKey = "ezscreenshare.nick";
const themeKey = "ezscreenshare.theme";
const hostKey = "ezscreenshare.hostKey";

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

function roomOpts(_kind: "host" | "viewer") {
  return {
    // Hidden <video> is 0×0; adaptiveStream then never requests a layer (iOS).
    adaptiveStream: false,
    dynacast: false,
    publishDefaults: {
      videoCodec: "h264" as const,
      backupCodec: { codec: "vp8" as const },
      dtx: false,
      red: false,
      simulcast: false,
    },
    audioCaptureDefaults: {
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
    },
    rtcConfig: {
      // Firefox behind SOCKS disables ICE-TCP when policy is "relay", so TURNS
      // never allocates. "all" still has no host candidates (default_address_only).
      iceTransportPolicy: "all" as RTCIceTransportPolicy,
    },
  };
}

function fallbackUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

function openFallback(path: string, token: string): WebSocket {
  return new WebSocket(fallbackUrl(path), ["ezs", token]);
}

const PCM_MAGIC = [0x45, 0x5a, 0x53, 0x41]; // EZSA

function isPcmPacket(buf: Uint8Array): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === PCM_MAGIC[0] &&
    buf[1] === PCM_MAGIC[1] &&
    buf[2] === PCM_MAGIC[2] &&
    buf[3] === PCM_MAGIC[3]
  );
}

function startIngest(
  stream: MediaStream,
  roomId: string,
  ingestToken: string,
  onWatchers: (viewers: { name: string; id: string }[]) => void,
): { stop: () => void; setStream: (s: MediaStream) => void; setFps: (fps: number) => void } {
  const ws = openFallback(`/ws/ingest/${encodeURIComponent(roomId)}`, ingestToken);
  // Video-only clone: attaching the live stream to a muted <video> mutes published audio in Chromium.
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
  const ctx = canvas.getContext("2d");
  const postUrl = `/api/rooms/${encodeURIComponent(roomId)}/frame`;
  const postHeaders = { "content-type": "image/jpeg", authorization: `Bearer ${ingestToken}` };
  let timer = 0;
  let sending = false;
  let intervalMs = 200;
  let ac: AudioContext | null = null;
  let audioSrc: MediaStreamAudioSourceNode | null = null;
  let audioProc: ScriptProcessorNode | null = null;
  let audioMute: GainNode | null = null;

  const bindVideo = (s: MediaStream): void => {
    tap.srcObject = new MediaStream(s.getVideoTracks());
    void tap.play().catch(() => undefined);
  };

  const unhookAudio = (): void => {
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
  };

  const hookAudio = (s: MediaStream): void => {
    unhookAudio();
    const tracks = s.getAudioTracks();
    if (!tracks.length) return;
    ac ??= new AudioContext();
    void ac.resume();
    const src = ac.createMediaStreamSource(new MediaStream(tracks));
    const proc = ac.createScriptProcessor(2048, 1, 1);
    const mute = ac.createGain();
    mute.gain.value = 0;
    src.connect(proc);
    proc.connect(mute);
    // Never route capture to speakers — that howls through the headset.
    mute.connect(ac.createMediaStreamDestination());
    proc.onaudioprocess = (ev) => {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256_000) return;
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const n = Math.max(-1, Math.min(1, input[i]!));
        pcm[i] = n < 0 ? n * 0x8000 : n * 0x7fff;
      }
      const out = new Uint8Array(8 + pcm.byteLength);
      out[0] = PCM_MAGIC[0]!;
      out[1] = PCM_MAGIC[1]!;
      out[2] = PCM_MAGIC[2]!;
      out[3] = PCM_MAGIC[3]!;
      new DataView(out.buffer).setUint32(4, ac!.sampleRate, true);
      out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 8);
      ws.send(out);
    };
    audioSrc = src;
    audioProc = proc;
    audioMute = mute;
  };

  bindVideo(stream);
  hookAudio(stream);

  const tick = (): void => {
    if (!ctx || tap.videoWidth < 2 || sending) return;
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 512_000) return;
    const w = tap.videoWidth;
    const h = tap.videoHeight;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(tap, 0, 0, w, h);
    sending = true;
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          sending = false;
          return;
        }
        const send = blob;
        if (ws.readyState === WebSocket.OPEN) ws.send(send);
        void fetch(postUrl, { method: "POST", body: send, headers: postHeaders })
          .catch(() => undefined)
          .finally(() => {
            sending = false;
          });
      },
      "image/jpeg",
      0.55,
    );
  };
  const arm = (): void => {
    window.clearInterval(timer);
    timer = window.setInterval(tick, intervalMs);
  };
  arm();
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data) as {
        t?: string;
        names?: string[];
        viewers?: { name: string; id: string }[];
      };
      if (msg.t === "watchers" && Array.isArray(msg.viewers)) onWatchers(msg.viewers);
      else if (msg.t === "watchers" && Array.isArray(msg.names)) {
        onWatchers(msg.names.map((name) => ({ name, id: "" })));
      }
    } catch {
      /* ignore */
    }
  });
  return {
    setStream(next) {
      bindVideo(next);
      hookAudio(next);
    },
    setFps(fps: number) {
      intervalMs = Math.round(1000 / Math.max(1, Math.min(30, fps)));
      arm();
    },
    stop() {
      window.clearInterval(timer);
      unhookAudio();
      void ac?.close();
      tap.srcObject = null;
      tap.remove();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
}

function startWatch(
  img: HTMLImageElement,
  roomId: string,
  watchToken: string,
  nick: string,
  identity: string,
  opts: {
    isRtcLive: () => boolean;
    onFrame: () => void;
    onPcm: (rate: number, samples: Int16Array) => void;
  },
): () => void {
  let stopped = false;
  let timer = 0;
  let objectUrl = "";
  let applying = false;
  let lastWs = 0;
  let wsOpen = false;
  const applyJpeg = (data: Blob | ArrayBuffer | Uint8Array): void => {
    if (stopped || applying || opts.isRtcLive()) {
      if (opts.isRtcLive()) img.classList.add("hidden");
      return;
    }
    applying = true;
    const blob =
      data instanceof Blob
        ? data
        : new Blob([data as BlobPart], { type: "image/jpeg" });
    const next = URL.createObjectURL(blob);
    const shown = new Image();
    shown.onload = () => {
      if (stopped) {
        URL.revokeObjectURL(next);
        applying = false;
        return;
      }
      const prev = objectUrl;
      objectUrl = next;
      img.src = next;
      img.classList.remove("hidden");
      shown.src = "";
      if (prev && prev !== next) URL.revokeObjectURL(prev);
      applying = false;
      opts.onFrame();
    };
    shown.onerror = () => {
      URL.revokeObjectURL(next);
      applying = false;
    };
    shown.src = next;
  };
  const handleBuf = (buf: Uint8Array): void => {
    if (isPcmPacket(buf)) {
      if (opts.isRtcLive()) return;
      const rate = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(4, true);
      const samples = new Int16Array(
        buf.buffer,
        buf.byteOffset + 8,
        Math.floor((buf.byteLength - 8) / 2),
      );
      opts.onPcm(rate, samples);
      return;
    }
    lastWs = Date.now();
    applyJpeg(buf);
  };
  const poll = async (): Promise<void> => {
    if (stopped) return;
    const skipHttp = opts.isRtcLive() || (wsOpen && Date.now() - lastWs < 900);
    if (!skipHttp) {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/frame`, {
          cache: "no-store",
          headers: { authorization: `Bearer ${watchToken}` },
        });
        if (res.ok) applyJpeg(await res.blob());
      } catch {
        /* next poll */
      }
    }
    if (!stopped) timer = window.setTimeout(() => void poll(), skipHttp ? 400 : 150);
  };
  void poll();
  const ws = openFallback(`/ws/watch/${encodeURIComponent(roomId)}`, watchToken);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    wsOpen = true;
    ws.send(JSON.stringify({ t: "hello", name: nick, id: identity }));
  });
  ws.addEventListener("close", () => {
    wsOpen = false;
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") return;
    handleBuf(new Uint8Array(ev.data as ArrayBuffer));
  });
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    img.onload = null;
    img.onerror = null;
    img.removeAttribute("src");
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    if (ws.readyState === WebSocket.OPEN) ws.close();
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
  const hint = fps >= 30 ? "motion" : "detail";
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
  const display: DisplayMediaStreamOptions = {
    video: {
      frameRate: { ideal: opts.fps },
      height: { ideal: opts.height },
      width: { ideal: Math.round(opts.height * (16 / 9)) },
    },
    // Electron/Linux: PipeWire loopback is silent. Monitor is added below.
    audio: opts.audio && !isElectron
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : false,
  };
  if (!isElectron && opts.audio) {
    (display as DisplayMediaStreamOptions & { systemAudio?: string }).systemAudio = "include";
  }
  const stream = await navigator.mediaDevices.getDisplayMedia(display);
  const video = stream.getVideoTracks()[0];
  if (video) applyQuality(video, opts.height, opts.fps);
  if (opts.audio && isElectron) await addSystemAudio(stream);
  else if (opts.audio) {
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

async function addSystemAudio(stream: MediaStream): Promise<void> {
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
  let wanted =
    (document.querySelector("#audioSrcLive") as HTMLSelectElement | null)?.value ||
    (document.querySelector("#audioSrc") as HTMLSelectElement | null)?.value ||
    localStorage.getItem("ezscreenshare.audioSrc") ||
    "system";
  if (wanted === "none") return;
  if (wanted === "auto") wanted = "system";
  if (window.ez?.beginMonitorCapture) {
    const session = await window.ez.beginMonitorCapture(wanted);
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
        lastAudioLabel = pick.label || session.label;
        console.info("[ezscreenshare] system audio", lastAudioLabel, pick.deviceId);
        return;
      }
    } catch (e) {
      console.warn("[ezscreenshare] monitor capture failed", e);
    } finally {
      await window.ez.endMonitorCapture(session.prev);
    }
  }
  if (!window.ez) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of probe.getTracks()) t.stop();
    } catch {
      /* labels may still populate */
    }
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const hint = ((await window.ez?.monitorHint?.()) || "").toLowerCase();
  const ranked = inputs
    .map((d) => {
      const l = d.label.toLowerCase();
      let score = 0;
      if (hint && (l === hint || l.includes(hint) || hint.includes(l))) score += 20;
      if (/monitor/.test(l)) score += 8;
      if (/headphone|headset|analog/.test(l) && /monitor/.test(l)) score += 4;
      if (/hdmi|iec958|displayport|digital only/.test(l)) score -= 8;
      if (/microphone|mono-fallback|input/.test(l) && !/monitor/.test(l)) score -= 6;
      return { d, score };
    })
    .sort((a, b) => b.score - a.score);
  const pick = ranked.find((x) => x.score > 0)?.d;
  if (!pick) {
    console.warn(
      "[ezscreenshare] no PipeWire sink monitor",
      inputs.map((d) => d.label),
      "hint",
      hint,
    );
    return;
  }
  const extra = await navigator.mediaDevices.getUserMedia({
    audio: { ...constraints, deviceId: { exact: pick.deviceId } },
  });
  for (const t of extra.getAudioTracks()) {
    t.contentHint = "music";
    stream.addTrack(t);
  }
  lastAudioLabel = pick.label;
  console.info("[ezscreenshare] system audio", pick.label);
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
      <div id="setup" class="panel">
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
          <label class="field">fps
            <select id="fps">
              <option value="5">5</option>
              <option value="15">15</option>
              <option value="30" selected>30</option>
              <option value="60">60</option>
            </select>
          </label>
        </div>
        <div class="row">
          <label class="check ${isElectron ? "" : "hidden"}"><input id="audio" type="checkbox" checked /> share audio</label>
          <label class="check"><input id="tcp" type="checkbox" checked /> force TCP</label>
        </div>
        <div class="row ${isElectron ? "" : "hidden"}" id="audioSrcRow">
          <label class="field">audio source
            <select id="audioSrc">
              <option value="system">Entire system</option>
            </select>
          </label>
        </div>
        <div id="sourceWrap" class="${isElectron ? "" : "hidden"}">
          <p class="sub">source</p>
          <div id="sources" class="sources"></div>
        </div>
        <div class="row">
          <button class="btn" id="start" type="button">start stream</button>
          <button class="btn secondary ${isElectron ? "" : "hidden"}" id="refresh" type="button">refresh sources</button>
        </div>
        <div class="err" id="err"></div>
      </div>
      <div id="live" class="hidden">
        <div class="stage"><video id="preview" autoplay muted playsinline></video></div>
        <div class="hud">
          <span class="pill live">LIVE</span>
          <span class="pill" id="audioState">audio ?</span>
          <div class="linkbox">
            <input id="link" class="mono" type="text" readonly />
            <button class="btn secondary" id="copy" type="button">copy link</button>
          </div>
          <button class="btn secondary" id="switch" type="button">change source</button>
          <button class="btn secondary" id="stop" type="button">stop</button>
        </div>
        <div id="liveSources" class="live-sources hidden">
          <p class="sub">pick a source</p>
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
          <label class="field">fps
            <select id="fpsLive">
              <option value="5">5</option>
              <option value="15">15</option>
              <option value="30">30</option>
              <option value="60">60</option>
            </select>
          </label>
          <label class="field">compat fps
            <select id="compatFps">
              <option value="2">2</option>
              <option value="5" selected>5</option>
              <option value="8">8</option>
              <option value="15">15</option>
            </select>
          </label>
          <label class="field ${isElectron ? "" : "hidden"}" id="audioSrcLiveWrap">audio source
            <select id="audioSrcLive">
              <option value="system">Entire system</option>
            </select>
          </label>
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
  hostKeyInput.value = localStorage.getItem(hostKey) || "";
  const err = qs("#err");
  let selected: Source | null = null;
  let room: Room | null = null;
  let localStream: MediaStream | null = null;
  let videoPub: LocalTrackPublication | null = null;
  let audioPub: LocalTrackPublication | null = null;
  let ingest: ReturnType<typeof startIngest> | null = null;
  let fallbackWatchers: { name: string; id: string }[] = [];

  async function loadSources(box: HTMLElement, onPick?: (s: Source) => void): Promise<void> {
    if (!window.ez) return;
    let sources: Source[] = [];
    try {
      sources = await window.ez.getSources();
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      return;
    }
    box.innerHTML = "";
    for (const s of sources) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "source";
      if (selected?.id === s.id) btn.classList.add("selected");
      const img = document.createElement("img");
      img.alt = "";
      img.src = s.thumbnail;
      const cap = document.createElement("figcaption");
      cap.textContent = `${s.kind}: ${s.name}`;
      btn.append(img, cap);
      btn.addEventListener("click", () => {
        selected = s;
        for (const el of box.querySelectorAll(".source")) el.classList.remove("selected");
        btn.classList.add("selected");
        onPick?.(s);
      });
      box.appendChild(btn);
    }
    if (sources[0] && !selected) {
      selected = sources[0];
      box.querySelector(".source")?.classList.add("selected");
    }
  }

  qs("#refresh").addEventListener("click", () => void loadSources(qs("#sources")));
  void loadSources(qs("#sources"));

  async function fillAudioSelects(): Promise<void> {
    let saved = localStorage.getItem("ezscreenshare.audioSrc") || "system";
    if (saved === "auto" || saved === "none") saved = "system";
    const sources = (await window.ez?.listAudioSources?.()) ?? [
      { id: "system", label: "Entire system", monitor: true, running: true },
    ];
    for (const id of ["audioSrc", "audioSrcLive"] as const) {
      const el = document.querySelector<HTMLSelectElement>(`#${id}`);
      if (!el) continue;
      el.replaceChildren();
      for (const s of sources) {
        const o = document.createElement("option");
        o.value = s.id;
        o.textContent = s.label;
        el.appendChild(o);
      }
      el.value = [...el.options].some((o) => o.value === saved) ? saved : "system";
    }
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

  if (isElectron) void fillAudioSelects();
  qs("#audio").addEventListener("change", syncAudioRow);
  qs("#audioSrc").addEventListener("focus", () => void fillAudioSelects());
  qs("#audioSrcLive").addEventListener("focus", () => void fillAudioSelects());
  document.querySelector("#audioSrc")?.addEventListener("change", () => {
    const v = qs<HTMLSelectElement>("#audioSrc").value;
    localStorage.setItem("ezscreenshare.audioSrc", v);
    const live = document.querySelector<HTMLSelectElement>("#audioSrcLive");
    if (live) live.value = v;
  });

  function people(): void {
    const ul = qs("#people");
    const rtcPeople = room
      ? [room.localParticipant, ...Array.from(room.remoteParticipants.values())]
      : [];
    const rtcIds = new Set(rtcPeople.map((p) => p.identity));
    const rtcNames = new Set(rtcPeople.map((p) => (p.name || "").toLowerCase()).filter(Boolean));
    ul.replaceChildren();
    const addRow = (name: string, role: string): void => {
      const li = document.createElement("li");
      const n = document.createElement("span");
      n.textContent = name;
      const r = document.createElement("span");
      r.className = "sub";
      r.textContent = role;
      li.append(n, r);
      ul.appendChild(li);
    };
    for (const p of rtcPeople) {
      const you = room && p === room.localParticipant ? " (you)" : "";
      addRow(`${p.name || p.identity}${you}`, p.identity === "host" ? "host" : "viewer");
    }
    for (const w of fallbackWatchers) {
      if (w.id && rtcIds.has(w.id)) continue;
      if (w.name && rtcNames.has(w.name.toLowerCase())) continue;
      addRow(w.name || w.id || "viewer", "viewer");
    }
    if (!ul.childElementCount) {
      const li = document.createElement("li");
      const s = document.createElement("span");
      s.className = "sub";
      s.textContent = "nobody yet";
      li.appendChild(s);
      ul.appendChild(li);
    }
  }

  async function publish(stream: MediaStream): Promise<void> {
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
    } else if (video) {
      videoPub = await room.localParticipant.publishTrack(video, {
        source: Track.Source.ScreenShare,
        simulcast: false,
        videoCodec: "h264",
        backupCodec: { codec: "vp8" },
        videoEncoding: {
          maxBitrate: Number(qs<HTMLSelectElement>("#res").value) >= 1080 ? 2_500_000 : 1_200_000,
          maxFramerate: Number(qs<HTMLSelectElement>("#fps").value),
        },
      });
    }
    if (audio) {
      if (audioPub) await (audioPub.track as LocalAudioTrack).replaceTrack(audio);
      else {
        audioPub = await room.localParticipant.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          red: false,
          dtx: false,
        });
      }
    }
    video?.addEventListener("ended", () => void stop());
    const audioOn = (localStream?.getAudioTracks().length ?? 0) > 0;
    const audioState = document.querySelector("#audioState");
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
    localStorage.setItem(nickKey, nick.value.trim() || "host");
    localStorage.setItem(hostKey, hostKeyInput.value);
    const height = Number(qs<HTMLSelectElement>("#res").value);
    const fps = Number(qs<HTMLSelectElement>("#fps").value);
    const audio = qs<HTMLInputElement>("#audio").checked;
    const forceTcp = qs<HTMLInputElement>("#tcp").checked;
    try {
      const created = await api<CreateResp>("/api/rooms", {
        hostPassword: hostKeyInput.value,
        password: qs<HTMLInputElement>("#password").value,
        forceTcp,
        nickname: nick.value.trim() || "host",
      });
      const stream = await getStream({
        sourceId: selected?.id,
        audio,
        height,
        fps,
      });
      room = new Room(roomOpts("host"));
      room.on(RoomEvent.ParticipantConnected, people);
      room.on(RoomEvent.ParticipantDisconnected, people);
      room.on(RoomEvent.Disconnected, () => void stop());
      await room.connect(created.livekitUrl, created.token);
      await publish(stream);
      ingest?.stop();
      ingest = startIngest(stream, created.roomId, created.ingestToken, (viewers) => {
        fallbackWatchers = viewers;
        people();
      });
      ingest.setFps(Number(qs<HTMLSelectElement>("#compatFps").value) || 5);
      people();
      qs("#setup").classList.add("hidden");
      qs("#live").classList.remove("hidden");
      qs<HTMLInputElement>("#link").value = created.publicUrl;
      qs<HTMLSelectElement>("#resLive").value = String(height);
      qs<HTMLSelectElement>("#fpsLive").value = String(fps);
      history.replaceState(null, "", `/r/${created.roomId}`);
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      localStream?.getTracks().forEach((t) => t.stop());
    }
  }

  async function stop(): Promise<void> {
    ingest?.stop();
    ingest = null;
    fallbackWatchers = [];
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

  qs("#start").addEventListener("click", () => void start());
  qs("#stop").addEventListener("click", () => void stop());
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
  qs("#switch").addEventListener("click", async () => {
    const height = Number(qs<HTMLSelectElement>("#resLive").value);
    const fps = Number(qs<HTMLSelectElement>("#fpsLive").value);
    const audio = qs<HTMLInputElement>("#audio").checked;
    if (!isElectron) {
      try {
        localStream?.getAudioTracks().forEach((t) => t.stop());
        const stream = await getStream({ audio, height, fps });
        await publish(stream);
        ingest?.setStream(stream);
      } catch (e) {
        err.textContent = e instanceof Error ? e.message : String(e);
      }
      return;
    }
    const panel = qs("#liveSources");
    const showing = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !showing);
    if (!showing) return;
    try {
      await loadSources(qs("#liveSourceGrid"), (s) => {
        void (async () => {
          try {
            localStream?.getAudioTracks().forEach((t) => {
              t.stop();
              localStream?.removeTrack(t);
            });
            const stream = await getStream({ sourceId: s.id, audio, height, fps });
            await publish(stream);
            ingest?.setStream(stream);
            if (audio && stream.getAudioTracks().length === 0) await reattachAudio();
            panel.classList.add("hidden");
          } catch (e) {
            err.textContent = e instanceof Error ? e.message : String(e);
          }
        })();
      });
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  const onQuality = () => {
    const height = Number(qs<HTMLSelectElement>("#resLive").value);
    const fps = Number(qs<HTMLSelectElement>("#fpsLive").value);
    const video = localStream?.getVideoTracks()[0];
    if (video) applyQuality(video, height, fps);
  };
  qs("#resLive").addEventListener("change", onQuality);
  qs("#fpsLive").addEventListener("change", onQuality);
  qs("#compatFps").addEventListener("change", () => {
    ingest?.setFps(Number(qs<HTMLSelectElement>("#compatFps").value) || 5);
  });
  async function reattachAudio(): Promise<void> {
    if (!localStream || !room || !qs<HTMLInputElement>("#audio").checked) return;
    for (const t of localStream.getAudioTracks()) {
      localStream.removeTrack(t);
      t.stop();
    }
    const tmp = new MediaStream(localStream.getVideoTracks());
    await addSystemAudio(tmp);
    const audio = tmp.getAudioTracks()[0];
    if (audio) {
      localStream.addTrack(audio);
      if (audioPub) await (audioPub.track as LocalAudioTrack).replaceTrack(audio);
      else {
        audioPub = await room.localParticipant.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          red: false,
          dtx: false,
        });
      }
    } else if (audioPub?.track) {
      await room.localParticipant.unpublishTrack(audioPub.track);
      audioPub = null;
    }
    ingest?.setStream(localStream);
    const audioState = document.querySelector("#audioState");
    const audioOn = localStream.getAudioTracks().length > 0;
    if (audioState) {
      audioState.textContent = audioOn
        ? `audio on${lastAudioLabel ? ` · ${lastAudioLabel}` : ""}`
        : "no audio";
      audioState.classList.toggle("live", !audioOn);
    }
  }

  qs("#audioSrcLive").addEventListener("change", () => {
    const v = qs<HTMLSelectElement>("#audioSrcLive").value;
    localStorage.setItem("ezscreenshare.audioSrc", v);
    const setup = document.querySelector<HTMLSelectElement>("#audioSrc");
    if (setup) setup.value = v;
    void reattachAudio().catch((e) => {
      err.textContent = e instanceof Error ? e.message : String(e);
    });
  });
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
      <div id="gate" class="panel">
        <div class="row">
          <label class="field">nickname
            <input id="nick" type="text" maxlength="32" />
          </label>
          <label class="field">password
            <input id="password" type="password" autocomplete="off" />
          </label>
        </div>
        <div class="row"><button class="btn" id="join" type="button">join</button></div>
        <div class="err" id="err"></div>
      </div>
      <div id="watch" class="hidden">
        <div class="stage">
          <video id="remote" autoplay playsinline webkit-playsinline controls></video>
          <img id="compat" class="compat hidden" alt="" />
        </div>
        <div class="hud">
          <span class="pill" id="status">connecting</span>
        </div>
      </div>
    </div>
  `);

  bindThemeToggle();
  const nick = qs<HTMLInputElement>("#nick");
  nick.value = localStorage.getItem(nickKey) || "";
  const video = qs<HTMLVideoElement>("#remote");
  const compat = qs<HTMLImageElement>("#compat");
  const err = qs("#err");
  let room: Room | null = null;
  let stopWatch: (() => void) | null = null;
  let rtcLive = false;
  let pcmCtx: AudioContext | null = null;
  let pcmGain: GainNode | null = null;
  let pcmAt = 0;

  function setStatus(text: string, live: boolean): void {
    const el = qs("#status");
    el.textContent = text;
    el.classList.toggle("live", live);
  }

  function showWatch(): void {
    qs("#gate").classList.add("hidden");
    qs("#watch").classList.remove("hidden");
  }

  function attach(track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (participant.identity !== "host") return;
    if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;
    track.attach(video);
    video.muted = false;
    video.volume = 1;
    video.playsInline = true;
    video.disablePictureInPicture = false;
    void video.play().catch(() => undefined);
    if (track.kind === Track.Kind.Audio) {
      try {
        (track as RemoteTrack & { setVolume?: (n: number) => void }).setVolume?.(1);
      } catch {
        /* ignore */
      }
    }
    if (track.kind === Track.Kind.Video) {
      rtcLive = true;
      compat.classList.add("hidden");
      video.classList.remove("hidden");
      showWatch();
      setStatus("live", true);
    }
    void pub;
  }

  function sliderGain(): number {
    return 1;
  }

  function playPcm(rate: number, samples: Int16Array): void {
    if (rtcLive || !samples.length) return;
    pcmCtx ??= new AudioContext({ sampleRate: rate });
    pcmGain ??= pcmCtx.createGain();
    pcmGain.connect(pcmCtx.destination);
    void pcmCtx.resume();
    pcmGain.gain.value = sliderGain();
    const f32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) f32[i] = samples[i]! / 32768;
    const buf = pcmCtx.createBuffer(1, f32.length, rate);
    buf.copyToChannel(f32, 0);
    const src = pcmCtx.createBufferSource();
    src.buffer = buf;
    src.connect(pcmGain);
    const now = pcmCtx.currentTime;
    if (pcmAt - now > 0.35) return;
    if (pcmAt < now + 0.05) pcmAt = now + 0.05;
    src.start(pcmAt);
    pcmAt += buf.duration;
  }

  const joinBtn = qs<HTMLButtonElement>("#join");
  qs("#join").addEventListener("click", async () => {
    err.textContent = "";
    localStorage.setItem(nickKey, nick.value.trim() || "viewer");
    joinBtn.disabled = true;
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
      room = new Room(roomOpts("viewer"));
      room.on(RoomEvent.TrackSubscribed, (track, pub, p) => attach(track, pub, p));
      room.on(RoomEvent.TrackPublished, (pub, p) => {
        if (p.identity === "host") void pub.setSubscribed(true);
      });
      room.on(RoomEvent.Disconnected, () => {
        rtcLive = false;
        if (!compat.classList.contains("hidden")) setStatus("compatibility", true);
      });
      stopWatch?.();
      pcmCtx ??= new AudioContext();
      void pcmCtx.resume();
      video.muted = false;
      video.volume = 1;
      video.playsInline = true;
      video.disablePictureInPicture = false;
      showWatch();
      void video.play().catch(() => undefined);
      stopWatch = startWatch(
        compat,
        joined.roomId,
        joined.watchToken,
        nick.value.trim() || "viewer",
        viewerIdentity(),
        {
          isRtcLive: () => rtcLive,
          onFrame: () => {
            if (!rtcLive) {
              showWatch();
              setStatus("compatibility", true);
            }
          },
          onPcm: playPcm,
        },
      );
      void room
        .connect(joined.livekitUrl, joined.token, { peerConnectionTimeout: 20_000 })
        .then(() => {
          for (const p of room!.remoteParticipants.values()) {
            for (const pub of p.trackPublications.values()) {
              if (pub.track) attach(pub.track as RemoteTrack, pub as RemoteTrackPublication, p);
            }
          }
        })
        .catch(() => {
          /* SOCKS/LibreWolf often cannot ICE; HTTP JPEG path is the real viewer. */
        });
      window.setTimeout(() => {
        if (!rtcLive && compat.classList.contains("hidden")) {
          err.textContent = "waiting for the host stream — keep this page, or join again";
          joinBtn.disabled = false;
        }
      }, 12_000);
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
