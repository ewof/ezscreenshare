# ezscreenshare

i grok'd all of this the readme below was also written by grok i barely touched any code myself here. i can't really "maintain" this since i didn't write it grok 4.6 did. i've tested it and used it a lot with my friends. if someone wants to make a pr for stuff i'll look at it and maybe help test. i think biggest thing it's missing is iOS/android app so mobile devices can screen share but i don't feel like doing that also i wouldn't use it often.

i made this bc a friend doesn't wanna use discord and with xmpp/mumble we have text and voice call but no screensharing and i don't wanna host full on video conference software like jitsi i just want the screenshare service to only do screensharing also rustdesk was giving me issues and that's like remote control software not just screenshare software so i grok'd this.

if you find issues or security vulnerability make issue or maybe even a pr.

---

Private share-a-link screen streaming. You start a room, copy a URL, friends open it in a browser. No accounts, no remote control, no “join our cloud.”

Built for a small group that actually has to work: a Linux host, a Mac, an iPhone, and a friend on hardened LibreWolf behind SOCKS who will not turn proxy protections off just to watch a screen.

## What it is

- **Host** picks a screen, window, or (in Chromium) a tab, optional audio, optional viewer password.
- **Viewers** get a link. Any current browser. They set a nickname and watch.
- You can change source, resolution, and FPS without minting a new link.
- Force TCP is on by default so media does not depend on random UDP.
- If WebRTC cannot connect (common with locked-down Firefox + SOCKS), a TCP fallback still shows the screen and plays sound. Status says `compatibility` instead of `live`. That is intentional, not a failure. Video is VP8 over the websocket (WebCodecs, or WebM/MSE in LibreWolf); audio uses Opus where supported and PCM otherwise. Viewers that cannot decode VP8 get JPEG stills instead.

## What we prioritized

**Watching has to work for the awkward client, not only Chrome on Wi-Fi.**  
The friend who routes everything through SOCKS, refuses WebRTC IP leaks, and will not flip `proxy_only`, still gets the stream. Direct viewers get WebRTC. Nobody is told to “just disable the proxy.”

**Host audio on Linux is a real feature.**  
Browser tab capture can include tab audio in Chromium (the picker has its own checkbox). Desktop and application audio on Linux need the Electron app, which taps PipeWire so the host still hears their headset.

**No remote control.**  
This is look-at-my-screen, not take-over-my-machine.

**Security without making the product annoying.**  
Starting a stream needs a host key. Viewer passwords stay optional. Rooms die when everyone leaves. Tokens are not stuffed into URLs. CORS, CSP, rate limits, and tight Electron permissions are on. We did not force short-lived joins, mandatory viewer passwords, or a sandboxed renderer that cannot list screens.

**Do not advertise the home WAN.**  
ICE and public DNS point at the VPS, not the house.

**iOS is a first-class viewer.**  
H.264 for Safari, a player that is allowed to autoplay after you tap Join. If cellular will not do WebRTC, the same TCP compatibility path applies (VP8, or JPEG if the browser cannot decode it).

## Hosting

**Desktop app (Linux, also buildable for Windows/macOS)**  
Best default. Pick a screen or window, choose audio sources, start, copy the link.

On Linux, the audio picker supports multiple running apps through PipeWire (`pactl`). Uncheck “Entire system” to select individual apps such as Spotify and mpv. Or leave “Entire system” checked and uncheck Mumble to capture everything except Mumble, including apps that start playing later. Closing the app or stopping capture restores the original audio outputs.

On Windows, “Entire system” uses native loopback audio. Per-application selection is currently Linux-only. The Windows fix requires the updated Electron main/preload files, not just a refreshed webpage.

After an update, restart the desktop host and hard-refresh browser hosts and viewers. Already-open host pages continue running their old encoder until reloaded.

**Website in Chromium/Brave**  
Fine for sharing a **tab**. Audio is whatever the browser picker offers (“Share tab audio”). Window/screen audio still wants the desktop app. The in-page audio checkbox and source dropdown are hidden here on purpose — they do not do anything the picker does not already do.

You need the host key from whoever runs the server. Optional viewer password is separate; leave it blank if the link is enough.

## Watching

Open the link. Nickname is stored locally. If the room has a password, enter it. On iPhone, tap Join, then tap the video if Safari left it paused.

`live` is WebRTC (video and audio). `compatibility` is VP8 + PCM over the websocket, or JPEG stills if the browser has no VP8 decoder. Both are valid.

## Run it yourself

Node 22+, pnpm, Docker (for local LiveKit).

```bash
cd ezscreenshare
cp .env.example .env
cp config/livekit.local.yaml.example config/livekit.local.yaml
# put the same 32+ character secret in both files
pnpm install
pnpm dev
# other terminal:
pnpm electron:dev
```

Production: copy `.env.prod.example` → `.env.prod` and `config/livekit.prod.yaml.example` → `config/livekit.prod.yaml`, then `docker compose -f docker-compose.prod.yml up`. Do not rsync local `docker-compose.yml` onto a server (that file is localhost LiveKit). Those env/yaml files are gitignored; the examples are what belong in git.

Use a public name like `share.example.com` and TURN/TLS as `turn.example.com` (the client rewrites `share.` → `turn.` on the same parent domain). Set `PUBLIC_URL` on the server. Desktop hosts type that URL into the app once.

Host key is `HOST_PASSWORD` in `.env` / `.env.prod`. The API reloads it without a restart.

## Linux desktop package

```bash
pnpm dist:linux          # zip, AppImage, unpacked dir under dist/desktop/
pnpm install:local       # ~/.local/bin/ezscreenshare
```

Friends who only watch do not need the zip. Friends who want to host: send the same Linux zip, tell them the server URL and host key. First launch asks for the URL; the key is on the next screen. `./ezscreenshare --no-sandbox` if the Chromium sandbox helper complains.

```bash
pnpm dist:win    # on Windows
pnpm dist:mac    # on macOS
```

## Checks

```bash
pnpm test
pnpm check
pnpm build
```

Compatibility playback uses a bounded jitter buffer and reports stalls to the host so it can reduce video bitrate on a slow path. WebRTC audio and video use the same stream group and receiver buffering target where supported. Actual long-distance latency still depends on the route and available bandwidth.

## Repo layout

| Path | What |
| --- | --- |
| `src/renderer` | Host + viewer UI |
| `src/main`, `src/preload` | Electron: capture, PipeWire tap, clipboard |
| `src/server` | Token API, rooms, websocket fallback (VP8/PCM, JPEG if needed) |
| `config/` | LiveKit local vs prod |
| `deploy/` | nginx snippets for the public name |

FOSS. No telemetry. No remote control.
