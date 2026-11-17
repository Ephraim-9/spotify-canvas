#!/usr/bin/env python3
"""Local Spotify Canvas service: converter + now-playing hub for the full-screen Canvas display.

POST /nowplaying            now-playing state from the Spicetify extension (text/plain JSON body)
POST /control               {"action": "playpause"|"next"|"previous"|"seek", "position": ms}, same-origin only;
                            drives Spotify over MPRIS (Linux), 503 when Spotify is not on the session bus
GET /events                 SSE stream of the current state, as JSON "data:" events
GET /view                   the full-screen display page (view.html next to this file)
GET /lookup/<trackId>       200 {"ok":true,"width":..,"height":..} once the WebM is cached
                            404 {"ok":false,"reason":"no-canvas"} (negative result, cached)
                            502 {"ok":false,"reason":"error"} (upstream/ffmpeg failure, short back-off)
GET /canvas/<trackId>.webm  the cached VP9 WebM (Range supported)
GET /health                 200 {"ok":true}

Source: canvasdownloader.com, one request per track (results cached on disk).
Spotify's own Canvas API is unavailable in PK, so this is the only source.

Now playing: on Linux the service reads Spotify's MPRIS interface over D-Bus (busctl) once a second, which needs
nothing inside Spotify. The extension's reports are used only while MPRIS is unavailable (macOS, Windows, no bus).
"""
import json, os, re, shutil, subprocess, tempfile, threading, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("CANVAS_PORT", "47800"))
CACHE = os.path.expanduser(os.environ.get("CANVAS_CACHE", "~/.cache/spotify-canvas"))
NEG_TTL = 7 * 86400            # re-check "no Canvas" tracks after a week
ERR_TTL = 15 * 60              # back off after upstream errors
MAX_CACHE_BYTES = 512 << 20
SITE_GAP = 2.0                 # min seconds between canvasdownloader requests
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
TRACK_RE = re.compile(r"^[A-Za-z0-9]{22}$")
MP4_RE = re.compile(r"https://canvaz\.scdn\.co/[^\"' <>]+\.mp4")

ORIGINS = ("http://127.0.0.1:%d" % PORT, "http://localhost:%d" % PORT)
VIEW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "view.html")
MAX_BODY = 8192

os.makedirs(CACHE, exist_ok=True)
_locks, _locks_guard, _site_lock = {}, threading.Lock(), threading.Lock()
_last_site = [0.0]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def lock_for(tid):
    with _locks_guard:
        return _locks.setdefault(tid, threading.Lock())


def paths(tid):
    return os.path.join(CACHE, tid + ".webm"), os.path.join(CACHE, tid + ".json")


def read_meta(tid):
    try:
        with open(paths(tid)[1]) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_meta(tid, meta):
    p = paths(tid)[1]
    with open(p + ".tmp", "w") as f:
        json.dump(meta, f)
    os.replace(p + ".tmp", p)


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def find_mp4(tid):
    with _site_lock:  # serialise and space out requests to the public site
        wait = _last_site[0] + SITE_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        try:
            link = urllib.parse.quote("https://open.spotify.com/track/" + tid, safe="")
            html = http_get("https://www.canvasdownloader.com/canvas?link=" + link).decode("utf-8", "replace")
        finally:
            _last_site[0] = time.time()
    m = MP4_RE.search(html)
    return m.group(0) if m else None


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height", "-of", "json", path], capture_output=True, text=True, check=True)
    s = json.loads(out.stdout)["streams"][0]
    return s["width"], s["height"]


def convert(src_url, dest):
    with tempfile.TemporaryDirectory(dir=CACHE) as tmp:
        mp4 = os.path.join(tmp, "in.mp4")
        with open(mp4, "wb") as f:
            f.write(http_get(src_url, timeout=60))
        out = os.path.join(tmp, "out.webm")
        vf = ("scale='min(720,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,"
              "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p")
        subprocess.run(["nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", mp4, "-an", "-vf", vf,
                        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "33", "-deadline", "good", "-cpu-used", "4",
                        "-row-mt", "1", "-threads", "4", "-g", "48", out], check=True, timeout=300)
        w, h = probe(out)
        os.replace(out, dest)
    return w, h


def prune():
    files = [os.path.join(CACHE, f) for f in os.listdir(CACHE) if f.endswith(".webm")]
    files.sort(key=lambda p: os.stat(p).st_mtime)
    total = sum(os.path.getsize(p) for p in files)
    while files and total > MAX_CACHE_BYTES:
        p = files.pop(0)
        total -= os.path.getsize(p)
        for q in (p, p[:-5] + ".json"):
            try:
                os.remove(q)
            except OSError:
                pass


