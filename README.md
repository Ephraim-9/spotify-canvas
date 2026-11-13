# spotify-canvas

A full-screen Spotify Canvas display on its own monitor, like Canvas on a phone. The looping clip fills fedora's vertical monitor edge to edge, with a minimal overlay at the bottom: title, artist and a thin progress bar. Nothing is drawn inside Spotify.

Spotify doesn't serve Canvas in Pakistan, so the clips come from canvasdownloader.com. A small local service converts them to VP9 WebM.

```
Spotify + Spicetify extension ──POST /nowplaying──▶ canvas_server.py (127.0.0.1:47800)
  (track, title, artist, cover,                       │ track change → canvasdownloader.com (1 request/track, cached)
   duration, position, playing)                       │ canvaz.scdn.co MP4 ─ffmpeg─▶ VP9 WebM ≤720x1280, no audio
                                                      ▼
Brave kiosk window on DP-1 ◀── GET /view + GET /events (SSE) + /canvas/<id>.webm
  (kept there by spotify-canvas-kiosk)
```

Target host: `fedora` (GNOME on Wayland, Spotify 1.3.8 rpm in `/usr/lib64/spotify-client`, Spicetify 2.46.7, Brave, user `helliot`). DP-1 is rotated to portrait (1080x1920) at x=0, and HDMI-2 is the primary monitor to its right.

## Files

| Repo | Installed at (fedora) |
|---|---|
| `service/canvas_server.py` | `~/.local/share/spotify-canvas/canvas_server.py` |
| `service/view.html` | `~/.local/share/spotify-canvas/view.html` |
| `service/spotify-canvas.service` | `~/.config/systemd/user/spotify-canvas.service` |
| `extension/spotify-canvas.js` | `~/.config/spicetify/Extensions/spotify-canvas.js`, copied by Spicetify into `/usr/lib64/spotify-client/Apps/xpui/extensions/` |
| `kiosk/spotify-canvas-kiosk` | `~/.local/bin/spotify-canvas-kiosk` |
| `kiosk/spotify-canvas-kiosk.service` | `~/.config/systemd/user/spotify-canvas-kiosk.service` |
| `launcher/spotify` | `~/.local/bin/spotify` (Spotify wrapper with the GPU flags, see below) |

The kiosk uses its own browser profile in `~/.local/share/spotify-canvas/kiosk-profile`. Your normal Brave profiles are never touched.

## Install

Needs `python3`, `ffmpeg`/`ffprobe` with libvpx-vp9, Spicetify and Brave (or another Chromium browser). No sudo.

```bash
# service + display page
mkdir -p ~/.local/share/spotify-canvas ~/.config/systemd/user
cp service/canvas_server.py service/view.html ~/.local/share/spotify-canvas/
cp service/spotify-canvas.service kiosk/spotify-canvas-kiosk.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now spotify-canvas
curl -s 127.0.0.1:47800/health          # {"ok": true}

# extension (reports now-playing state only)
cp extension/spotify-canvas.js ~/.config/spicetify/Extensions/
spicetify config extensions spotify-canvas.js
spicetify apply                         # then restart Spotify via ~/.local/bin/spotify

# kiosk on DP-1, started with the graphical session
install -m755 kiosk/spotify-canvas-kiosk ~/.local/bin/
systemctl --user enable --now spotify-canvas-kiosk
```

`spicetify apply` relaunches Spotify without the wrapper flags. Quit Spotify and start it again from the desktop launcher afterwards.

## Turning it off

- **For now**: in Spotify, open the profile menu and untick **Canvas display**. The display goes black and stops decoding, and Spotify remembers the setting. Tick it again to bring the display back.
- **Close the kiosk window**: `systemctl --user stop spotify-canvas-kiosk`. It comes back at the next login.
- **For good**: `systemctl --user disable --now spotify-canvas-kiosk`.

## Moving it to another monitor

The kiosk targets a monitor by connector name (default `DP-1`):

```bash
mkdir -p ~/.config/spotify-canvas
echo CANVAS_MONITOR=HDMI-2 > ~/.config/spotify-canvas/kiosk.env
spotify-canvas-kiosk geometry            # prints x y w h of the target monitor, e.g. "0 0 1080 1920"
systemctl --user restart spotify-canvas-kiosk
```

To find connector names, run `CANVAS_MONITOR=<name> spotify-canvas-kiosk geometry` for each name in `ls /sys/class/drm` (e.g. `card1-DP-1` → `DP-1`). The page fills any size or orientation.

`kiosk.env` also takes `CANVAS_BROWSER=google-chrome` and `CANVAS_KIOSK_FLAGS="..."` for extra browser flags.

