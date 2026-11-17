#!/usr/bin/env python3
"""Local Spotify Canvas service: converter + now-playing hub for the full-screen Canvas display.

POST /nowplaying            now-playing state from the Spicetify extension (text/plain JSON body)
POST /control               {"action": "playpause"|"next"|"previous"|"seek", "position": ms}, same-origin only;
                            drives Spotify over MPRIS (Linux), 503 when Spotify is not on the session bus
GET /events                 SSE stream of the current state, as JSON "data:" events
GET /view                   the full-screen display page (view.html next to this file)
GET /lookup/<trackId>       200 {"ok":true} once the clip is cached
                            404 {"ok":false,"reason":"no-canvas"} (negative result, cached)
                            502 {"ok":false,"reason":"error"} (upstream failure, short back-off)
GET /canvas/<trackId>.mp4   the cached clip as Spotify serves it (H.264, Range supported)
GET /canvas/<trackId>.webm  VP9 copy made with ffmpeg on first request, for browsers without H.264
POST /custom/<trackId>      raw video or GIF body, same-origin only: converted to H.264 MP4 and used as this track's
                            clip ahead of everything else; also published to the community site when
                            CANVAS_UPLOAD_TOKEN is set
DELETE /custom/<trackId>    removes it again (and unpublishes it, with the token)
GET /custom/<trackId>.mp4   the custom clip
GET /mv/<trackId>.mp4       the music-video loop
GET /mv/<trackId>.full.mp4  the full music video (video only, <= 720p), Range supported
GET /settings               {"order": [...7 source ids], "enabled": {id: bool}, "pins": {trackId: id}}, same-origin only
POST /settings              change any of those (order: every id once; enabled: {id: bool}; pins: {trackId: id|null}),
                            same-origin only, strictly validated; re-picks the clip for the playing track at once
GET /health                 200 {"ok":true}

Source: canvasdownloader.com, one request per track (results cached on disk).
Spotify's own Canvas API is unavailable in PK, so this is the only source. The MP4 is cached untouched: re-encoding
it took ~5 s per track and every Chromium build that ships H.264 plays it as is.

Clip sources, in an order and with on/off switches the user sets (settings.json in the cache, /settings):
  custom     your own clip dropped on the page
  spotify    the track's Spotify Canvas
  community  a community clip (CANVAS_COMMUNITY's index.json, fetched hourly, so the site never learns what is playing)
  mv         an 8 s loop cut from the song's music video (yt-dlp, made locally, never published; CANVAS_MV=0 turns it off)
  artist     a cached clip by the same primary artist
  video      the whole music video, muted, which the page keeps in sync with the song
  cover      the page's ambient cover; always the last resort, even when switched off
The first enabled source that has a clip wins, unless the track is pinned to one. Cheap sources are looked up inline;
mv and video are generated in the background only when they come up in the order with nothing better available, and the
state is upgraded when they finish. The state carries {canvas, source, mode: "loop"|"sync", available, pin, settings}.

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
MAX_UPLOAD = 60 << 20
CUSTOM = os.path.join(CACHE, "custom")
COMMUNITY = os.environ.get("CANVAS_COMMUNITY", "").rstrip("/")    # e.g. https://loopboard.example; "" = off
UPLOAD_TOKEN = os.environ.get("CANVAS_UPLOAD_TOKEN", "")            # admin token: publishes custom clips
INDEX_TTL = 3600
MV = os.path.join(CACHE, "mv")
MV_ON = os.environ.get("CANVAS_MV", "1") != "0" and shutil.which("yt-dlp") is not None
LOOP_S, SEAM_S = 8.0, 0.8      # loop length, crossfade at the seam
MAX_VIDEO_BYTES = int(os.environ.get("CANVAS_VIDEO_CACHE_MB", "1024")) << 20   # LRU cap for full music videos
SETTINGS_FILE = os.path.join(CACHE, "settings.json")
MAX_SETTINGS_BODY = 64 << 10
MAX_PINS = 2000

os.makedirs(CUSTOM, exist_ok=True)
os.makedirs(MV, exist_ok=True)
_mv_lock = threading.Lock()
_locks, _locks_guard, _site_lock = {}, threading.Lock(), threading.Lock()
_last_site = [0.0]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def lock_for(tid):
    with _locks_guard:
        return _locks.setdefault(tid, threading.Lock())


def paths(tid):
    return os.path.join(CACHE, tid + ".mp4"), os.path.join(CACHE, tid + ".json")


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


def download(src_url, dest):
    data = http_get(src_url, timeout=60)
    if len(data) < 1024 or data[4:8] != b"ftyp":
        raise ValueError("not an MP4 (%d bytes)" % len(data))
    with open(dest + ".tmp", "wb") as f:
        f.write(data)
    os.replace(dest + ".tmp", dest)


def to_webm(mp4, dest):
    """VP9 copy for browsers that can't play H.264. Only runs when such a browser asks for one."""
    with tempfile.TemporaryDirectory(dir=CACHE) as tmp:
        out = os.path.join(tmp, "out.webm")
        vf = ("scale='min(720,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,"
              "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p")
        subprocess.run(["nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", mp4, "-an", "-vf", vf,
                        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "33", "-deadline", "good", "-cpu-used", "4",
                        "-row-mt", "1", "-threads", "4", "-g", "48", out], check=True, timeout=300)
        os.replace(out, dest)


