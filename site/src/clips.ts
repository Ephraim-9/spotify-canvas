import type { Clip, Env } from "./env";
import { extFor, now } from "./lib";

/** The index.json cache key. Purged (in this colo) whenever the approved set changes. */
export const indexCacheKey = (origin: string) => new Request(`${origin}/index.json`);

export async function purgeIndex(origin: string) {
  try {
    await caches.default.delete(indexCacheKey(origin));
  } catch {
    /* Cache API unavailable (e.g. workers.dev) */
  }
}

const approvedKey = (trackId: string, v: number, type: string) => `clips/${trackId}/${v}.${extFor(type)}`;
export const clipUrl = (c: Pick<Clip, "track_id" | "v" | "content_type">) =>
  `/clips/${c.track_id}/${c.v}.${extFor(c.content_type)}`;

async function nextVersion(env: Env, trackId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(MAX(v), 0) + 1 AS v FROM clips WHERE track_id = ?")
    .bind(trackId)
    .first<{ v: number }>();
  return r?.v ?? 1;
}

interface NewClip {
  trackId: string;
  bytes: ArrayBuffer;
  type: string;
  title: string | null;
  artist: string | null;
  cover: string | null;
  uploaderId: number | null;
}

/** Store a clip and make it the track's current version straight away. */
export async function storeApproved(env: Env, n: NewClip): Promise<{ id: number; v: number }> {
  const v = await nextVersion(env, n.trackId);
  const key = approvedKey(n.trackId, v, n.type);
  await env.CLIPS.put(key, n.bytes, { httpMetadata: { contentType: n.type } });
  const t = now();
  const [, ins] = await env.DB.batch([
    env.DB.prepare("UPDATE clips SET status = 'superseded' WHERE track_id = ? AND status = 'approved'").bind(n.trackId),
    env.DB.prepare(
      `INSERT INTO clips (track_id, v, status, r2_key, content_type, size, title, artist, cover, uploader_id, created_at, reviewed_at)
       VALUES (?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(n.trackId, v, key, n.type, n.bytes.byteLength, n.title, n.artist, n.cover, n.uploaderId, t, t),
  ]);
  return { id: (ins.results[0] as { id: number }).id, v };
}

/** Store a clip under pending/ for moderation. */
export async function storePending(env: Env, n: NewClip): Promise<{ id: number }> {
  const key = `pending/${n.trackId}/${crypto.randomUUID()}.${extFor(n.type)}`;
  await env.CLIPS.put(key, n.bytes, { httpMetadata: { contentType: n.type } });
  const r = await env.DB.prepare(
    `INSERT INTO clips (track_id, v, status, r2_key, content_type, size, title, artist, cover, uploader_id, created_at)
     VALUES (?, NULL, 'pending', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(n.trackId, key, n.type, n.bytes.byteLength, n.title, n.artist, n.cover, n.uploaderId, now())
    .first<{ id: number }>();
  return { id: r!.id };
}

export const getClip = (env: Env, id: number) =>
  env.DB.prepare("SELECT * FROM clips WHERE id = ?").bind(id).first<Clip>();

/** Move a pending clip into place as the track's current version; the previous one becomes superseded. */
export async function approvePending(env: Env, clip: Clip): Promise<number> {
  if (clip.status !== "pending") throw new Error("not pending");
  const obj = await env.CLIPS.get(clip.r2_key);
  if (!obj) throw new Error("pending object missing");
  const v = await nextVersion(env, clip.track_id);
  const key = approvedKey(clip.track_id, v, clip.content_type);
  await env.CLIPS.put(key, await obj.arrayBuffer(), { httpMetadata: { contentType: clip.content_type } });
  await env.DB.batch([
    env.DB.prepare("UPDATE clips SET status = 'superseded' WHERE track_id = ? AND status = 'approved'").bind(clip.track_id),
    env.DB.prepare("UPDATE clips SET status = 'approved', v = ?, r2_key = ?, reviewed_at = ? WHERE id = ?").bind(
      v,
      key,
      now(),
      clip.id,
    ),
  ]);
  await env.CLIPS.delete(clip.r2_key);
  return v;
}

export async function rejectPending(env: Env, clip: Clip) {
  await env.DB.prepare("UPDATE clips SET status = 'rejected', reviewed_at = ? WHERE id = ? AND status = 'pending'")
    .bind(now(), clip.id)
    .run();
  await env.CLIPS.delete(clip.r2_key);
}

/** Take a clip out of circulation. Returns true if it was the track's current clip. */
export async function removeClip(env: Env, clip: Clip, deleteObject: boolean): Promise<boolean> {
  await env.DB.prepare("UPDATE clips SET status = 'removed', reviewed_at = ? WHERE id = ?").bind(now(), clip.id).run();
  if (deleteObject || clip.status === "pending") await env.CLIPS.delete(clip.r2_key);
  return clip.status === "approved";
}

export const currentClip = (env: Env, trackId: string) =>
  env.DB.prepare("SELECT * FROM clips WHERE track_id = ? AND status = 'approved'").bind(trackId).first<Clip>();
