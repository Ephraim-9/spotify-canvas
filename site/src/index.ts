import { Hono, type Context } from "hono";
import type { AppEnv, Clip, User } from "./env";
import { authRoutes, loadIdentity } from "./auth";
import {
  approvePending,
  clipUrl,
  currentClip,
  getClip,
  indexCacheKey,
  purgeIndex,
  rejectPending,
  removeClip,
  storeApproved,
  storePending,
} from "./clips";
import {
  MAX_BYTES,
  MAX_SECONDS,
  TRACK_RE,
  extFor,
  fetchOembed,
  headerText,
  hmacHex,
  mp4Info,
  now,
  parseRange,
  parseTrackId,
  sniff,
} from "./lib";
import {
  CSP,
  adminPage,
  galleryPage,
  loginPage,
  messagePage,
  privacyPage,
  trackPage,
  uploadPage,
  type PageCtx,
} from "./pages";

const app = new Hono<AppEnv>();

const CORS = { "access-control-allow-origin": "*" };
const UPLOADS_PER_DAY = 10;
const REPORTS_PER_DAY = 10;
const PAGE_SIZE = 48;

// ---------------------------------------------------------------------------
// Public contract for desktop clients. No identity lookup, nothing recorded.
// ---------------------------------------------------------------------------

app.get("/index.json", async (c) => {
  const origin = new URL(c.req.url).origin;
  const cache = caches.default;
  const key = indexCacheKey(origin);
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return hit;

  const { results } = await c.env.DB.prepare(
    "SELECT track_id, v, content_type, reviewed_at FROM clips WHERE status = 'approved'",
  ).all<Pick<Clip, "track_id" | "v" | "content_type" | "reviewed_at">>();
  const last = await c.env.DB.prepare(
    "SELECT MAX(reviewed_at) AS t FROM clips WHERE status IN ('approved', 'superseded', 'removed')",
  ).first<{ t: number | null }>();

  const clips: Record<string, { v: number; url: string; type: string }> = {};
  for (const r of results) clips[r.track_id] = { v: r.v!, url: clipUrl(r), type: r.content_type };
  const body = JSON.stringify({ version: 1, updated: last?.t ?? 0, clips });
  const res = new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", ...CORS },
  });
  c.executionCtx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
});

/** Stream an R2 object with Range support. */
async function serveObject(c: Context<AppEnv>, clip: Clip, cacheControl: string): Promise<Response> {
  const headers = new Headers({
    "content-type": clip.content_type,
    "accept-ranges": "bytes",
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    ...CORS,
  });
  const range = parseRange(c.req.header("range") ?? null, clip.size);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${clip.size}`);
    return new Response(null, { status: 416, headers });
  }
  const head = c.req.method === "HEAD";
  const obj = head
    ? await c.env.CLIPS.head(clip.r2_key)
    : await c.env.CLIPS.get(clip.r2_key, range ? { range } : undefined);
  if (!obj) return c.text("Not found", 404, CORS);
  headers.set("etag", obj.httpEtag);
  const body = head ? null : (obj as R2ObjectBody).body;
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${clip.size}`);
    headers.set("content-length", String(range.length));
    return new Response(body, { status: 206, headers });
  }
  headers.set("content-length", String(clip.size));
  return new Response(body, { status: 200, headers });
}

app.on(["GET", "HEAD"], "/clips/:track/:file", async (c) => {
  const track = c.req.param("track");
  const m = /^(\d+)\.(mp4|webm)$/.exec(c.req.param("file"));
  if (!TRACK_RE.test(track) || !m) return c.text("Not found", 404, CORS);
  // Superseded versions stay reachable so clients holding a slightly stale index don't break.
  const clip = await c.env.DB.prepare(
    "SELECT * FROM clips WHERE track_id = ? AND v = ? AND status IN ('approved', 'superseded')",
  )
    .bind(track, Number(m[1]))
    .first<Clip>();
  if (!clip || extFor(clip.content_type) !== m[2]) return c.text("Not found", 404, CORS);
  return serveObject(c, clip, "public, max-age=31536000, immutable");
});

// ---------------------------------------------------------------------------
// Everything below knows who you are.
// ---------------------------------------------------------------------------

