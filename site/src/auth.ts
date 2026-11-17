import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, Env, User } from "./env";
import { now, pkceChallenge, randomToken, safeEqual, sha256Hex } from "./lib";

export const SESSION_COOKIE = "__Host-sid";
const OAUTH_COOKIE = "__Host-oauth";
const SESSION_TTL = 30 * 24 * 3600;
const COOKIE_BASE = { path: "/", httpOnly: true, secure: true, sameSite: "Lax" } as const;

export async function createSession(env: Env, userId: number): Promise<string> {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(userId, now()),
    env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").bind(
      await sha256Hex(token),
      userId,
      now() + SESSION_TTL,
    ),
  ]);
  return token;
}

export async function userFromCookie(env: Env, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.provider, u.email, u.name, u.avatar, u.trusted, u.banned
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(await sha256Hex(token), now())
    .first<User>();
}

export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export async function bearerIsAdmin(env: Env, header: string | undefined): Promise<boolean> {
  if (!env.ADMIN_TOKEN || !header?.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7), env.ADMIN_TOKEN);
}

/** Resolve the current user (cookie) and admin status (cookie email or bearer token). */
export async function loadIdentity(c: Context<AppEnv>) {
  const user = await userFromCookie(c.env, getCookie(c, SESSION_COOKIE));
  const byEmail = !!user?.email && adminEmails(c.env).includes(user.email.toLowerCase());
  const byToken = await bearerIsAdmin(c.env, c.req.header("authorization"));
  c.set("user", user);
  c.set("isAdmin", byEmail || byToken);
  return { byToken };
}

// ---- OAuth ----

interface Profile {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
}

interface Provider {
  authorize: string;
  token: string;
  scope: string;
  clientId: (e: Env) => string | undefined;
  clientSecret: (e: Env) => string | undefined;
  profile: (accessToken: string) => Promise<Profile>;
}

const UA = "loopboard-site";

const providers: Record<string, Provider> = {
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    clientId: (e) => e.GITHUB_CLIENT_ID,
    clientSecret: (e) => e.GITHUB_CLIENT_SECRET,
    async profile(at) {
      const h = { authorization: `Bearer ${at}`, "user-agent": UA, accept: "application/vnd.github+json" };
      const u = (await (await fetch("https://api.github.com/user", { headers: h })).json()) as {
        id: number;
        login: string;
        name: string | null;
        avatar_url: string | null;
      };
      let email: string | null = null;
      const er = await fetch("https://api.github.com/user/emails", { headers: h });
      if (er.ok) {
        const list = (await er.json()) as { email: string; primary: boolean; verified: boolean }[];
        email = list.find((e) => e.primary && e.verified)?.email ?? null;
      }
      if (!u?.id) throw new Error("github profile");
      return { id: String(u.id), email, name: u.name || u.login, avatar: u.avatar_url };
    },
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    clientId: (e) => e.GOOGLE_CLIENT_ID,
    clientSecret: (e) => e.GOOGLE_CLIENT_SECRET,
    async profile(at) {
      const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${at}` },
      });
      const u = (await r.json()) as { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
      if (!u?.sub) throw new Error("google profile");
      return {
        id: u.sub,
        email: u.email_verified ? (u.email ?? null) : null,
        name: u.name ?? null,
        avatar: u.picture ?? null,
      };
    },
  },
};

const callbackUrl = (c: Context<AppEnv>, p: string) => `${new URL(c.req.url).origin}/auth/${p}/callback`;

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/auth/:provider", async (c) => {
  const name = c.req.param("provider");
  const p = providers[name];
  const clientId = p?.clientId(c.env);
  if (!p) return c.notFound();
  if (!clientId) return c.text(`${name} sign-in is not configured`, 503);
  const state = randomToken(16);
  const verifier = randomToken(32);
  setCookie(c, OAUTH_COOKIE, `${name}.${state}.${verifier}`, { ...COOKIE_BASE, maxAge: 600 });
  const u = new URL(p.authorize);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(c, name),
    response_type: "code",
    scope: p.scope,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return c.redirect(u.toString(), 302);
});

authRoutes.get("/auth/:provider/callback", async (c) => {
  const name = c.req.param("provider");
  const p = providers[name];
  if (!p) return c.notFound();
  const [cName, cState, verifier] = (getCookie(c, OAUTH_COOKIE) || "").split(".");
  deleteCookie(c, OAUTH_COOKIE, COOKIE_BASE);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state || cName !== name || !cState || !verifier || !(await safeEqual(state, cState))) {
    return c.text("Sign-in failed: invalid or expired state. Please try again.", 400);
  }
  const tr = await fetch(p.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": UA },
    body: new URLSearchParams({
      client_id: p.clientId(c.env) || "",
      client_secret: p.clientSecret(c.env) || "",
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(c, name),
    }),
  });
  const tok = (await tr.json().catch(() => ({}))) as { access_token?: string };
  if (!tr.ok || !tok.access_token) return c.text("Sign-in failed: could not exchange code.", 400);

  let prof: Profile;
  try {
    prof = await p.profile(tok.access_token);
  } catch {
    return c.text("Sign-in failed: could not read profile.", 400);
  }
  const user = await c.env.DB.prepare(
    `INSERT INTO users (provider, provider_id, email, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, provider_id) DO UPDATE SET email = excluded.email, name = excluded.name, avatar = excluded.avatar
     RETURNING id`,
  )
    .bind(name, prof.id, prof.email, prof.name?.slice(0, 100) ?? null, prof.avatar, now())
    .first<{ id: number }>();
  const token = await createSession(c.env, user!.id);
  setCookie(c, SESSION_COOKIE, token, { ...COOKIE_BASE, maxAge: SESSION_TTL });
  return c.redirect("/upload", 302);
});

authRoutes.post("/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, COOKIE_BASE);
  return c.redirect("/", 303);
});
