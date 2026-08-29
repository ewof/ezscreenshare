import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, Menu, session } from "electron";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER || process.env.ELECTRON_DEV);
const settingsFile = join(here, "settings.html");

function configPath() {
  return join(app.getPath("userData"), "config.json");
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(next) {
  writeFileSync(configPath(), JSON.stringify(next, null, 2));
}

function normalizeServerUrl(raw) {
  let u = String(raw ?? "").trim();
  if (!u) throw new Error("enter the server URL");
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("URL must be http or https");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function serverUrl() {
  if (process.env.EZ_URL) return process.env.EZ_URL.replace(/\/$/, "");
  if (isDev) return "http://127.0.0.1:5173";
  return String(readConfig().serverUrl || "");
}

app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer,LoopbackWaveIn");

let capture = { id: "", audio: true };
let win;
let mediaArmedUntil = 0;
function armMedia() {
  mediaArmedUntil = Date.now() + 180_000;
}

function registerCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 1, height: 1 },
    });
    const chosen =
      sources.find((s) => s.id === capture.id) ||
      sources[0];
    if (!chosen) {
      callback({});
      return;
    }
    // Video only here. Linux loopback is a no-op; system audio is the PipeWire
    // sink monitor added in the renderer via getUserMedia.
    callback({ video: { id: chosen.id, name: chosen.name } });
  });
}

ipcMain.handle("ez:getSources", async () => {
  armMedia();
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 160, height: 90 },
      fetchWindowIcons: false,
    });
    console.log(`[ezs] sources ${sources.length}`);
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith("screen:") ? "screen" : "window",
      thumbnail: s.thumbnail.toDataURL(),
    }));
  } catch (e) {
    console.error("[ezs] getSources", e);
    throw e;
  }
});

ipcMain.handle("ez:setCapture", (_e, id, audio) => {
  armMedia();
  capture = { id, audio: Boolean(audio) };
});

