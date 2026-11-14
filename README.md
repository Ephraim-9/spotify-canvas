# spotify-canvas

A full-screen Spotify Canvas display for a spare monitor, like Canvas on a phone. The looping clip fills the screen edge to edge, with a minimal overlay at the bottom: title, artist and a thin progress bar. Nothing is drawn inside Spotify.

<p align="center"><img src="docs/demo.gif" width="360" alt="Canvas display crossfading into a looping clip with title, artist and progress bar"></p>

It works on any desktop Spotify, including regions where Spotify doesn't serve Canvas: the clips come from [canvasdownloader.com](https://canvasdownloader.com), and a small local service converts them to VP9 WebM.

```
Spotify + Spicetify extension ──POST /nowplaying──▶ canvas_server.py (127.0.0.1:47800)
  (track, title, artist, cover,                       │ track change → canvasdownloader.com (1 request/track, cached)
   duration, position, playing)                       │ canvaz.scdn.co MP4 ─ffmpeg─▶ VP9 WebM ≤720x1280, no audio
                                                      ▼
Any browser window ◀── GET /view + GET /events (SSE) + /canvas/<id>.webm
  (or a kiosk pinned to one monitor by spotify-canvas-kiosk, GNOME only)
```

## Parts

| Part | What it does | Needed |
|---|---|---|
| `extension/spotify-canvas.js` | Spicetify extension. Reports the playing track to the local service. | Yes |
| `service/` | Python service (stdlib only) that fetches and converts Canvas clips and serves the display page. | Yes |
| `kiosk/` | Keeps a full-screen browser window on one monitor. GNOME on Wayland only. | Optional |
| `launcher/spotify` | Spotify wrapper with GPU flags for setups where Spotify's GPU process crashes. | Optional |

## Requirements

