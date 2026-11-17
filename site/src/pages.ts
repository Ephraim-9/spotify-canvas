import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Clip, Env, User } from "./env";
import { clipUrl } from "./clips";

type H = HtmlEscapedString | Promise<HtmlEscapedString>;

export const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "media-src 'self' blob:",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export interface PageCtx {
  env: Env;
  user: User | null;
  isAdmin: boolean;
  title?: string;
  description?: string;
}

const logo = raw(
  `<svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M10 9a7 7 0 1 0 0 14c5 0 7-14 12-14a7 7 0 1 1 0 14c-5 0-7-14-12-14z" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`,
);

export function layout(p: PageCtx, body: H): H {
  const site = p.env.SITE_NAME || "Loopboard";
  const title = p.title ? `${p.title} · ${site}` : site;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${p.description || `Community-made looping clips for Spotify tracks that have no Canvas.`}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="top">
  <a class="brand" href="/">${logo}<span>${site}</span></a>
  <nav>
    <a href="/">Gallery</a>
    <a href="/upload">Upload</a>
    ${p.isAdmin ? html`<a href="/admin">Moderate</a>` : ""}
    ${p.user
      ? html`<form method="post" action="/auth/logout" class="inline"><button class="link" title="Sign out ${p.user.name || ""}">Sign out</button></form>`
      : html`<a href="/login">Sign in</a>`}
  </nav>
</header>
<main>${body}</main>
<footer class="foot">
  <p>${site} is a community project. Not affiliated with, endorsed by or connected to Spotify. Track names and cover art belong to their owners.</p>
  <p>Takedown or copyright request? Use the Report button on a clip or email <a href="mailto:${p.env.CONTACT_EMAIL}">${p.env.CONTACT_EMAIL}</a>. · <a href="/privacy">Privacy</a></p>
</footer>
</body>
</html>`;
}

const spotifyLink = (id: string) => `https://open.spotify.com/track/${id}`;

function card(c: Clip): H {
  return html`<article class="card" data-search="${`${c.title || ""} ${c.artist || ""}`.toLowerCase()}">
  <a href="/t/${c.track_id}" class="thumb">
    <video class="lazy" muted loop playsinline preload="none" ${c.cover ? html`poster="${c.cover}"` : ""} data-src="${clipUrl(c)}"></video>
  </a>
  <div class="meta">
    ${c.cover ? html`<img src="${c.cover}" alt="" loading="lazy" width="40" height="40">` : ""}
    <div class="names">
      <a href="/t/${c.track_id}" class="title">${c.title || "Unknown track"}</a>
      <span class="artist">${c.artist || ""}</span>
    </div>
    <a class="ext" href="${spotifyLink(c.track_id)}" rel="noopener" target="_blank" title="Open in Spotify">↗</a>
  </div>
</article>`;
}

export function galleryPage(p: PageCtx, clips: Clip[], q: string, page: number, more: boolean): H {
  const qs = (n: number) => `/?${new URLSearchParams({ ...(q ? { q } : {}), page: String(n) })}`;
  return layout(
    p,
    html`<section class="hero">
  <h1>Looping clips for songs that have none</h1>
  <p>Short, silent loops made by the community for Spotify tracks without a Canvas. The desktop display picks them up automatically.</p>
  <form class="search" method="get" action="/">
    <input type="search" name="q" value="${q}" placeholder="Search title or artist" aria-label="Search title or artist" id="search">
    <button>Search</button>
  </form>
</section>
${clips.length
  ? html`<section class="grid">${clips.map(card)}</section>`
  : html`<p class="empty">${q ? "Nothing matches that search." : "No clips yet."} <a href="/upload">Upload one</a>.</p>`}
<nav class="pager">
  ${page > 1 ? html`<a href="${qs(page - 1)}">← Newer</a>` : ""}
  ${more ? html`<a href="${qs(page + 1)}">Older →</a>` : ""}
</nav>`,
  );
}

const REASONS: [string, string][] = [
  ["inappropriate", "Inappropriate"],
  ["wrong_song", "Wrong song"],
  ["copyright", "Copyright"],
  ["other", "Other"],
];

export function trackPage(p: PageCtx, trackId: string, clip: Clip | null): H {
  if (!clip) {
    return layout(
      { ...p, title: "No clip yet" },
      html`<section class="track empty">
  <h1>No clip for this track yet</h1>
  <p><a href="${spotifyLink(trackId)}" rel="noopener" target="_blank">Open the track in Spotify</a> · <a href="/upload?track=${trackId}">Upload a clip</a></p>
</section>`,
    );
  }
  return layout(
    { ...p, title: [clip.title, clip.artist].filter(Boolean).join(" – ") || "Clip" },
    html`<section class="track">
  <div class="stage"><video src="${clipUrl(clip)}" muted loop playsinline autoplay ${clip.cover ? html`poster="${clip.cover}"` : ""}></video></div>
  <div class="info">
    ${clip.cover ? html`<img class="cover" src="${clip.cover}" alt="" width="96" height="96">` : ""}
    <h1>${clip.title || "Unknown track"}</h1>
    <p class="artist">${clip.artist || ""}</p>
    <p><a class="btn" href="${spotifyLink(trackId)}" rel="noopener" target="_blank">Open in Spotify ↗</a></p>
    <details class="report">
      <summary>Report this clip</summary>
      <form id="report-form" data-clip="${clip.id}">
        <label>Reason
          <select name="reason" required>${REASONS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>
        </label>
        <label>Details (optional)<textarea name="note" maxlength="500" rows="3"></textarea></label>
        <button>Send report</button>
        <p class="status" role="status"></p>
      </form>
    </details>
  </div>
</section>`,
  );
}

export function loginPage(p: PageCtx): H {
  return layout(
    { ...p, title: "Sign in" },
    html`<section class="narrow">
  <h1>Sign in</h1>
  <p>Sign in to upload clips. We only keep your name, email and avatar from the provider.</p>
  <p class="stack">
    <a class="btn" href="/auth/github">Continue with GitHub</a>
    <a class="btn" href="/auth/google">Continue with Google</a>
  </p>
</section>`,
  );
}

export function uploadPage(p: PageCtx, mine: Clip[], prefill: string): H {
  if (!p.user) return loginPage(p);
  const statusLabel: Record<string, string> = {
    pending: "Waiting for review",
    approved: "Live",
    superseded: "Replaced by a newer clip",
    rejected: "Rejected",
    removed: "Removed",
  };
  return layout(
    { ...p, title: "Upload" },
    html`<section class="narrow">
  <h1>Upload a clip</h1>
  ${p.user.banned ? html`<p class="warn">Your account can't upload.</p>` : ""}
  <form id="upload-form" class="stack">
    <label>Spotify track link or URI
      <input name="track" required placeholder="https://open.spotify.com/track/…" value="${prefill}" autocomplete="off">
    </label>
    <div id="track-preview" class="preview" hidden></div>
    <label>Artist (optional)
      <input name="artist" maxlength="200" placeholder="Shown in the gallery">
    </label>
    <label>Video file: MP4 (H.264) or WebM, up to 15 MB and 30 seconds, no sound needed
      <input type="file" name="file" accept="video/mp4,video/webm" required>
    </label>
    <p class="hint">Vertical 9:16 looks best. Have a GIF? Convert it first: <code>ffmpeg -i in.gif -pix_fmt yuv420p -movflags +faststart out.mp4</code></p>
    <label class="check"><input type="checkbox" name="rights" required> I made this clip or have the right to share it.</label>
    <button ${p.user.banned ? "disabled" : ""}>Upload</button>
    <p class="status" role="status"></p>
  </form>
  <p class="hint">${p.user.trusted ? "You're a trusted uploader: clips go live straight away." : "New clips are checked by a moderator before they go live."}</p>
</section>
<section class="narrow">
  <h2>Your uploads</h2>
  ${mine.length
    ? html`<ul class="mine">${mine.map(
        (c) => html`<li>
      <a href="/t/${c.track_id}">${c.title || c.track_id}</a>
      <span class="badge ${c.status}">${statusLabel[c.status]}</span>
      ${c.status === "removed" || c.status === "rejected" ? "" : html`<button class="link danger" data-delete-upload="${c.id}">Delete</button>`}
    </li>`,
      )}</ul>`
    : html`<p class="empty">Nothing yet.</p>`}
</section>`,
  );
}

interface ReportRow {
  id: number;
  reason: string;
  note: string | null;
  created_at: number;
  clip_id: number;
  track_id: string;
  title: string | null;
  artist: string | null;
  clip_status: string;
}

const ago = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

export function adminPage(
  p: PageCtx,
  pending: (Clip & { uploader_name: string | null; uploader_email: string | null })[],
  reports: ReportRow[],
  users: User[],
  uq: string,
): H {
  return layout(
    { ...p, title: "Moderate" },
    html`<section>
  <h1>Pending uploads (${pending.length})</h1>
  ${pending.length ? "" : html`<p class="empty">Queue is empty.</p>`}
  <div class="mod-grid">
  ${pending.map(
    (c) => html`<article class="mod" id="clip-${c.id}">
    <video src="/admin/preview/${c.id}" muted loop playsinline controls preload="metadata"></video>
    <p><b>${c.title || "?"}</b> – ${c.artist || "?"}<br>
      <a href="https://open.spotify.com/track/${c.track_id}" rel="noopener" target="_blank">${c.track_id}</a><br>
      by ${c.uploader_name || "?"} (${c.uploader_email || "no email"}) · ${(c.size / 1048576).toFixed(1)} MB · ${ago(c.created_at)}</p>
    <p class="row">
      <button data-act="/api/admin/clips/${c.id}/approve">Approve</button>
      <button class="danger" data-act="/api/admin/clips/${c.id}/reject">Reject</button>
      ${c.uploader_id ? html`<button class="link" data-act="/api/admin/users/${c.uploader_id}" data-body='{"trusted":1}'>Trust uploader</button>` : ""}
    </p>
  </article>`,
  )}
  </div>
</section>
<section>
  <h1>Open reports (${reports.length})</h1>
  ${reports.length ? "" : html`<p class="empty">No open reports.</p>`}
  <div class="mod-grid">
  ${reports.map(
    (r) => html`<article class="mod" id="report-${r.id}">
    ${r.clip_status === "approved" || r.clip_status === "superseded"
      ? html`<video src="/admin/preview/${r.clip_id}" muted loop playsinline controls preload="metadata"></video>`
      : html`<p class="hint">Clip is ${r.clip_status}.</p>`}
    <p><b>${r.reason.replace("_", " ")}</b> · ${ago(r.created_at)}<br>${r.note || ""}</p>
    <p><a href="/t/${r.track_id}">${r.title || r.track_id}</a> – ${r.artist || ""}</p>
    <p class="row">
      <button data-act="/api/admin/reports/${r.id}/dismiss">Dismiss</button>
      <button class="danger" data-act="/api/admin/reports/${r.id}/remove">Remove clip</button>
    </p>
  </article>`,
  )}
  </div>
</section>
<section>
  <h1>Users</h1>
  <form method="get" action="/admin" class="search"><input type="search" name="u" value="${uq}" placeholder="Search name or email"><button>Find</button></form>
  <table class="users">
    <thead><tr><th>Name</th><th>Email</th><th>Via</th><th>Trusted</th><th>Banned</th></tr></thead>
    <tbody>
    ${users.map(
      (u) => html`<tr>
      <td>${u.name || ""}</td><td>${u.email || ""}</td><td>${u.provider}</td>
      <td><button class="link" data-act="/api/admin/users/${u.id}" data-body='{"trusted":${u.trusted ? 0 : 1}}'>${u.trusted ? "Yes – revoke" : "No – trust"}</button></td>
      <td><button class="link ${u.banned ? "" : "danger"}" data-act="/api/admin/users/${u.id}" data-body='{"banned":${u.banned ? 0 : 1}}'>${u.banned ? "Yes – unban" : "No – ban"}</button></td>
    </tr>`,
    )}
    </tbody>
  </table>
</section>`,
  );
}

export function privacyPage(p: PageCtx): H {
  return layout(
    { ...p, title: "Privacy" },
    html`<section class="narrow prose">
  <h1>Privacy</h1>
  <p>Plain version of what this site keeps.</p>
  <h2>If you sign in</h2>
  <p>Your name, verified email address and avatar URL from GitHub or Google, and a session record so you stay signed in (30 days). We never see your password.</p>
  <h2>If you upload</h2>
  <p>The video file, the track it's for, the title, artist and cover link, and which account uploaded it. You can delete your uploads from the upload page.</p>
  <h2>If you report a clip</h2>
  <p>The reason, your optional note, and a keyed hash of your IP address so one person can't flood reports. The IP itself is never stored or logged.</p>
  <h2>Desktop apps</h2>
  <p>The desktop display only downloads <code>/index.json</code> and the clips it lists. Those requests aren't recorded, and nothing about what you listen to is sent here.</p>
  <h2>Cookies</h2>
  <p>One sign-in cookie, plus a short-lived one during sign-in. No analytics, no ads, no trackers.</p>
  <h2>Contact</h2>
  <p>Questions or deletion requests: <a href="mailto:${p.env.CONTACT_EMAIL}">${p.env.CONTACT_EMAIL}</a>.</p>
</section>`,
  );
}

export function messagePage(p: PageCtx, title: string, msg: string): H {
  return layout({ ...p, title }, html`<section class="narrow"><h1>${title}</h1><p>${msg}</p></section>`);
}