function pactl(args) {
  return new Promise((resolve) => {
    execFile("pactl", args, { timeout: 2500 }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

ipcMain.handle("ez:monitorHint", async () => {
  const sink = (await pactl(["get-default-sink"])).trim();
  if (!sink) return "";
  const list = await pactl(["list", "sources"]);
  const want = `${sink}.monitor`;
  for (const block of list.split(/Source #\d+/)) {
    if (!block.includes(`Name: ${want}`)) continue;
    const desc = block.match(/Description:\s*(.+)/);
    return (desc?.[1] || want).trim();
  }
  return want;
});

ipcMain.handle("ez:copyText", (_e, text) => {
  clipboard.writeText(String(text ?? ""));
});

const TAP = "ezs-tap";
const VIRT = "ezs-virt";
const SKIP_APP = /speech-dispatcher|pipewire|pulseaudio|ezscreenshare|loopback/i;
let tap = { sinkMod: "", loopMod: "", remapMod: "", remapMaster: "", moved: [], hearSink: "", wanted: "" };

function unquote(s) {
  return String(s || "").replace(/^"|"$/g, "");
}

function parseSinkInputs(raw) {
  const out = [];
  for (const block of String(raw).split(/Sink Input #/)) {
    const index = block.match(/^(\d+)/)?.[1];
    if (!index) continue;
    const sink = block.match(/\n\s*Sink:\s*(\S+)/)?.[1];
    const app =
      unquote(block.match(/application\.name = "([^"]*)"/)?.[1]) ||
      unquote(block.match(/node\.name = "([^"]*)"/)?.[1]) ||
      unquote(block.match(/application\.process\.binary = "([^"]*)"/)?.[1]);
    const media = unquote(block.match(/media\.name = "([^"]*)"/)?.[1]);
    if (!app || SKIP_APP.test(app) || /loopback/i.test(media)) continue;
    out.push({ index, sink, app, media });
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sinkIdToName(id) {
  const raw = String(id || "").trim();
  if (!raw) return (await pactl(["get-default-sink"])).trim();
  if (!/^\d+$/.test(raw)) return raw;
  const short = await pactl(["list", "short", "sinks"]);
  for (const line of short.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === raw) return cols[1] || raw;
  }
  return raw;
}

async function realHearSink() {
  const raw = (await pactl(["get-default-sink"])).trim();
  if (raw && raw !== TAP && !raw.includes(TAP)) return raw;
  if (tap.hearSink && tap.hearSink !== TAP && !tap.hearSink.includes(TAP)) return tap.hearSink;
  const short = await pactl(["list", "short", "sinks"]);
  for (const line of short.split("\n")) {
    const name = line.trim().split(/\s+/)[1];
    if (name && name !== TAP && !name.includes(TAP)) return name;
  }
  return raw;
}

async function pinHearSink(hearSink) {
  const dest = hearSink && hearSink !== TAP ? hearSink : await realHearSink();
  if (!dest || dest === TAP) return dest;
  const def = (await pactl(["get-default-sink"])).trim();
  if (!def || def === TAP || def.includes(TAP)) await pactl(["set-default-sink", dest]);
  await pactl(["set-sink-mute", dest, "0"]);
  return dest;
}

async function restoreMoved() {
  for (const m of tap.moved) {
    let dest = await sinkIdToName(m.sink);
    if (!dest || dest === TAP || dest.includes(TAP)) dest = tap.hearSink;
    if (dest) await pactl(["move-sink-input", m.index, dest]);
  }
  tap.moved = [];
}

function loopbackInputIds(raw) {
  const ids = [];
  for (const block of String(raw).split(/Sink Input #/)) {
    const index = block.match(/^(\d+)/)?.[1];
    if (!index) continue;
    const media = unquote(block.match(/media\.name = "([^"]*)"/)?.[1] || "");
    const app = unquote(block.match(/application\.name = "([^"]*)"/)?.[1] || "");
    if (!/loopback/i.test(media) && !/loopback/i.test(app)) continue;
    if (!/ezs-tap|ezscreenshare/i.test(block)) continue;
    ids.push(index);
  }
  return ids;
}

async function setHearMute(mute) {
  const ids = loopbackInputIds(await pactl(["list", "sink-inputs"]));
  for (const id of ids) await pactl(["set-sink-input-mute", id, mute ? "1" : "0"]);
  return ids;
}

async function waitHearInputs(ms = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ids = await setHearMute(true);
    if (ids.length) return ids;
    await sleep(25);
  }
  return [];
}

async function findLoopModule(hearSink) {
  const mods = await pactl(["list", "short", "modules"]);
  for (const line of mods.split("\n")) {
    if (!line.includes("module-loopback")) continue;
    if (!line.includes(`${TAP}.monitor`)) continue;
    if (hearSink && !line.includes(`sink=${hearSink}`)) continue;
    const id = line.trim().split(/\s+/)[0];
    if (id) return id;
  }
  return "";
}

async function unloadMatchingModules(needle, keepId) {
  const mods = await pactl(["list", "short", "modules"]);
  for (const line of mods.split("\n")) {
    if (!line.includes(needle)) continue;
    const id = line.trim().split(/\s+/)[0];
    if (id && id !== keepId) await pactl(["unload-module", id]);
  }
}

async function teardownTap() {
  const hear = tap.hearSink;
  await restoreMoved();
  await pinHearSink(hear);
  await unloadMatchingModules(`source=${TAP}.monitor`, "");
  await unloadMatchingModules(`source_name=${VIRT}`, "");
  await unloadMatchingModules(`sink_name=${TAP}`, "");
  if (tap.remapMod) await pactl(["unload-module", tap.remapMod]);
  if (tap.loopMod) await pactl(["unload-module", tap.loopMod]);
  if (tap.sinkMod) await pactl(["unload-module", tap.sinkMod]);
  tap.remapMod = "";
  tap.remapMaster = "";
  tap.loopMod = "";
  tap.sinkMod = "";
  tap.hearSink = "";
  tap.wanted = "";
  await pinHearSink(hear);
}

async function ensureTap(hearSink) {
  tap.hearSink = hearSink;
  const sinks = await pactl(["list", "short", "sinks"]);
  if (!sinks.includes(TAP)) {
    tap.sinkMod = (
      await pactl([
        "load-module",
        "module-null-sink",
        `sink_name=${TAP}`,
        "sink_properties=device.description=ezscreenshare",
      ])
    ).trim();
  }
  await pinHearSink(hearSink);
  await pactl(["set-sink-mute", TAP, "1"]);
  const existing = tap.loopMod && tap.hearSink === hearSink ? tap.loopMod : await findLoopModule(hearSink);
  if (existing) {
    tap.loopMod = existing;
    tap.hearSink = hearSink;
    await setHearMute(true);
    await unloadMatchingModules(`source=${TAP}.monitor`, tap.loopMod);
    await pinHearSink(hearSink);
    return;
  }
  await unloadMatchingModules(`source=${TAP}.monitor`, "");
  tap.loopMod = (
    await pactl([
      "load-module",
      "module-loopback",
      `source=${TAP}.monitor`,
      `sink=${hearSink}`,
      "latency_msec=50",
    ])
  ).trim();
  tap.hearSink = hearSink;
  await waitHearInputs();
  await pinHearSink(hearSink);
}

async function ensureVirt(masterMonitor) {
  if (tap.remapMod && tap.remapMaster === masterMonitor) return;
  if (tap.remapMod) {
    await pactl(["unload-module", tap.remapMod]);
    tap.remapMod = "";
    tap.remapMaster = "";
    await sleep(50);
  }
  tap.remapMod = (
    await pactl([
      "load-module",
      "module-remap-source",
      `master=${masterMonitor}`,
      `source_name=${VIRT}`,
      "source_properties=device.description=ezscreenshare",
    ])
  ).trim();
  tap.remapMaster = tap.remapMod ? masterMonitor : "";
  if (!tap.remapMod) console.warn("[ezs] remap-source failed for", masterMonitor);
}

ipcMain.handle("ez:listAudioSources", async () => {
  const inputs = parseSinkInputs(await pactl(["list", "sink-inputs"]));
  const byApp = new Map();
  for (const inp of inputs) {
    if (!byApp.has(inp.app)) byApp.set(inp.app, []);
    byApp.get(inp.app).push(inp);
  }
  const apps = [];
  for (const [app, items] of byApp) {
    let label = app;
    const media = items[0]?.media || "";
    if (items.length === 1 && media && !/^(playback|Playback Stream|audio stream)$/i.test(media)) {
      label = `${app} — ${media.length > 48 ? `${media.slice(0, 48)}…` : media}`;
    }
    apps.push({ id: `app:${app}`, label, monitor: false, running: true });
  }
  apps.sort((a, b) => a.label.localeCompare(b.label));
  return [{ id: "system", label: "Entire system", monitor: true, running: true }, ...apps];
});

ipcMain.handle("ez:beginMonitorCapture", async (_e, sourceId) => {
  armMedia();
  const sink = await realHearSink();
  const wanted = String(sourceId || "system").trim();
  if (wanted === "none" || !sink) return { ok: false, prev: "", label: "" };

  const appName = wanted.startsWith("app:") ? wanted.slice(4) : "";
  const reuse = tap.wanted === wanted && tap.moved.length > 0 && tap.remapMod;
  if (!reuse) {
    await restoreMoved();
    await ensureTap(sink);
    await ensureVirt(`${TAP}.monitor`);
    await pactl(["set-sink-mute", TAP, "1"]);
    await setHearMute(true);
    await pinHearSink(sink);
    const inputs = parseSinkInputs(await pactl(["list", "sink-inputs"]));
    for (const inp of inputs) {
      if (appName && inp.app !== appName) continue;
      let orig = await sinkIdToName(inp.sink || sink);
      if (orig === TAP || orig.includes(TAP)) orig = sink;
      await pactl(["move-sink-input", inp.index, TAP]);
      tap.moved.push({ index: inp.index, sink: orig });
    }
    tap.wanted = wanted;
    await sleep(120);
    await pactl(["set-sink-mute", TAP, "0"]);
    await setHearMute(false);
    await pinHearSink(sink);
  } else {
    await ensureTap(sink);
    await ensureVirt(`${TAP}.monitor`);
    await pactl(["set-sink-mute", TAP, "0"]);
    await setHearMute(false);
    await pinHearSink(sink);
  }
  if (appName && !tap.moved.length) {
    console.warn("[ezs] no sink-input for", appName);
    tap.wanted = "";
    return { ok: false, prev: "", label: "" };
  }
  return {
    ok: Boolean(tap.remapMod),
    prev: "",
    label: appName || "Entire system",
    hints: ["ezscreenshare", "Monitor of ezscreenshare"],
  };
});

ipcMain.handle("ez:endMonitorCapture", async () => {
  /* Default source is left alone so the headset does not click. */
});

ipcMain.handle("ez:releaseAudioTap", () => teardownTap());

ipcMain.handle("ez:getServerUrl", () => serverUrl());

ipcMain.handle("ez:setServerUrl", async (_e, raw) => {
  const url = normalizeServerUrl(raw);
  writeConfig({ ...readConfig(), serverUrl: url });
  if (win && !win.isDestroyed()) await win.loadURL(url);
  return url;
});

function allowedNavigation(url) {
  if (url.startsWith("file://") && url.includes("settings.html")) return true;
  if (isDev && url.startsWith("http://127.0.0.1:5173")) return true;
  const saved = serverUrl();
  if (!saved) return false;
  try {
    return new URL(url).origin === new URL(saved).origin;
  } catch {
    return false;
  }
}

async function showSettings(message) {
  await win.loadFile(settingsFile, message ? { query: { err: String(message) } } : {});
}

async function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 780,
    backgroundColor: "#2e3440",
    autoHideMenuBar: false,
    show: true,
    webPreferences: {
      preload: join(here, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox + ESM preload does not load (window.ez missing). Linux
      // desktopCapturer/PipeWire also returns no sources in a sandboxed renderer.
      sandbox: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (!allowedNavigation(url)) e.preventDefault();
  });
  win.webContents.on("did-fail-load", (_e, _code, desc, url, isMain) => {
    if (!isMain || isDev || url.startsWith("file://")) return;
    void showSettings(desc || "could not reach that server");
  });
  const url = serverUrl();
  console.log(`ezscreenshare loading ${url || "settings"} (dev=${isDev})`);
  if (url) await win.loadURL(url);
  else await showSettings();
  win.show();
  win.focus();
}

app.whenReady().then(async () => {
  const always = new Set(["clipboard-sanitized-write", "display-capture"]);
  const whenArmed = new Set(["media", "audioCapture", "videoCapture", "speaker-selection"]);
  const allow = (permission) =>
    always.has(permission) || (whenArmed.has(permission) && Date.now() < mediaArmedUntil);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allow(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allow(permission));
  registerCapture();
  await teardownTap();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "ezscreenshare",
        submenu: [
          {
            label: "Server…",
            click: () => {
              if (win && !win.isDestroyed()) void showSettings();
            },
          },
          { role: "reload" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
    ]),
  );
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", () => {
  void teardownTap();
});

app.on("window-all-closed", () => {
  void teardownTap();
  if (process.platform !== "darwin") app.quit();
});
