export const TRACK_RE = /^[A-Za-z0-9]{22}$/;
export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_SECONDS = 30;

export const now = () => Math.floor(Date.now() / 1000);

/** Track ID from a bare ID, spotify:track:<id>, or an open.spotify.com link (intl-xx/, query strings ok). */
export function parseTrackId(input: string): string | null {
  const s = input.trim();
  if (TRACK_RE.test(s)) return s;
  const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(s);
  if (uri) return uri[1];
  let url: URL;
  try {
    url = new URL(s.startsWith("http") ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.hostname !== "open.spotify.com") return null;
  const m = /^\/(?:intl-[A-Za-z-]+\/)?(?:embed\/)?track\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
  return m ? m[1] : null;
}

export type Sniffed = "video/mp4" | "video/webm" | "image/gif" | null;

/** Identify a file by its magic bytes. */
export function sniff(b: Uint8Array): Sniffed {
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  return null;
}

export const extFor = (type: string) => (type === "video/webm" ? "webm" : "mp4");

/**
 * Walk top-level MP4 boxes to moov. Returns the duration from mvhd and whether
 * the sample descriptions mention H.264 (avc1/avc3). null when there is no moov.
 */
export function mp4Info(b: Uint8Array): { seconds: number | null; h264: boolean } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 0;
  while (off + 8 <= b.length) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    let header = 8;
    if (size === 1) {
      if (off + 16 > b.length) return null;
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = b.length - off;
    }
    if (size < header) return null;
    if (type === "moov") {
      const moov = b.subarray(off + header, Math.min(off + size, b.length));
      return { seconds: mvhdSeconds(moov), h264: contains(moov, "avc1") || contains(moov, "avc3") };
    }
    off += size;
  }
  return null;
}

function mvhdSeconds(moov: Uint8Array): number | null {
  const i = indexOf(moov, "mvhd");
  if (i < 0) return null;
  const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const p = i + 4; // version/flags
  if (p + 4 > moov.length) return null;
  const version = moov[p];
  if (version === 1) {
    if (p + 32 > moov.length) return null;
    const timescale = dv.getUint32(p + 20);
    const duration = Number(dv.getBigUint64(p + 24));
    return timescale ? duration / timescale : null;
  }
  if (p + 20 > moov.length) return null;
  const timescale = dv.getUint32(p + 12);
  const duration = dv.getUint32(p + 16);
  return timescale ? duration / timescale : null;
}

function indexOf(b: Uint8Array, ascii: string): number {
  const c = [...ascii].map((ch) => ch.charCodeAt(0));
  outer: for (let i = 0; i + c.length <= b.length; i++) {
    for (let j = 0; j < c.length; j++) if (b[i + j] !== c[j]) continue outer;
    return i;
  }
  return -1;
}
const contains = (b: Uint8Array, ascii: string) => indexOf(b, ascii) >= 0;

const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

/** Constant-time string compare (hash both sides so lengths match). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

export interface TrackMeta {
  title: string | null;
  cover: string | null;
}

/** Title + cover from Spotify's public oEmbed endpoint. null if the track doesn't resolve. */
export async function fetchOembed(trackId: string): Promise<TrackMeta | null> {
  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${trackId}`)}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, cf: { cacheTtl: 86400 } } as RequestInit);
    if (!r.ok) return null;
    const j = (await r.json()) as { title?: unknown; thumbnail_url?: unknown };
    const title = typeof j.title === "string" ? j.title.slice(0, 200) : null;
    const cover = typeof j.thumbnail_url === "string" && j.thumbnail_url.startsWith("https://") ? j.thumbnail_url : null;
    return { title, cover };
  } catch {
    return null;
  }
}

/** Decode an optional URL-encoded header; trimmed and length-capped. */
export function headerText(v: string | undefined, max = 200): string | null {
  if (!v) return null;
  let s = v;
  try {
    s = decodeURIComponent(v);
  } catch {
    /* keep raw */
  }
  s = s.trim().slice(0, max);
  return s || null;
}

/** Parse a single-range `Range` header against a known size. */
export function parseRange(h: string | null, size: number): { offset: number; length: number } | "invalid" | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { offset: start, length: end - start + 1 };
}