app.use("*", async (c, next) => {
  const { byToken } = await loadIdentity(c);
  // CSRF: state-changing requests authenticated by cookie must come from this origin.
  // A valid bearer token carries no ambient credentials, so those requests are exempt.
  const m = c.req.method;
  if (!byToken && c.req.header("authorization")?.startsWith("Bearer ")) {
    return c.json({ ok: false, error: "Invalid token." }, 401);
  }
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && !byToken) {
    if (c.req.header("origin") !== new URL(c.req.url).origin) {
      return c.json({ ok: false, error: "Cross-site request blocked" }, 403);
    }
  }
  await next();
  if (c.res.headers.get("content-type")?.startsWith("text/html")) {
    c.res.headers.set("content-security-policy", CSP);
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
    c.res.headers.set("cache-control", "private, no-store");
  }
});

app.route("/", authRoutes);

const pctx = (c: Context<AppEnv>): PageCtx => ({ env: c.env, user: c.get("user"), isAdmin: c.get("isAdmin") });

const fail = (c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500, error: string) =>
  c.json({ ok: false, error }, status);

/** Read and validate an uploaded video body. Returns bytes + sniffed type, or an error response. */
async function readVideo(
  c: Context<AppEnv>,
  opts: { checkDuration: boolean },
): Promise<{ bytes: ArrayBuffer; type: string } | Response> {
  const len = Number(c.req.header("content-length") || 0);
  if (len > MAX_BYTES) return fail(c, 413, "File is larger than 15 MB.");
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return fail(c, 400, "Empty file.");
  if (bytes.byteLength > MAX_BYTES) return fail(c, 413, "File is larger than 15 MB.");
  const u8 = new Uint8Array(bytes);
  const kind = sniff(u8);
  if (kind === "image/gif") {
    return fail(c, 415, "GIFs aren't supported. Convert it to MP4 first, e.g. ffmpeg -i in.gif -pix_fmt yuv420p out.mp4");
  }
  if (!kind) return fail(c, 415, "Only MP4 (H.264) or WebM video is accepted.");
  const declared = (c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== kind && declared !== "application/octet-stream") {
    return fail(c, 415, `Content-Type says ${declared} but the file is ${kind}.`);
  }
  if (kind === "video/mp4") {
    const info = mp4Info(u8);
    if (!info) return fail(c, 415, "That MP4 looks incomplete (no moov box).");
    if (!info.h264) return fail(c, 415, "MP4 must use H.264 video.");
    if (opts.checkDuration && info.seconds !== null && info.seconds > MAX_SECONDS + 0.5) {
      return fail(c, 413, `Clip is ${info.seconds.toFixed(1)} s; the limit is ${MAX_SECONDS} s.`);
    }
  }
  return { bytes, type: kind };
}

// ---- Admin API (bearer token or admin email) ----

const requireAdmin = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  if (!c.get("isAdmin")) return fail(c, 401, "Admin only.");
  await next();
};

app.put("/api/clips/:track", requireAdmin, async (c) => {
  const track = c.req.param("track");
  if (!TRACK_RE.test(track)) return fail(c, 400, "Invalid track ID.");
  const v = await readVideo(c, { checkDuration: false });
  if (v instanceof Response) return v;
  let title = headerText(c.req.header("x-title"));
  const artist = headerText(c.req.header("x-artist"));
  let cover: string | null = null;
  if (!title || !artist) {
    const meta = await fetchOembed(track);
    title ??= meta?.title ?? null;
    cover = meta?.cover ?? null;
  }
  const { v: ver } = await storeApproved(c.env, { trackId: track, ...v, title, artist, cover, uploaderId: null });
  await purgeIndex(new URL(c.req.url).origin);
  return c.json({ ok: true, v: ver, url: `/clips/${track}/${ver}.${extFor(v.type)}` });
});

app.delete("/api/clips/:track", requireAdmin, async (c) => {
  const track = c.req.param("track");
  if (!TRACK_RE.test(track)) return fail(c, 400, "Invalid track ID.");
  const clip = await currentClip(c.env, track);
  if (clip) {
    await removeClip(c.env, clip, false);
    await purgeIndex(new URL(c.req.url).origin);
  }
  return c.json({ ok: true });
});

app.post("/api/admin/clips/:id/:action{approve|reject}", requireAdmin, async (c) => {
  const clip = await getClip(c.env, Number(c.req.param("id")));
  if (!clip || clip.status !== "pending") return fail(c, 404, "No such pending clip.");
  if (c.req.param("action") === "approve") {
    const v = await approvePending(c.env, clip);
    await purgeIndex(new URL(c.req.url).origin);
    return c.json({ ok: true, v });
  }
  await rejectPending(c.env, clip);
  return c.json({ ok: true });
});