- Linux with systemd user services (the service itself is plain Python and runs anywhere)
- [Spicetify](https://spicetify.app)
- `python3` 3.8+, `ffmpeg` and `ffprobe` built with libvpx-vp9
- A Chromium-based browser (Brave by default) for the kiosk, or any browser to open `/view` yourself

No sudo, and no pip packages.

## Install

### 1. Service and display page

```bash
mkdir -p ~/.local/share/spotify-canvas ~/.config/systemd/user
cp service/canvas_server.py service/view.html ~/.local/share/spotify-canvas/
cp service/spotify-canvas.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now spotify-canvas
curl -s 127.0.0.1:47800/health          # {"ok": true}
```

### 2. Extension

From the **Spicetify Marketplace**: search for `spotify-canvas` in the Extensions tab and install it.

Or by hand:

```bash
cp extension/spotify-canvas.js ~/.config/spicetify/Extensions/
spicetify config extensions spotify-canvas.js
spicetify apply
```

Restart Spotify afterwards.

### 3. Show it

**Any monitor, any desktop:** open `http://127.0.0.1:47800/view` in a browser window and make it full screen (F11). An app window keeps the browser chrome out of the way:

```bash
brave-browser --app=http://127.0.0.1:47800/view --autoplay-policy=no-user-gesture-required
```

**GNOME on Wayland, pinned to one monitor:** install the kiosk, which starts with your session and keeps the window on that monitor.

```bash
install -m755 kiosk/spotify-canvas-kiosk ~/.local/bin/
cp kiosk/spotify-canvas-kiosk.service ~/.config/systemd/user/
mkdir -p ~/.config/spotify-canvas
echo CANVAS_MONITOR=DP-1 > ~/.config/spotify-canvas/kiosk.env   # your monitor's connector name
systemctl --user daemon-reload && systemctl --user enable --now spotify-canvas-kiosk
```

## Turning it off

- **For now**: in Spotify, open the profile menu and untick **Canvas display**. The display goes black and stops decoding, and Spotify remembers the setting. Tick it again to bring the display back.
- **Close the kiosk window**: `systemctl --user stop spotify-canvas-kiosk`. It comes back at the next login.
- **For good**: `systemctl --user disable --now spotify-canvas-kiosk`.

## Kiosk

### Choosing the monitor

The kiosk targets a monitor by connector name (default `DP-1`), set in `~/.config/spotify-canvas/kiosk.env`:

```bash
echo CANVAS_MONITOR=HDMI-2 > ~/.config/spotify-canvas/kiosk.env
spotify-canvas-kiosk geometry            # prints x y w h of the target monitor, e.g. "0 0 1080 1920"
systemctl --user restart spotify-canvas-kiosk
```

To find connector names, run `CANVAS_MONITOR=<name> spotify-canvas-kiosk geometry` for each name in `ls /sys/class/drm` (e.g. `card1-DP-1` → `DP-1`). The page fills any size or orientation; a monitor rotated to portrait looks most like Canvas on a phone.

`kiosk.env` also takes `CANVAS_BROWSER=google-chrome` and `CANVAS_KIOSK_FLAGS="..."` for extra browser flags. The kiosk uses its own browser profile in `~/.local/share/spotify-canvas/kiosk-profile`, so your normal browser profiles are never touched.

### How it stays on the monitor

Wayland clients can't choose where their windows go, so the kiosk runs the browser under Xwayland (`--ozone-platform=x11`). It reads the monitor's logical geometry from Mutter (`org.gnome.Mutter.DisplayConfig.GetCurrentState`, which accounts for rotation and scale) and opens the browser with `--window-position`, `--window-size` and `--kiosk`, which fullscreens the window on that monitor.

`spotify-canvas-kiosk` then runs as a supervisor. Every 5 s it reads the window's absolute X geometry (libX11 through ctypes) and relaunches the browser if:
- the window was moved off the monitor (GNOME or a keyboard shortcut can move fullscreen windows),
- it was closed or crashed,
- the monitor's mode changed, or it was unplugged and plugged back in.

Logs: `journalctl --user -u spotify-canvas-kiosk`.

## Display page

`/view` is a black, full-viewport page with no browser chrome, and the cursor is hidden.
- **Canvas**: a muted, looping `<video>` with `object-fit: cover`, filling the screen edge to edge. It pauses when Spotify pauses.
- **No Canvas, or while the clip converts**: the cover art fills the screen and pans slowly across the cropped square.
- **Overlay**: title, artist and a 3 px progress bar over a soft bottom gradient. The bar runs locally from position, duration and play state.
- **Track change**: the new layer crossfades in over about 0.9 s.
- **Events**: `EventSource` reconnects on its own, and the page re-opens the stream if the browser gives up.

## Service

Listens on `127.0.0.1:47800` only (override with `CANVAS_PORT`). Cache dir `~/.cache/spotify-canvas` (`CANVAS_CACHE`).

| Endpoint | Result |
|---|---|
| `POST /nowplaying` | Body is JSON `{enabled,id,title,artist,cover,duration,position,playing}`, sent as `text/plain` so there's no preflight. A new track ID starts the Canvas lookup in the background. |
| `GET /events` | SSE stream of the state: the fields above plus `canvas` (`"/canvas/<id>.webm"`, `"pending"` or `null`) and `age`, in ms since the last report. 15 s keep-alive pings. |
| `GET /view` | The display page. |
| `GET /lookup/<trackId>` | `200 {"ok":true,"width":720,"height":1280}` once converted · `404 {"reason":"no-canvas"}` · `502 {"reason":"error"}` |
| `GET /canvas/<trackId>.webm` | `video/webm` from the cache, with Range support. `404 not-cached` if it's missing. |
| `GET /health` | `{"ok":true}` |

The extension reports on song change, play/pause and seek, plus a heartbeat every 5 s. Chromium stretches the heartbeat to about once a minute while Spotify's window is hidden. Player events still arrive immediately.

Rate limiting:
- One canvasdownloader request per track, at least 2 s apart.
- Results are cached on disk. "No canvas" is re-checked after 7 days, errors after 15 minutes.
- Only the playing track is looked up, never the queue.
- The cache is LRU-pruned at 512 MB.

Logs: `journalctl --user -u spotify-canvas`.

## Spotify GPU crash on Wayland

On some Mesa/Wayland setups, Spotify's GPU process segfaults in `eglInitialize → dri2_initialize_wayland` when it sets up hardware video decode. If Spotify crashes on start or shows a blank window, launch it through `launcher/spotify`, which adds:

```
--disable-gpu-sandbox --disable-accelerated-video-decode
```

```bash
install -m755 launcher/spotify ~/.local/bin/spotify   # make sure ~/.local/bin comes first in PATH
```

It finds Spotify in `/usr/lib64/spotify-client`, `/usr/share/spotify` or `/opt/spotify`; set `SPOTIFY_DIR` otherwise. You can also put the same flags in `spotify_launch_flags` in Spicetify's `config-xpui.ini`. `spicetify apply` relaunches Spotify without the wrapper, so restart it from your launcher afterwards.

## Surviving Spotify updates

A Spotify update removes Spicetify's patches. Run `spicetify backup apply` after each update; `extensions = spotify-canvas.js` stays in `config-xpui.ini`, so the extension comes back with it. The service and kiosk live in `$HOME`, so updates never touch them.

```bash
spicetify path                                   # where Spotify is installed
systemctl --user is-active spotify-canvas spotify-canvas-kiosk
```

## Uninstall

```bash
systemctl --user disable --now spotify-canvas-kiosk spotify-canvas
rm -f ~/.config/systemd/user/spotify-canvas{,-kiosk}.service ~/.local/bin/spotify-canvas-kiosk
spicetify config extensions spotify-canvas.js-
spicetify apply
rm ~/.config/spicetify/Extensions/spotify-canvas.js
rm -rf ~/.local/share/spotify-canvas ~/.cache/spotify-canvas ~/.config/spotify-canvas
systemctl --user daemon-reload
```

## Known limits

- **Upstream site**: canvasdownloader.com can change its HTML, rate-limit, or disappear. Then tracks show the cover fallback. Cached clips keep working.
- **Spotify API**: the extension reads `Spicetify.Player.data.item`, `getProgress`, `getDuration` and `isPlaying`. A client update that renames these fields leaves the overlay blank or the progress bar at 0.
- **Kiosk placement**: the kiosk depends on Mutter honouring an X11 window's requested position. A GNOME change could break this; the supervisor would then relaunch in a loop, about every 25 s, which shows up in its journal. With fractional scaling, the X11 geometry may not match the logical geometry exactly, so the check could misfire.
- **Monitor names**: connector names can change, e.g. after a GPU or driver change (`DP-1` → `DP-2`). Then the kiosk waits with "not active" in its log. Set `CANVAS_MONITOR`.

## Disclaimer

Not affiliated with or endorsed by Spotify. Canvas clips, cover art and the track shown in the demo belong to their respective artists and labels; this project only displays them locally for the person playing the track. Uses an unofficial third-party source, which may stop working at any time.

## License

[MIT](LICENSE)