def resolve(tid):
    """Return (http_status, meta). Hits the network at most once per track per TTL."""
    webm = paths(tid)[0]
    with lock_for(tid):
        meta, now = read_meta(tid), time.time()
        if meta:
            if meta.get("ok") and os.path.exists(webm):
                return 200, meta
            if meta.get("reason") == "no-canvas" and now - meta["t"] < NEG_TTL:
                return 404, meta
            if meta.get("reason") == "error" and now - meta["t"] < ERR_TTL:
                return 502, meta
        try:
            src = find_mp4(tid)
            if not src:
                meta = {"ok": False, "reason": "no-canvas", "t": now}
                log(tid, "no canvas")
            else:
                w, h = convert(src, webm)
                meta = {"ok": True, "width": w, "height": h, "src": src, "t": now}
                log(tid, "converted %dx%d" % (w, h))
        except Exception as e:  # upstream or ffmpeg failure: short back-off, never crash
            meta = {"ok": False, "reason": "error", "error": str(e)[:200], "t": now}
            log(tid, "error", e)
        write_meta(tid, meta)
    if meta["ok"]:
        prune()
    return (200 if meta["ok"] else 404 if meta["reason"] == "no-canvas" else 502), meta


# ---------- now playing hub ----------
_state = {"id": None, "enabled": False, "canvas": None, "controls": False}
_cond = threading.Condition()
_version = [0]
_enabled = [True]       # the extension's "Canvas display" menu toggle
_mpris_at = [0.0]       # last successful MPRIS read
_poke = threading.Event()
STALE = 180             # s without any report before a "playing" state is treated as paused


def publish(**changes):
    with _cond:
        _state.update(changes)
        _state["t"] = time.time()
        _version[0] += 1
        _cond.notify_all()


def snapshot():
    with _cond:
        snap = dict(_state)
        snap["age"] = int((time.time() - snap.pop("t", time.time())) * 1000)  # ms since the state was reported
        return _version[0], snap


def look_up_for_display(tid):
    code, _ = resolve(tid)
    with _cond:
        if _state["id"] != tid:  # track changed while converting
            return
    publish(canvas="/canvas/%s.webm" % tid if code == 200 else None)


def apply(tid, fields):
    """Publish a now-playing report; starts the Canvas lookup when the track changed."""
    if not _enabled[0]:
        return
    with _cond:
        changed = tid != _state["id"] or not _state["enabled"]
    if not changed:
        return publish(enabled=True, **fields)
    publish(id=tid, enabled=True, canvas="pending" if tid else None, **fields)
    if tid:
        threading.Thread(target=look_up_for_display, args=(tid,), daemon=True).start()


def mpris_live():
    return time.time() - _mpris_at[0] < 5


def on_nowplaying(d):
    _enabled[0] = bool(d.get("enabled", True))
    if not _enabled[0]:
        return publish(enabled=False, canvas=None, id=None)
    if mpris_live():  # MPRIS is the source of truth; just make the next poll republish if we were disabled
        return _poke.set()
    tid = d.get("id") if isinstance(d.get("id"), str) and TRACK_RE.match(d.get("id")) else None
    s = lambda k, n=300: str(d.get(k) or "")[:n]
    num = lambda k: max(0, int(d.get(k) or 0)) if isinstance(d.get(k), (int, float)) else 0
    cover = s("cover", 500)
    apply(tid, dict(title=s("title"), artist=s("artist"), cover=cover if cover.startswith("https://") else "",
                    duration=num("duration"), position=num("position"), playing=bool(d.get("playing"))))


# ---------- MPRIS (Linux) ----------
MPRIS = ["busctl", "--user", "--json=short"]
MPRIS_DEST = ["org.mpris.MediaPlayer2.spotify", "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player"]
TRACKID_RE = re.compile(r"^/com/spotify/track/([A-Za-z0-9]{22})$")