app.post("/api/admin/reports/:id/:action{dismiss|remove}", requireAdmin, async (c) => {
  const id = Number(c.req.param("id"));
  const r = await c.env.DB.prepare("SELECT clip_id FROM reports WHERE id = ? AND status = 'open'")
    .bind(id)
    .first<{ clip_id: number }>();
  if (!r) return fail(c, 404, "No such open report.");
  if (c.req.param("action") === "dismiss") {
    await c.env.DB.prepare("UPDATE reports SET status = 'dismissed' WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  }
  const clip = await getClip(c.env, r.clip_id);
  if (clip && clip.status !== "removed") {
    await removeClip(c.env, clip, false);
    await purgeIndex(new URL(c.req.url).origin);
  }
  // Close every open report on that clip.
  await c.env.DB.prepare("UPDATE reports SET status = 'actioned' WHERE clip_id = ? AND status = 'open'")
    .bind(r.clip_id)
    .run();
  return c.json({ ok: true });
});

app.post("/api/admin/users/:id", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { trusted?: unknown; banned?: unknown };
  const id = Number(c.req.param("id"));
  const sets: string[] = [];
  const vals: number[] = [];
  for (const k of ["trusted", "banned"] as const) {
    if (body[k] === 0 || body[k] === 1 || typeof body[k] === "boolean") {
      sets.push(`${k} = ?`);
      vals.push(Number(body[k]));
    }
  }
  if (!sets.length) return fail(c, 400, "Nothing to change.");
  const r = await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  if (!r.meta.changes) return fail(c, 404, "No such user.");
  if (body.banned === 1 || body.banned === true) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  }
  return c.json({ ok: true });
});

app.get("/admin/preview/:id", requireAdmin, async (c) => {
  const clip = await getClip(c.env, Number(c.req.param("id")));
  if (!clip || clip.status === "rejected" || clip.status === "removed") return c.text("Not found", 404);
  return serveObject(c, clip, "private, no-store");
});

// ---- User API (cookie session) ----

app.get("/api/track/:id", async (c) => {
  const id = parseTrackId(c.req.param("id"));
  if (!id) return fail(c, 400, "That doesn't look like a Spotify track link.");
  const meta = await fetchOembed(id);
  if (!meta) return fail(c, 404, "Couldn't find that track on Spotify.");
  const cur = await currentClip(c.env, id);
  return c.json({ ok: true, id, ...meta, hasClip: !!cur });
});

app.post("/api/uploads", async (c) => {
  const user = c.get("user");
  if (!user) return fail(c, 401, "Sign in to upload.");
  if (user.banned) return fail(c, 403, "Your account can't upload.");
  const track = parseTrackId(headerText(c.req.header("x-track"), 300) || "");
  if (!track) return fail(c, 400, "That doesn't look like a Spotify track link.");
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM clips WHERE uploader_id = ? AND created_at > ?")
    .bind(user.id, now() - 86400)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= UPLOADS_PER_DAY) return fail(c, 429, `Limit is ${UPLOADS_PER_DAY} uploads per day.`);

  const v = await readVideo(c, { checkDuration: true });
  if (v instanceof Response) return v;
  const meta = await fetchOembed(track);
  if (!meta) return fail(c, 400, "Couldn't find that track on Spotify.");
  const n = {
    trackId: track,
    ...v,
    title: meta.title,
    artist: headerText(c.req.header("x-artist")),
    cover: meta.cover,
    uploaderId: user.id,
  };
  if (user.trusted) {
    const { id, v: ver } = await storeApproved(c.env, n);
    await purgeIndex(new URL(c.req.url).origin);
    return c.json({ ok: true, id, status: "approved", v: ver });
  }
  const { id } = await storePending(c.env, n);
  return c.json({ ok: true, id, status: "pending" });
});

app.delete("/api/uploads/:id", async (c) => {
  const user = c.get("user");
  if (!user) return fail(c, 401, "Sign in first.");
  const clip = await getClip(c.env, Number(c.req.param("id")));
  if (!clip || clip.uploader_id !== user.id) return fail(c, 404, "No such upload.");
  if (clip.status !== "removed" && clip.status !== "rejected") {
    const wasCurrent = await removeClip(c.env, clip, true);
    if (wasCurrent) await purgeIndex(new URL(c.req.url).origin);
  }
  return c.json({ ok: true });
});

const REASONS = new Set(["inappropriate", "wrong_song", "copyright", "other"]);

