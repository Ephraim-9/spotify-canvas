-- Loopboard schema. Times are unix seconds.

CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  provider    TEXT NOT NULL,              -- 'github' | 'google'
  provider_id TEXT NOT NULL,
  email       TEXT,                       -- verified email only
  name        TEXT,
  avatar      TEXT,
  trusted     INTEGER NOT NULL DEFAULT 0,
  banned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (provider, provider_id)
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,            -- sha256 of the cookie value
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE clips (
  id           INTEGER PRIMARY KEY,
  track_id     TEXT NOT NULL,
  v            INTEGER,                   -- assigned when approved
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','superseded','removed')),
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  title        TEXT,
  artist       TEXT,
  cover        TEXT,
  uploader_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL = admin token
  created_at   INTEGER NOT NULL,
  reviewed_at  INTEGER
);
CREATE INDEX clips_track_status ON clips(track_id, status);
CREATE INDEX clips_status ON clips(status);
CREATE INDEX clips_uploader ON clips(uploader_id, created_at);
-- At most one current clip per track.
CREATE UNIQUE INDEX clips_one_approved ON clips(track_id) WHERE status = 'approved';
CREATE UNIQUE INDEX clips_track_v ON clips(track_id, v) WHERE v IS NOT NULL;

CREATE TABLE reports (
  id         INTEGER PRIMARY KEY,
  clip_id    INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL CHECK (reason IN ('inappropriate','wrong_song','copyright','other')),
  note       TEXT,
  ip_hash    TEXT NOT NULL,               -- HMAC of the reporter IP, never the IP itself
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  created_at INTEGER NOT NULL
);
CREATE INDEX reports_status ON reports(status);
CREATE INDEX reports_ip ON reports(ip_hash, created_at);
