export interface Env {
  DB: D1Database;
  CLIPS: R2Bucket;
  ASSETS: Fetcher;

  // vars (wrangler.jsonc)
  SITE_NAME: string;
  CONTACT_EMAIL: string;
  ADMIN_EMAILS: string;

  // secrets (wrangler secret put / .dev.vars)
  ADMIN_TOKEN?: string;
  HASH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export interface User {
  id: number;
  provider: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  trusted: number;
  banned: number;
}

export interface Clip {
  id: number;
  track_id: string;
  v: number | null;
  status: "pending" | "approved" | "rejected" | "superseded" | "removed";
  r2_key: string;
  content_type: string;
  size: number;
  title: string | null;
  artist: string | null;
  cover: string | null;
  uploader_id: number | null;
  created_at: number;
  reviewed_at: number | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: User | null; isAdmin: boolean };
};