app.post("/api/reports", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { clip_id?: unknown; reason?: unknown; note?: unknown };
  const clipId = Number(body.clip_id);
  const reason = String(body.reason || "");
  if (!Number.isInteger(clipId) || !REASONS.has(reason)) return fail(c, 400, "Pick a reason.");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
  const clip = await getClip(c.env, clipId);
  if (!clip || (clip.status !== "approved" && clip.status !== "superseded")) return fail(c, 404, "No such clip.");

  const secret = c.env.HASH_SECRET;
  if (!secret) return fail(c, 500, "Reporting is not configured.");
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const ipHash = await hmacHex(secret, ip);
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, now() - 86400)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= REPORTS_PER_DAY) return fail(c, 429, "Too many reports today. Try again tomorrow.");
  await c.env.DB.prepare("INSERT INTO reports (clip_id, reason, note, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(clipId, reason, note, ipHash, now())
    .run();
  return c.json({ ok: true });
});

// ---- Pages ----

app.get("/", async (c) => {
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const page = Math.max(1, Math.min(1000, Number(c.req.query("page")) || 1));
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM clips WHERE status = 'approved'
     ${q ? "AND (title LIKE ?1 ESCAPE '\\' OR artist LIKE ?1 ESCAPE '\\')" : ""}
     ORDER BY reviewed_at DESC, id DESC LIMIT ${PAGE_SIZE + 1} OFFSET ${(page - 1) * PAGE_SIZE}`,
  )
    .bind(...(q ? [like] : []))
    .all<Clip>();
  const more = results.length > PAGE_SIZE;
  return c.html(galleryPage({ ...pctx(c), title: q ? `“${q}”` : undefined }, results.slice(0, PAGE_SIZE), q, page, more));
});

app.get("/t/:track", async (c) => {
  const track = c.req.param("track");
  if (!TRACK_RE.test(track)) return c.html(messagePage(pctx(c), "Not found", "That isn't a track ID."), 404);
  return c.html(trackPage(pctx(c), track, await currentClip(c.env, track)));
});

app.get("/login", (c) => c.html(loginPage(pctx(c))));
app.get("/privacy", (c) => c.html(privacyPage(pctx(c))));

app.get("/upload", async (c) => {
  const user = c.get("user");
  const mine = user
    ? (
        await c.env.DB.prepare("SELECT * FROM clips WHERE uploader_id = ? ORDER BY created_at DESC LIMIT 100")
          .bind(user.id)
          .all<Clip>()
      ).results
    : [];
  return c.html(uploadPage(pctx(c), mine, c.req.query("track") || ""));
});

app.get("/admin", async (c) => {
  if (!c.get("isAdmin")) {
    return c.html(
      c.get("user") ? messagePage(pctx(c), "Not allowed", "This page is for moderators.") : loginPage(pctx(c)),
      c.get("user") ? 403 : 401,
    );
  }
  const pending = await c.env.DB.prepare(
    `SELECT c.*, u.name AS uploader_name, u.email AS uploader_email FROM clips c
     LEFT JOIN users u ON u.id = c.uploader_id WHERE c.status = 'pending' ORDER BY c.created_at LIMIT 100`,
  ).all<Clip & { uploader_name: string | null; uploader_email: string | null }>();
  const reports = await c.env.DB.prepare(
    `SELECT r.id, r.reason, r.note, r.created_at, r.clip_id, c.track_id, c.title, c.artist, c.status AS clip_status
     FROM reports r JOIN clips c ON c.id = r.clip_id WHERE r.status = 'open' ORDER BY r.created_at LIMIT 100`,
  ).all<Parameters<typeof adminPage>[2][number]>();
  const uq = (c.req.query("u") || "").trim().slice(0, 100);
  const users = await c.env.DB.prepare(
    `SELECT id, provider, email, name, avatar, trusted, banned FROM users
     ${uq ? "WHERE name LIKE ?1 OR email LIKE ?1" : ""} ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(...(uq ? [`%${uq}%`] : []))
    .all<User>();
  return c.html(adminPage(pctx(c), pending.results, reports.results, users.results, uq));
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return fail(c, 404, "Not found.");
  return c.html(messagePage(pctx(c), "Not found", "Nothing lives at this address."), 404);
});

app.onError((err, c) => {
  // Log the error only; never request details (IPs, headers).
  console.error("unhandled", err instanceof Error ? err.message : String(err));
  return c.json({ ok: false, error: "Server error." }, 500);
});

export default app;