## How the kiosk stays on DP-1

Wayland clients can't choose where their windows go, so the kiosk runs Brave under Xwayland (`--ozone-platform=x11`). It reads DP-1's logical geometry from Mutter (`org.gnome.Mutter.DisplayConfig.GetCurrentState`, which accounts for rotation and scale) and opens Brave with `--window-position`, `--window-size` and `--kiosk`, which fullscreens the window on that monitor.

`spotify-canvas-kiosk` then runs as a supervisor. Every 5 s it reads the window's absolute X geometry (libX11 through ctypes) and relaunches Brave if:
- the window was moved off DP-1 (GNOME or a keyboard shortcut can move fullscreen windows),
- it was closed or crashed,
- DP-1's mode changed, or the monitor was unplugged and plugged back in.

Logs: `journalctl --user -u spotify-canvas-kiosk`.

## Display page

`/view` is a black, full-viewport page with no browser chrome, and the cursor is hidden.
- **Canvas**: a muted, looping `<video>` with `object-fit: cover`, filling the screen edge to edge. It pauses when Spotify pauses.
- **No Canvas, or while the clip converts**: the cover art fills the screen and pans slowly across the cropped square.
- **Overlay**: title, artist and a 3 px progress bar over a soft bottom gradient. The bar runs locally from position, duration and play state.
- **Track change**: the new layer crossfades in over about 0.9 s.
- **Events**: `EventSource` reconnects on its own, and the page re-opens the stream if the browser gives up.

## Service

`127.0.0.1:47800` only (override with `CANVAS_PORT`). Cache dir `~/.cache/spotify-canvas` (`CANVAS_CACHE`).

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

## GPU launcher flags (required on fedora)

On fedora's Wayland session, the Spotify GPU process segfaults in Mesa `eglInitialize → dri2_initialize_wayland` when it sets up hardware video decode. The wrapper `~/.local/bin/spotify` (copy in `launcher/spotify`), which the desktop entry runs, therefore adds:

```
--disable-gpu-sandbox --disable-accelerated-video-decode
```

These flags are mirrored in `spotify_launch_flags` in `config-xpui.ini`. Spotify no longer plays video, but keep the wrapper because the GPU sandbox fix still applies. The kiosk Brave also runs with `--disable-accelerated-video-decode`. Software VP9 decode of a 720x1280 clip is cheap.

## Uninstall

```bash
systemctl --user disable --now spotify-canvas-kiosk spotify-canvas
rm ~/.config/systemd/user/spotify-canvas{,-kiosk}.service ~/.local/bin/spotify-canvas-kiosk
spicetify config extensions spotify-canvas.js-
spicetify apply                          # then restart Spotify via ~/.local/bin/spotify
rm ~/.config/spicetify/Extensions/spotify-canvas.js
rm -rf ~/.local/share/spotify-canvas ~/.cache/spotify-canvas ~/.config/spotify-canvas
systemctl --user daemon-reload
```

Pre-install copies of `index.html`, `config-xpui.ini` and the launcher wrapper are in `~/.local/state/spotify-canvas-backup/`. The previous in-Spotify version of the extension and service is in `pre-kiosk/` there.

## Surviving Spotify updates

`spotify-update` (`/usr/local/bin`, from `~/spotify-update-install/`) runs `spicetify backup apply` against the real `config-xpui.ini`. `extensions = spotify-canvas.js` is set there, so the extension is re-injected after every update. The service, kiosk and wrapper live in `$HOME`, so updates never touch them.

```bash
grep -n spotify-canvas /usr/lib64/spotify-client/Apps/xpui/index.html
systemctl --user is-active spotify-canvas spotify-canvas-kiosk
```

## Risks

- **Upstream site**: canvasdownloader.com can change its HTML, rate-limit, or disappear. Then tracks show the cover fallback. Cached clips keep working.
- **Xwayland placement**: the kiosk depends on Mutter honouring an X11 window's requested position. A GNOME change could break this. The supervisor would then relaunch in a loop, about every 25 s, which shows up in its journal. With fractional scaling, the X11 geometry may not match the logical geometry exactly, so the check could misfire.
- **Monitor names**: connector names can change, e.g. after a GPU or driver change (`DP-1` → `DP-2`). Then the kiosk waits with "DP-1 not active" in its log. Set `CANVAS_MONITOR`.
- **Spotify API**: the extension reads `Spicetify.Player.data.item`, `getProgress`, `getDuration` and `isPlaying`. A client update that renames these fields leaves the overlay blank or the progress bar at 0.
- **Launcher flags**: launching `/usr/lib64/spotify-client/spotify` directly, without the wrapper flags, brings back the GPU-process crash.
