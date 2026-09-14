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

On macOS 13+, the desktop app captures application audio through ScreenCaptureKit, without a virtual audio driver. Pick any available screen or window independently of audio: select several apps, or use “Entire system” and uncheck apps to exclude them. Selection is per application, so multiple windows/tabs of the same app share its audio selection. The app list includes running apps even if they are currently silent. App selections survive restarts. Microphone/input-device mixing is not included in this picker.

Allow **Screen & System Audio Recording** in macOS System Settings, then quit and reopen the host. When launched from a terminal, macOS may attribute permission to the terminal (such as iTerm) instead. Permission denial is shown as a capture error. Protected content and windows macOS does not expose cannot be captured.

On Windows, choose multiple applications or leave “Entire system” checked and uncheck apps to exclude them. Native WASAPI capture works independently of the selected screen/window and leaves local playback alone. The list shows apps with an audio session, including paused players; play something once if an app is missing, then refresh the sources. Selection is saved by executable name and follows restarted apps. Filtered capture mixes the permitted application sessions; Windows notification sounds are included only in unfiltered “Entire system” capture. Application capture is not gated by the reported Windows build number: it also works on updated Windows 10 systems reporting build 19044. If the native API is unavailable, whole-system capture remains available through Electron loopback. Restart the desktop app after updating its main/preload files, and deploy the updated web interface too.

The audio picker has a search field. Click anywhere on an application row to select or deselect it; its checkmark is on the right. Search only filters the list and does not change your selection. The setup form scrolls vertically when its contents do not fit.

Host settings are remembered on this device for each server: nickname, host key, viewer password, resolution, FPS, audio sharing, force TCP, and viewer-list visibility. Changes are saved as you edit, including resolution/FPS changes during a stream. Clear the viewer password field to save streams without a viewer password again. Audio selections, theme, and stats visibility are also remembered.

On Windows, the desktop buttons above audio sources filter the **video sources** list. All desktops start selected; selected buttons are blue. They only filter the picker, so toggling one does not move windows, change your Windows desktop, or change an active stream. Full-display sources remain available because they follow the active desktop. Windows on other desktops can be selected directly; a game may pause rendering while its desktop is inactive. Desktop names/order use Explorer's registry metadata when available, with window-to-desktop IDs as a fallback.

Some fullscreen games trigger a Windows Graphics Capture bug that hides the host's local cursor while the stream still shows it. For these games, choose a **Full display** video source: Windows display capture uses DXGI/GDI instead of WGC. This shares the entire display, including anything else visible there. Ordinary window capture still uses WGC and can still exhibit that Windows bug. See [Microsoft's issue](https://github.com/microsoft/Windows.UI.Composition-Win32-Samples/issues/128).

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
pnpm dist:mac    # on macOS (requires Xcode Command Line Tools)
```

For a source checkout, `pnpm electron:prod` restores a missing Electron runtime and builds the platform's native helper before opening the app. Windows uses the included .NET Framework compiler (no Visual Studio installation needed); the helper runs as x64, including under Windows ARM64 emulation. On macOS, install Xcode Command Line Tools (`xcode-select --install`) if Swift is unavailable. Packaged apps include the helper and do not need developer tools. The production app loads its interface from the saved server URL, so deploy the updated `dist/web` and restart the desktop app together.

## Checks

```bash
pnpm test
pnpm check
pnpm build
pnpm test:mac  # optional macOS hardware test; plays two quiet test tones
pnpm test:win  # Windows hardware test; plays two quiet tones and checks isolation/mixing
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

### Link previews

Hosts can enable **public link previews** before starting a stream or change the
setting while live. The preference is remembered, and defaults to enabled.
A viewer password always disables previews, regardless of this setting.
The host uploads a JPEG screenshot (up to 960 × 540) when streaming starts and
then every minute. Stream pages include Open Graph image metadata, following the
[same embedding approach as phixiv](https://github.com/thelaao/phixiv/blob/main/templates/artwork.html).

Disabling previews or disconnecting the host removes the server's screenshot.
Screenshots older than two minutes are no longer served. Images are kept only in
server memory. Discord and other services may cache screenshots already fetched:
the minute interval updates the image on this server, but cannot force an existing
Discord message to refresh or delete its cached image.

Run `pnpm build && pnpm test` to exercise preview metadata, uploads, host controls,
password protection, and disconnect cleanup against an isolated local server.