def mpris_read():
    """(track id or None, fields) from Spotify's MPRIS, or None when Spotify is not on the bus."""
    try:
        out = subprocess.run(MPRIS + ["get-property"] + MPRIS_DEST + ["Metadata", "PlaybackStatus", "Position"],
                             capture_output=True, text=True, timeout=3)
        md, status, pos = (json.loads(line)["data"] for line in out.stdout.splitlines()[:3])
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        return None
    v = lambda k, d="": (md.get(k) or {}).get("data", d)
    m = TRACKID_RE.match(v("mpris:trackid"))
    cover = str(v("mpris:artUrl"))
    if cover.startswith("https://open.spotify.com/image/"):  # older clients
        cover = "https://i.scdn.co/image/" + cover.rsplit("/", 1)[1]
    artist = v("xesam:artist", [])
    return (m.group(1) if m else None), dict(
        title=str(v("xesam:title"))[:300], artist=", ".join(map(str, artist))[:300] if isinstance(artist, list) else "",
        cover=cover[:500] if cover.startswith("https://") else "", duration=int(v("mpris:length", 0)) // 1000,
        position=max(0, int(pos)) // 1000, playing=status == "Playing")


def mpris_call(method, *args):
    try:
        return subprocess.run(["busctl", "--user", "call"] + MPRIS_DEST + [method] + list(args),
                              capture_output=True, timeout=3).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def differs(tid, f):
    with _cond:
        s = dict(_state)
    if tid != s["id"] or not s["enabled"] or not s["controls"]:
        return True
    if any(f[k] != s.get(k) for k in ("title", "artist", "cover", "duration", "playing")):
        return True
    expected = s.get("position", 0) + ((time.time() - s.get("t", 0)) * 1000 if s.get("playing") else 0)
    return abs(f["position"] - expected) > 1500  # seek


def mpris_loop():
    while True:
        r = mpris_read()
        if r:
            _mpris_at[0] = time.time()
            tid, fields = r
            if _enabled[0] and differs(tid, fields):
                apply(tid, dict(fields, controls=True))
        else:
            with _cond:
                was, playing, t = _state["controls"], _state.get("playing"), _state.get("t", 0)
            if was and not mpris_live():  # Spotify quit or left the bus
                publish(controls=False, playing=False)
            elif playing and time.time() - t > STALE:  # extension went quiet: don't show "playing" forever
                publish(playing=False)
        _poke.wait(1 if r else 3)
        _poke.clear()


def control(d):
    """Run a player action over MPRIS. Returns an HTTP status."""
    if not mpris_live():
        return 503
    act = d.get("action")
    if act in ("playpause", "play", "pause", "next", "previous"):
        ok = mpris_call({"playpause": "PlayPause", "play": "Play", "pause": "Pause",
                         "next": "Next", "previous": "Previous"}[act])
    elif act == "seek" and isinstance(d.get("position"), (int, float)):
        with _cond:
            tid = _state["id"]
        if not tid:
            return 409
        ok = mpris_call("SetPosition", "ox", "/com/spotify/track/" + tid, str(max(0, int(d["position"])) * 1000))
    else:
        return 400
    _poke.set()
    return 200 if ok else 502


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def head(self, code, ctype, length, extra=()):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.head(code, "application/json", len(body), [("Cache-Control", "no-store")])
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/nowplaying", "/control"):
            return self.send_json(404, {"ok": False})
        # /control changes playback: only the display page itself (same origin) may call it, not any web page
        if path == "/control" and self.headers.get("Origin") not in (None, *ORIGINS):
            return self.send_json(403, {"ok": False})
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= MAX_BODY:
            return self.send_json(413, {"ok": False})
        try:
            d = json.loads(self.rfile.read(n))
            if not isinstance(d, dict):
                raise ValueError
        except ValueError:
            return self.send_json(400, {"ok": False, "reason": "bad-json"})
        if path == "/control":
            code = control(d)
            return self.send_json(code, {"ok": code == 200})
        on_nowplaying(d)
        self.send_json(200, {"ok": True})

    def events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.close_connection = True
        seen = -1
        try:
            self.wfile.write(b"retry: 2000\n\n")
            while True:
                with _cond:
                    _cond.wait_for(lambda: _version[0] != seen, timeout=15)
                v, snap = snapshot()
                if v == seen:
                    self.wfile.write(b": ping\n\n")  # keep-alive, also detects a closed page
                else:
                    seen = v
                    self.wfile.write(b"data: " + json.dumps(snap).encode() + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            return self.send_json(200, {"ok": True, "mpris": mpris_live()})
        if path == "/events":
            return self.events()
        if path == "/view":
            try:
                with open(VIEW, "rb") as f:
                    body = f.read()
            except OSError:
                return self.send_json(500, {"ok": False, "reason": "no-view"})
            self.head(200, "text/html; charset=utf-8", len(body), [("Cache-Control", "no-store")])
            return self.wfile.write(body)
        m = re.fullmatch(r"/(lookup|canvas)/([A-Za-z0-9]+)(\.webm)?", path)
        if not m or not TRACK_RE.match(m.group(2)):
            return self.send_json(400, {"ok": False, "reason": "bad-request"})
        if m.group(1) == "lookup":
            code, meta = resolve(m.group(2))
            return self.send_json(code, {k: meta[k] for k in ("ok", "width", "height", "reason") if k in meta})
        self.serve_file(paths(m.group(2))[0])

    def serve_file(self, p):
        try:
            f = open(p, "rb")
        except OSError:
            return self.send_json(404, {"ok": False, "reason": "not-cached"})
        with f:
            size = os.fstat(f.fileno()).st_size
            start, end, code = 0, size - 1, 200
            rng = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
            if rng and (rng.group(1) or rng.group(2)):
                if rng.group(1):
                    start = int(rng.group(1))
                    end = min(int(rng.group(2)) if rng.group(2) else end, size - 1)
                else:
                    start = max(0, size - int(rng.group(2)))
                if start > end:
                    return self.head(416, "video/webm", 0, [("Content-Range", "bytes */%d" % size)])
                code = 206
            extra = [("Accept-Ranges", "bytes"), ("Cache-Control", "max-age=86400")]
            if code == 206:
                extra.append(("Content-Range", "bytes %d-%d/%d" % (start, end, size)))
            self.head(code, "video/webm", end - start + 1, extra)
            f.seek(start)
            try:
                if code == 200:
                    shutil.copyfileobj(f, self.wfile)
                else:
                    self.wfile.write(f.read(end - start + 1))
            except (BrokenPipeError, ConnectionResetError):
                pass
        try:
            os.utime(p)  # mtime doubles as last-used for the LRU prune
        except OSError:
            pass


if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    threading.Thread(target=mpris_loop, daemon=True).start()
    log("listening on 127.0.0.1:%d, cache %s" % (PORT, CACHE))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