def prune():
    files = [os.path.join(CACHE, f) for f in os.listdir(CACHE) if f.endswith((".mp4", ".webm"))]
    files.sort(key=lambda p: os.stat(p).st_mtime)
    total = sum(os.path.getsize(p) for p in files)
    while files and total > MAX_CACHE_BYTES:
        p = files.pop(0)
        total -= os.path.getsize(p)
        try:
            os.remove(p)
        except OSError:
            pass


def primary_artist(artist):
    return (artist or "").split(", ")[0].strip().casefold()


def resolve(tid, artist=""):
    """Return (http_status, meta). Hits canvasdownloader at most once per track per TTL."""
    mp4 = paths(tid)[0]
    with lock_for(tid):
        meta, now = read_meta(tid), time.time()
        if meta:
            if meta.get("ok") and os.path.exists(mp4):
                if artist and not meta.get("artist"):
                    meta["artist"] = primary_artist(artist)
                    write_meta(tid, meta)
                return 200, meta
            if meta.get("reason") == "no-canvas" and now - meta["t"] < NEG_TTL:
                return 404, meta
            if meta.get("reason") == "error" and now - meta["t"] < ERR_TTL:
                return 502, meta
        try:
            src = None
            if meta and meta.get("ok") and meta.get("src"):  # known clip, file pruned or from the WebM era
                try:
                    download(meta["src"], mp4)
                    src = meta["src"]
                except Exception:
                    pass
            if not src:
                src = find_mp4(tid)
                if src:
                    download(src, mp4)
            if src:
                meta = {"ok": True, "src": src, "artist": primary_artist(artist) or (meta or {}).get("artist", ""),
                        "t": now}
                log(tid, "cached %d KB" % (os.path.getsize(mp4) >> 10))
            else:
                meta = {"ok": False, "reason": "no-canvas", "t": now}
                log(tid, "no canvas")
        except Exception as e:  # upstream failure: short back-off, never crash
            meta = {"ok": False, "reason": "error", "error": str(e)[:200], "t": now}
            log(tid, "error", e)
        write_meta(tid, meta)
    if meta["ok"]:
        prune()
    return (200 if meta["ok"] else 404 if meta["reason"] == "no-canvas" else 502), meta


def webm_for(tid):
    """Path of the VP9 copy, made on first request. None if the clip isn't cached or ffmpeg fails."""
    mp4, webm = paths(tid)[0], os.path.join(CACHE, tid + ".webm")
    with lock_for(tid):
        if os.path.exists(webm):
            return webm
        if not os.path.exists(mp4):
            return None
        try:
            to_webm(mp4, webm)
            log(tid, "converted to webm")
            return webm
        except Exception as e:
            log(tid, "webm error", e)
            return None


def artist_clip(artist, exclude):
    """A cached clip of another track by the same primary artist, most recently played first."""
    a = primary_artist(artist)
    if not a:
        return None
    best = None
    for f in os.listdir(CACHE):
        tid = f[:-5]
        if not f.endswith(".json") or tid == exclude or not TRACK_RE.match(tid):
            continue
        meta = read_meta(tid)
        mp4 = paths(tid)[0]
        if meta and meta.get("ok") and meta.get("artist") == a and os.path.exists(mp4):
            m = os.stat(mp4).st_mtime
            if not best or m > best[0]:
                best = (m, tid)
    return best and best[1]


