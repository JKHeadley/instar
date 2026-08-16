-- PR-gate eligibility schema — PR-REVIEW-HARDENING-SPEC Phase A.
-- Schema version 1. Do not edit in-place after shipping; bump version
-- and add a migration script instead.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Live eligibility records. Bounded at 10,000 rows (enforced by server,
-- not by schema). Records move to archive on PR close/merge.
CREATE TABLE IF NOT EXISTS live (
  pr_number              INTEGER NOT NULL,
  head_sha               TEXT NOT NULL,
  eligible               INTEGER NOT NULL,                 -- 0 or 1
  reason                 TEXT NOT NULL,                    -- structured reason code
  authorized_by_token_id TEXT NOT NULL,
  proof_bundle_path      TEXT NOT NULL,                    -- relative to upgrades/side-effects/pr/
  proof_bundle_sha256    TEXT NOT NULL,
  push_iteration         INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,                    -- ISO 8601 UTC
  expires_at             TEXT NOT NULL,                    -- ISO 8601 UTC; 24h from created_at
  PRIMARY KEY (pr_number, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_live_token ON live(authorized_by_token_id);
CREATE INDEX IF NOT EXISTS idx_live_expires ON live(expires_at);

-- Archive table — same shape as live plus archival metadata. 90-day
-- retention enforced by server (not schema).
CREATE TABLE IF NOT EXISTS archive (
  pr_number              INTEGER NOT NULL,
  head_sha               TEXT NOT NULL,
  eligible               INTEGER NOT NULL,
  reason                 TEXT NOT NULL,
  authorized_by_token_id TEXT NOT NULL,
  proof_bundle_path      TEXT NOT NULL,
  proof_bundle_sha256    TEXT NOT NULL,
  push_iteration         INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  archived_at            TEXT NOT NULL,
  archive_reason         TEXT NOT NULL,                    -- 'merged', 'closed', 'superseded'
  PRIMARY KEY (pr_number, head_sha, archived_at)
);

CREATE INDEX IF NOT EXISTS idx_archive_pr ON archive(pr_number);
CREATE INDEX IF NOT EXISTS idx_archive_token ON archive(authorized_by_token_id);

-- Revoked token registry. /pr-gate/status JOINs against this for O(1)
-- revocation checks. No full-table UPDATE on token revocation — write
-- token_id here and queries filter.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  token_id    TEXT PRIMARY KEY,
  revoked_at  TEXT NOT NULL,                               -- ISO 8601 UTC
  reason      TEXT NOT NULL,
  revoked_by  TEXT NOT NULL                                -- 'JKHeadley' or similar admin id
);
