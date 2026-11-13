# spotify-canvas

A Spicetify extension that plays a looping Spotify Canvas video for the current track in the Spotify desktop client. Spotify doesn't serve Canvas in Pakistan, so the clips come from canvasdownloader.com. A small local service converts them to VP9 WebM, because the client's CEF can't decode H.264.

```
Spotify (Spicetify) ──songchange──▶ GET 127.0.0.1:47800/lookup/<trackId>
                                     │  canvasdownloader.com (1 request/track, cached)
                                     │  canvaz.scdn.co MP4 ─ffmpeg─▶ VP9 WebM ≤720x1280, no audio
                   ◀── <video src=127.0.0.1:47800/canvas/<id>.webm>
```

Target host: `fedora` (Spotify 1.3.8 rpm in `/usr/lib64/spotify-client`, Spicetify 2.46.7, user `helliot`).

## Files

| Repo | Installed at (fedora) |
|---|---|
| `service/canvas_server.py` | `~/.local/share/spotify-canvas/canvas_server.py` |
| `service/spotify-canvas.service` | `~/.config/systemd/user/spotify-canvas.service` |
| `extension/spotify-canvas.js` | `~/.config/spicetify/Extensions/spotify-canvas.js` (Spicetify copies it into `/usr/lib64/spotify-client/Apps/xpui/extensions/`) |

## Install

Needs `python3`, `ffmpeg`/`ffprobe` with libvpx-vp9, and Spicetify. No sudo.

```bash
# service
mkdir -p ~/.local/share/spotify-canvas ~/.config/systemd/user
cp service/canvas_server.py ~/.local/share/spotify-canvas/
cp service/spotify-canvas.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now spotify-canvas
curl -s 127.0.0.1:47800/health          # {"ok": true}

# extension
cp extension/spotify-canvas.js ~/.config/spicetify/Extensions/
spicetify config extensions spotify-canvas.js
spicetify apply
```

Then restart Spotify from the desktop launcher (`~/.local/bin/spotify`; see GPU note below).

### GPU launcher flags (required on fedora)

On fedora's Wayland session the Spotify GPU process segfaults in Mesa `eglInitialize → dri2_initialize_wayland` when it sets up hardware video decode. Without the flag, every Canvas start crashed the GPU process. Videos then fail with `MEDIA_ERR_DECODE` until Chromium falls back. The user wrapper `~/.local/bin/spotify` (copy in `launcher/spotify`), which the desktop entry runs, therefore adds:

```
--disable-gpu-sandbox --disable-accelerated-video-decode
```

These are mirrored in `spotify_launch_flags` in `config-xpui.ini`. Software VP9 decode of a 720x1280 clip is cheap. The extension also retries a few times after a decode error, so a stray GPU-process crash doesn't leave a black box.

## Uninstall

```bash
spicetify config extensions spotify-canvas.js-
spicetify apply
rm ~/.config/spicetify/Extensions/spotify-canvas.js
systemctl --user disable --now spotify-canvas
rm ~/.config/systemd/user/spotify-canvas.service ~/.local/share/spotify-canvas -r
rm -rf ~/.cache/spotify-canvas
```

Pre-install copies of `index.html`, `config-xpui.ini` and the launcher wrapper are in `~/.local/state/spotify-canvas-backup/`.

## Using it

- **Profile menu → Canvas**
  - **Enabled**: master switch.
  - **Layout: Sidebar**: a 9:16 clip replaces the cover in the Now Playing View (the NPV must be open). One decoder.
  - **Layout: Fullscreen** (default): a sharp 9:16 clip centred over a blurred copy, covering the main view. Two decoders. Close it with **Esc** or the ✕ button.
  - **Layout: Ambient**: a blurred, darkened clip behind the whole UI. One decoder. While it is on, large opaque theme backdrops (e.g. StarryNight's top gradient) are made transparent inline so the clip shows through, and restored when you leave ambient.
- **Topbar "Canvas" button**: switches to fullscreen, or toggles the fullscreen overlay.
- With no Canvas, fullscreen shows the blurred cover art. The other layouts show nothing, and the normal cover stays.
- Video follows playback: it pauses when Spotify pauses or the window is hidden. Inactive layouts hold no `src`, so they hold no decoder.
- Settings live in `localStorage` keys `spotify-canvas:{enabled,layout,fsOpen,none}`. `none` remembers no-Canvas tracks for 7 days.

## Service

`127.0.0.1:47800` only (override with `CANVAS_PORT`). Cache dir `~/.cache/spotify-canvas` (`CANVAS_CACHE`).

| Endpoint | Result |
|---|---|
| `GET /lookup/<trackId>` | `200 {"ok":true,"width":720,"height":1280}` once converted · `404 {"ok":false,"reason":"no-canvas"}` · `502 {"reason":"error"}` |
| `GET /canvas/<trackId>.webm` | `video/webm` with Range support and `Access-Control-Allow-Origin: *` |
| `GET /health` | `{"ok":true}` |

Rate limiting:
- One canvasdownloader request per track, at least 2s apart.
- Results are cached on disk. "No canvas" is re-checked after 7 days, errors after 15 minutes.
- The extension looks up only the track that is playing, never the queue.
- The cache is LRU-pruned at 512 MB.

Logs: `journalctl --user -u spotify-canvas`.

## Surviving Spotify updates

`spotify-update` (`/usr/local/bin`, from `~/spotify-update-install/`) handles client updates. Its user phase:
1. Test-patches a scratch copy, including `~/.config/spicetify/Extensions`.
2. Runs `spicetify backup apply` against the real `config-xpui.ini`.

`extensions = spotify-canvas.js` is set there, so the script tag and extension file are re-injected on every update without a root hook. The launcher wrapper and the systemd unit live in `$HOME`, so updates never touch them. After an update, restart Spotify as `spotify-update` prompts.

Check after an update:

```bash
grep -n spotify-canvas /usr/lib64/spotify-client/Apps/xpui/index.html
systemctl --user is-active spotify-canvas
```

## Risks

- **Upstream site**: canvasdownloader.com can change its HTML, rate-limit, or disappear. Then lookups return 502 or 404 and the UI falls back to the normal cover. Cached clips keep working.
- **Region availability**: some tracks, such as several of The Weeknd's top tracks, have no Canvas on the site. Others are unplayable in PK, and Spotify skips them.
- **Client DOM changes**: the sidebar mounts at `cover-drop-target` or `track-visual-enhancement` in the NPV. A new client may rename these. The other layouts only need `.main-view-container`.
- **Ambient backdrop clearing**: a heuristic samples a 7×7 grid with `elementsFromPoint` every 1.5 s and clears opaque or gradient backgrounds on elements covering ≥8% of the window. A theme change can add layers it misses (e.g. `::before` backgrounds) or clear one it should not.
- **Launcher flags**: launching `/usr/lib64/spotify-client/spotify` directly, without the wrapper flags, brings back the GPU-process crash.