# ---------- custom clips ----------
def custom_path(tid):
    return os.path.join(CUSTOM, tid + ".mp4")


def to_mp4(src, dest):
    """Any video or GIF -> silent H.264 MP4, at most 720x1280, 30 fps and 30 s, ready to loop."""
    enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"]
    if "libx264" not in subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout:
        enc = ["-c:v", "libopenh264", "-b:v", "2500k"]
    vf = ("scale='min(720,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,"
          "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps='min(30,source_fps)',format=yuv420p")
    tmp = dest + ".tmp.mp4"
    try:
        subprocess.run(["nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src, "-an", "-t", "30",
                        "-vf", vf] + enc + ["-movflags", "+faststart", tmp], check=True, timeout=300)
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def community_call(method, tid, body=None, title="", artist=""):
    """PUT/DELETE on the community site with the admin token. Returns None on success, else an error string."""
    if not (COMMUNITY and UPLOAD_TOKEN):
        return "not configured"
    headers = {"Authorization": "Bearer " + UPLOAD_TOKEN, "User-Agent": "spotify-canvas"}
    if body is not None:
        headers.update({"Content-Type": "video/mp4", "X-Title": urllib.parse.quote(title),
                        "X-Artist": urllib.parse.quote(artist)})
    req = urllib.request.Request("%s/api/clips/%s" % (COMMUNITY, tid), data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()
        return None
    except Exception as e:
        return str(e)[:200]


def save_custom(tid, data):
    """Convert and store an uploaded clip. Returns (http_status, json)."""
    with tempfile.TemporaryDirectory(dir=CACHE) as tmp:
        src = os.path.join(tmp, "in")
        with open(src, "wb") as f:
            f.write(data)
        try:
            with lock_for("custom:" + tid):
                to_mp4(src, custom_path(tid))
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
            log(tid, "custom clip error", e)
            return 422, {"ok": False, "reason": "unreadable"}
    log(tid, "custom clip saved")
    with _cond:
        title, artist = (_state.get("title", ""), _state.get("artist", "")) if _state["id"] == tid else ("", "")
    err = None
    if COMMUNITY and UPLOAD_TOKEN:
        with open(custom_path(tid), "rb") as f:
            err = community_call("PUT", tid, f.read(), title, artist)
        log(tid, "published" if not err else "publish failed: " + err)
    refresh(tid)
    return 200, {"ok": True, "published": bool(COMMUNITY and UPLOAD_TOKEN) and not err, "error": err}


def delete_custom(tid):
    try:
        os.remove(custom_path(tid))
    except OSError:
        pass
    err = community_call("DELETE", tid) if COMMUNITY and UPLOAD_TOKEN else None
    refresh(tid)
    return {"ok": True, "unpublished": bool(COMMUNITY and UPLOAD_TOKEN) and not err, "error": err}


# ---------- music video loops ----------
SKIP_WORDS = ("lyric", "cover", "remix", "live", "reaction", "slowed", "reverb", "8d", "karaoke", "instrumental",
              "sped up", "nightcore", "lofi", "lo-fi", "mashup", "teaser", "trailer", "dance", "tutorial")


def norm(t):
    return re.sub(r"[^0-9a-z]+", " ", (t or "").casefold()).strip()


def mv_candidates(title, artist, duration_ms):
    """YouTube videos that are plausibly this exact song, best first."""
    a = primary_artist(artist)
    out = subprocess.run(["yt-dlp", "--flat-playlist", "-j", "--no-warnings", "ytsearch8:%s %s" % (a, title)],
                         capture_output=True, text=True, timeout=60).stdout
    want, an, tn = norm(title), norm(a), norm(title).split()
    found = []
    for line in out.splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        vt, ch = norm(d.get("title")), norm(d.get("channel") or d.get("uploader"))
        if not d.get("id") or want not in vt or (an not in vt and an not in ch):
            continue
        if any(w in vt and w not in want for w in SKIP_WORDS):
            continue
        dur = d.get("duration") or 0
        if duration_ms and dur and abs(dur - duration_ms / 1000) > 20:  # a different edit, or not the song
            continue
        score = (3 if re.search(r"official (music )?video|music video|full video|visuali[sz]er", vt) else 0) \
            + (2 if an in ch else 0) + (1 if "official" in vt else 0) + min((d.get("view_count") or 0) / 1e9, 1)
        found.append((score, d["id"], dur))
    return [(vid, dur) for _, vid, dur in sorted(found, reverse=True)][:2]


def motion(path, start=None, length=None):
    """Mean frame-to-frame change; ~0 for a still cover with audio. start/length sample a part of a long file."""
    window = ["-ss", "%g" % start, "-t", "%g" % length] if start is not None else []
    out = subprocess.run(["ffmpeg", "-v", "error"] + window + ["-i", path, "-an", "-vf",
                         "select='gt(scene,0)',metadata=print:file=-", "-f", "null", "-"],
                         capture_output=True, text=True, timeout=120).stdout
    vals = [float(x) for x in re.findall(r"scene_score=([0-9.]+)", out)]
    return sum(vals) / len(vals) if vals else 0.0


def make_loop(src, dest, start):
    """LOOP_S seconds from src, the last SEAM_S crossfaded into the first frame so it loops without a jump.
    Keeps the video's own aspect ratio; the page fits or fills it."""
    L, F = LOOP_S, SEAM_S
    fc = ("[0:v]scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,"
          "fps='min(30,source_fps)',split[a][b];[a]trim=%g:%g,setpts=PTS-STARTPTS[m];[b]trim=0:%g,setpts=PTS-STARTPTS[h];"
          "[m][h]xfade=transition=fade:duration=%g:offset=%g,format=yuv420p" % (F, L + F, F, F, L - F))
    tmp = dest + ".tmp.mp4"
    try:
        subprocess.run(["nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", "%g" % start, "-t",
                        "%g" % (L + F), "-i", src, "-filter_complex", fc, "-an", "-c:v", "libx264", "-preset", "veryfast",
                        "-crf", "23", "-movflags", "+faststart", tmp], check=True, timeout=300)
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def mv_loop(tid, title, artist, duration_ms):
    """Path of a music-video loop for the track, making it if needed. None if there is no usable video."""
    dest, metap = os.path.join(MV, tid + ".mp4"), os.path.join(MV, tid + ".json")
    if os.path.exists(dest):
        return dest
    try:
        with open(metap) as f:
            if time.time() - json.load(f)["t"] < NEG_TTL:
                return None
    except (OSError, ValueError, KeyError):
        pass
    if not (MV_ON and title and artist):
        return None
    with _mv_lock, tempfile.TemporaryDirectory(dir=CACHE) as tmp:
        if os.path.exists(dest):  # made by another thread while this one waited for the lock
            return dest
        if not still_playing(tid):  # skipped past while queued: don't spend a minute on it
            return None
        meta = {"ok": False, "t": time.time()}
        try:
            for vid, dur in mv_candidates(title, artist, duration_ms):
                a = max(0, int((dur or 180) * 0.35))  # past the intro, usually into the first chorus
                subprocess.run(["yt-dlp", "-q", "--no-warnings", "-f",
                                "bv*[height<=720][vcodec^=avc1]/bv*[height<=720]/bv*", "--download-sections",
                                "*%d-%d" % (a, a + 14), "-o", os.path.join(tmp, vid + ".%(ext)s"),
                                "https://www.youtube.com/watch?v=" + vid], check=True, timeout=180, capture_output=True)
                src = next(os.path.join(tmp, f) for f in os.listdir(tmp) if f.startswith(vid + "."))
                m = motion(src)
                if m < 0.0008:
                    log(tid, "music video %s is a still (%.4f)" % (vid, m))
                    continue
                make_loop(src, dest, 3)
                meta = {"ok": True, "video": vid, "t": time.time()}
                log(tid, "music video loop from %s" % vid)
                break
            else:
                log(tid, "no usable music video")
        except Exception as e:
            log(tid, "music video error", str(e)[:200])
            meta["t"] = time.time() - NEG_TTL + ERR_TTL  # retry after the short back-off
        with open(metap, "w") as f:
            json.dump(meta, f)
    return dest if meta["ok"] else None


VIDEO_FORMAT = ("bv[height<=720][vcodec^=avc1][ext=mp4]/bv[height<=720][vcodec^=avc1]/bv[height<=720]/"
                "bv*[height<=720][vcodec^=avc1]/bv*[height<=720]/bv*")


def prune_videos():
    """Keep the full music videos under MAX_VIDEO_BYTES, least recently played first."""
    files = [os.path.join(MV, f) for f in os.listdir(MV) if f.endswith(".full.mp4")]
    files.sort(key=lambda p: os.stat(p).st_mtime)
    total = sum(os.path.getsize(p) for p in files)
    while len(files) > 1 and total > MAX_VIDEO_BYTES:
        p = files.pop(0)
        total -= os.path.getsize(p)
        try:
            os.remove(p)
        except OSError:
            pass


def mv_video(tid, title, artist, duration_ms):
    """Path of the whole music video (video only, <= 720p), downloading it if needed. None if there is no usable video.
    The page plays it muted, in sync with the song, so it is never cut or looped here."""
    dest, metap = os.path.join(MV, tid + ".full.mp4"), os.path.join(MV, tid + ".full.json")
    if os.path.exists(dest):
        return dest
    try:
        with open(metap) as f:
            meta = json.load(f)
        if not meta.get("ok") and time.time() - meta["t"] < NEG_TTL:
            return None
    except (OSError, ValueError, KeyError):
        pass
    if not (MV_ON and title and artist):
        return None
    with _mv_lock, tempfile.TemporaryDirectory(dir=CACHE) as tmp:
        if os.path.exists(dest):
            return dest
        if not still_playing(tid):
            return None
        meta = {"ok": False, "t": time.time()}
        try:
            for vid, dur in mv_candidates(title, artist, duration_ms):
                subprocess.run(["yt-dlp", "-q", "--no-warnings", "--no-playlist", "--max-filesize", "250M", "-f", VIDEO_FORMAT,
                                "-o", os.path.join(tmp, vid + ".%(ext)s"), "https://www.youtube.com/watch?v=" + vid],
                               check=True, timeout=900, capture_output=True)
                src = next(os.path.join(tmp, f) for f in os.listdir(tmp) if f.startswith(vid + "."))
                m = motion(src, (dur or 180) * 0.35, 14)
                if m < 0.0008:
                    log(tid, "music video %s is a still (%.4f)" % (vid, m))
                    continue
                out = os.path.join(tmp, "final.mp4")  # plain faststart MP4, so the page can seek it with Range requests
                subprocess.run(["nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src, "-an", "-c:v",
                                "copy", "-movflags", "+faststart", out], check=True, timeout=300)
                os.replace(out, dest)
                meta = {"ok": True, "video": vid, "t": time.time()}
                log(tid, "full music video from %s (%d MB)" % (vid, os.path.getsize(dest) >> 20))
                break
            else:
                log(tid, "no usable music video")
        except Exception as e:
            log(tid, "music video download error", str(e)[:200])
            meta["t"] = time.time() - NEG_TTL + ERR_TTL  # retry after the short back-off
        with open(metap, "w") as f:
            json.dump(meta, f)
    if meta["ok"]:
        prune_videos()
    return dest if meta["ok"] else None


# ---------- community index ----------
_community = {"clips": {}, "at": 0.0}


def community_loop():
    while COMMUNITY:
        try:
            idx = json.loads(http_get(COMMUNITY + "/index.json", timeout=20))
            clips = idx.get("clips") if isinstance(idx, dict) else None
            if isinstance(clips, dict):
                _community["clips"] = {k: v for k, v in clips.items()
                                       if TRACK_RE.match(k) and isinstance(v, dict) and isinstance(v.get("url"), str)}
                _community["at"] = time.time()
                log("community index: %d clips" % len(_community["clips"]))
        except Exception as e:
            log("community index error", e)
        time.sleep(INDEX_TTL)


def community_clip(tid):
    c = _community["clips"].get(tid)
    if not c:
        return None
    url = urllib.parse.urljoin(COMMUNITY + "/", c["url"])
    return url if url.startswith(("https://", "http://127.0.0.1", "http://localhost")) else None


# ---------- settings: which sources, in what order, and per-track pins ----------
SOURCE_IDS = ("custom", "spotify", "community", "mv", "artist", "video", "cover")
_settings_lock = threading.Lock()
_settings = {"order": list(SOURCE_IDS), "enabled": {s: s != "video" for s in SOURCE_IDS}, "pins": {}}   # "Canvas first"


def check_settings(d):
    """Strictly validate a settings body. Returns (patch, None) or (None, why). Every field is optional:
    order replaces the order, enabled merges, pins merges ({trackId: source id}, null removes a pin)."""
    if not isinstance(d, dict):
        return None, "the body must be a JSON object"
    if set(d) - {"order", "enabled", "pins"}:
        return None, "unknown field (allowed: order, enabled, pins)"
    patch = {}
    if "order" in d:
        o = d["order"]
        if not (isinstance(o, list) and all(isinstance(x, str) for x in o) and len(o) == len(SOURCE_IDS)
                and set(o) == set(SOURCE_IDS)):
            return None, "order must list each of %s exactly once" % ", ".join(SOURCE_IDS)
        patch["order"] = list(o)
    if "enabled" in d:
        e = d["enabled"]
        if not (isinstance(e, dict) and all(k in SOURCE_IDS and isinstance(v, bool) for k, v in e.items())):
            return None, "enabled must map known source ids to true/false"
        patch["enabled"] = dict(e)
    if "pins" in d:
        p = d["pins"]
        if not (isinstance(p, dict) and len(p) <= MAX_PINS and all(
                TRACK_RE.match(k) and (v is None or (isinstance(v, str) and v in SOURCE_IDS)) for k, v in p.items())):
            return None, "pins must map 22-character track ids to a source id or null"
        patch["pins"] = dict(p)
    return patch, None


def merge_settings(cfg, patch):
    if "order" in patch:
        cfg["order"] = list(patch["order"])
    if "enabled" in patch:
        cfg["enabled"].update(patch["enabled"])
    for tid, sid in patch.get("pins", {}).items():
        cfg["pins"].pop(tid, None)  # a re-pinned track counts as the newest
        if sid:
            cfg["pins"][tid] = sid
    while len(cfg["pins"]) > MAX_PINS:  # drop the oldest
        del cfg["pins"][next(iter(cfg["pins"]))]


def load_settings():
    try:
        with open(SETTINGS_FILE) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return
    if isinstance(d, dict):
        for k in ("order", "enabled", "pins"):  # a damaged part is ignored, the rest still loads
            patch, err = check_settings({k: d[k]}) if k in d else (None, "missing")
            if not err:
                merge_settings(_settings, patch)


def save_settings():  # call with _settings_lock held
    try:
        with open(SETTINGS_FILE + ".tmp", "w") as f:
            json.dump(_settings, f)
        os.replace(SETTINGS_FILE + ".tmp", SETTINGS_FILE)
    except OSError as e:
        log("settings not saved:", e)


def settings_view(pins=False):
    """The settings as the page and /settings show them (a copy); call with _settings_lock held."""
    v = {"order": list(_settings["order"]), "enabled": dict(_settings["enabled"])}
    if pins:
        v["pins"] = dict(_settings["pins"])
    return v


def settings_snapshot(tid):
    with _settings_lock:
        cfg = settings_view()
        cfg["pin"] = _settings["pins"].get(tid) if tid else None
    return cfg


def walk_order(cfg):
    """The enabled sources in the order they are tried, up to an enabled cover (which always has something to show).
    A disabled cover still ends every walk, as the last resort."""
    out = []
    for s in cfg["order"]:
        if s == "cover":
            if cfg["enabled"]["cover"]:
                break
        elif cfg["enabled"][s]:
            out.append(s)
    return out


def choose_source(cfg, ready):
    """A pin wins while its source is ready; otherwise the first enabled ready source; otherwise the cover."""
    if cfg["pin"] in ready:
        return cfg["pin"]
    return next((s for s in walk_order(cfg) if s in ready), "cover")


def probe(tid, sid, artist, reached):
    """URL of the source's clip for this track, or None. reached: the walk got here with nothing better, so the
    Spotify lookup may hit the network; otherwise only what is already on disk counts."""
    if sid == "custom":
        p = custom_path(tid)
        return "/custom/%s.mp4?v=%d" % (tid, os.stat(p).st_mtime) if os.path.exists(p) else None
    if sid == "spotify":
        if reached:
            ok = resolve(tid, artist)[0] == 200
        else:
            meta = read_meta(tid)
            ok = bool(meta and meta.get("ok") and os.path.exists(paths(tid)[0]))
        return "/canvas/%s.mp4" % tid if ok else None
    if sid == "community":
        return community_clip(tid)
    if sid == "artist":
        other = artist_clip(artist, tid)
        return "/canvas/%s.mp4" % other if other else None
    if sid == "mv":
        return "/mv/%s.mp4" % tid if os.path.exists(os.path.join(MV, tid + ".mp4")) else None
    if sid == "video":
        return "/mv/%s.full.mp4" % tid if os.path.exists(os.path.join(MV, tid + ".full.mp4")) else None
    return None


def probe_sources(tid, artist, cfg):
    """{source id: url} for every source that has a clip for the track right now; the cover (None) is always there.
    Enabled sources are looked up in order until one is found; the rest only by what is already cached."""
    walk, ready, hit = walk_order(cfg), {}, False
    for sid in cfg["order"]:
        if sid == "cover":
            continue
        url = probe(tid, sid, artist, sid in walk and not hit)
        if url:
            ready[sid] = url
            hit = hit or sid in walk
    ready["cover"] = None
    return ready


def next_to_generate(cfg, ready, picked, tried):
    """The expensive source (mv or video) worth making now: enabled, ahead of what is showing, and not ready.
    Nothing when a pin is showing."""
    if cfg["pin"] and cfg["pin"] in ready:
        return None
    for s in walk_order(cfg):
        if s == picked:
            break
        if s in ("mv", "video") and s not in ready and s not in tried:
            return s
    return None


load_settings()


# ---------- now playing hub ----------
_state = {"id": None, "enabled": False, "canvas": None, "source": None, "mode": "loop", "available": [], "pin": None,
          "settings": settings_view(), "controls": False}
_cond = threading.Condition()
_version = [0]
_epoch = [0]            # bumped whenever a lookup starts, so an older lookup of the same track stands down
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


def publish_pick(tid, epoch, cfg, ready, sid):
    """Publish the chosen source if it is news. False when the track or the lookup is no longer current."""
    fields = dict(canvas=ready.get(sid), source=sid, mode="sync" if sid == "video" else "loop",
                  available=[s for s in cfg["order"] if s in ready], pin=cfg["pin"], settings=settings_view_of(cfg))
    with _cond:
        if _state["id"] != tid or (epoch is not None and _epoch[0] != epoch):
            return False
        if any(_state.get(k) != v for k, v in fields.items()):
            publish(**fields)
    return True


def settings_view_of(cfg):
    return {"order": cfg["order"], "enabled": cfg["enabled"]}


def look_up_for_display(tid, epoch=None):
    """Pick the clip for the playing track and publish it, then upgrade it as better sources get made."""
    with _cond:
        artist, title, duration = _state.get("artist", ""), _state.get("title", ""), _state.get("duration", 0)
    tried = set()
    while True:
        cfg = settings_snapshot(tid)
        ready = probe_sources(tid, artist, cfg)
        sid = choose_source(cfg, ready)
        if not publish_pick(tid, epoch, cfg, ready, sid):
            return
        nxt = next_to_generate(cfg, ready, sid, tried)
        if not nxt:
            return
        tried.add(nxt)  # whether or not it works, it is not tried again for this lookup
        try:
            (mv_loop if nxt == "mv" else mv_video)(tid, title, artist, duration)
        except Exception as e:
            log(tid, nxt, "generation error", str(e)[:200])


def still_playing(tid):
    with _cond:
        return _state["id"] == tid


def start_lookup(tid):
    with _cond:
        _epoch[0] += 1
        e = _epoch[0]
    threading.Thread(target=look_up_for_display, args=(tid, e), daemon=True).start()


def refresh(tid):
    """Re-pick the clip for the playing track after its custom clip or the settings changed."""
    if still_playing(tid):
        start_lookup(tid)


def update_settings(patch):
    with _settings_lock:
        merge_settings(_settings, patch)
        save_settings()
        with _cond:
            tid = _state["id"]
        publish(settings=settings_view(), pin=_settings["pins"].get(tid) if tid else None)
    if tid:
        refresh(tid)


def apply(tid, fields):
    """Publish a now-playing report; starts the clip lookup when the track changed."""
    if not _enabled[0]:
        return
    with _cond:
        changed = tid != _state["id"] or not _state["enabled"]
    if not changed:
        return publish(enabled=True, **fields)
    publish(id=tid, enabled=True, canvas="pending" if tid else None, source=None, mode="loop", available=[],
            pin=settings_snapshot(tid)["pin"], **fields)
    if tid:
        start_lookup(tid)


def mpris_live():
    return time.time() - _mpris_at[0] < 5


def on_nowplaying(d):
    _enabled[0] = bool(d.get("enabled", True))
    if not _enabled[0]:
        return publish(enabled=False, canvas=None, source=None, mode="loop", available=[], pin=None, id=None)
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
        self.send_header("Access-Control-Allow-Methods", "GET, POST")  # DELETE is same-origin only
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def same_origin(self):
        return self.headers.get("Origin") in (None, *ORIGINS)

    def custom_target(self, path):
        m = re.fullmatch(r"/custom/([A-Za-z0-9]{22})", path)
        return m and m.group(1)

    def do_DELETE(self):
        tid = self.custom_target(urllib.parse.urlparse(self.path).path)
        if not tid:
            return self.send_json(404, {"ok": False})
        if not self.same_origin():
            return self.send_json(403, {"ok": False})
        self.send_json(200, delete_custom(tid))

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        tid = self.custom_target(path)
        if tid:  # custom clips change what everyone sees on the community site: the display page only
            if not self.same_origin():
                return self.send_json(403, {"ok": False})
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 < n <= MAX_UPLOAD:
                return self.send_json(413, {"ok": False, "reason": "too-large"})
            return self.send_json(*save_custom(tid, self.rfile.read(n)))
        if path not in ("/nowplaying", "/control", "/settings"):
            return self.send_json(404, {"ok": False})
        # /control changes playback and /settings what is shown: only the display page itself (same origin) may call
        # them, not any web page
        if path in ("/control", "/settings") and not self.same_origin():
            return self.send_json(403, {"ok": False})
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= (MAX_SETTINGS_BODY if path == "/settings" else MAX_BODY):
            self.close_connection = True  # the body is left unread
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
        if path == "/settings":
            patch, why = check_settings(d)
            if why:
                return self.send_json(400, {"ok": False, "reason": "invalid", "error": why})
            update_settings(patch)
            with _settings_lock:
                view = settings_view()
            return self.send_json(200, dict(view, ok=True))
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
        if path == "/settings":  # the pins are a listening history: not for other web pages
            if not self.same_origin():
                return self.send_json(403, {"ok": False})
            with _settings_lock:
                view = settings_view(pins=True)
            return self.send_json(200, view)
        if path == "/view":
            try:
                with open(VIEW, "rb") as f:
                    body = f.read()
            except OSError:
                return self.send_json(500, {"ok": False, "reason": "no-view"})
            self.head(200, "text/html; charset=utf-8", len(body), [("Cache-Control", "no-store")])
            return self.wfile.write(body)
        m = re.fullmatch(r"/(custom|mv)/([A-Za-z0-9]{22})(\.full)?\.mp4", path)
        if m and (m.group(1) == "mv" or not m.group(3)):
            return self.serve_file(os.path.join(CUSTOM if m.group(1) == "custom" else MV,
                                                m.group(2) + (m.group(3) or "") + ".mp4"), "video/mp4")
        m = re.fullmatch(r"/(lookup|canvas)/([A-Za-z0-9]+)(\.mp4|\.webm)?", path)
        if not m or not TRACK_RE.match(m.group(2)) or (m.group(1) == "canvas") != bool(m.group(3)):
            return self.send_json(400, {"ok": False, "reason": "bad-request"})
        tid = m.group(2)
        if m.group(1) == "lookup":
            code, meta = resolve(tid)
            return self.send_json(code, {k: meta[k] for k in ("ok", "reason") if k in meta})
        if m.group(3) == ".webm":
            p = webm_for(tid)
            return self.serve_file(p, "video/webm") if p else self.send_json(404, {"ok": False, "reason": "not-cached"})
        self.serve_file(paths(tid)[0], "video/mp4")

    def serve_file(self, p, ctype):
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
                    return self.head(416, ctype, 0, [("Content-Range", "bytes */%d" % size)])
                code = 206
            extra = [("Accept-Ranges", "bytes"), ("Cache-Control", "max-age=86400")]
            if code == 206:
                extra.append(("Content-Range", "bytes %d-%d/%d" % (start, end, size)))
            self.head(code, ctype, end - start + 1, extra)
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
    threading.Thread(target=community_loop, daemon=True).start()
    log("listening on 127.0.0.1:%d, cache %s, community %s%s" % (PORT, CACHE, COMMUNITY or "off",
                                                                  " (publishing)" if COMMUNITY and UPLOAD_TOKEN else ""))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
