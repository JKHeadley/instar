/**
 * Key material the agent must never serve, back up, list or commit
 * (docs/specs/a2a-single-agent-identity.md §5).
 *
 * ONE list, four consumers — the file routes' code-owned never-served deny
 * (`src/server/fileRoutes.ts`), the backup exclusions (`BackupManager`), the
 * gitignore entries written at init and by the post-update migrator, and the
 * git-sync secret classifier (`FileClassifier`). Each consumer derives its own
 * spelling from THIS list so the four can never drift apart: a path added here
 * is refused, excluded, ignored and classified in the same commit, and the
 * behavioural walk test (tests/integration/file-routes-never-served-walk.test.ts)
 * fails the build when a real init + pair produces a key-bearing file that is
 * not covered.
 *
 * Every entry is a PATH PREFIX relative to the agent's state dir (`.instar/`).
 * A prefix without a trailing slash matches the file AND its siblings that
 * share the prefix — `identity.json` covers the single writer's temp names
 * (`identity.json.<pid>.<rand>.tmp`) and the renamed-aside
 * `identity.json.superseded-*` / `identity.json.invalid-*` copies, which carry
 * the same private key. A prefix WITH a trailing slash is a directory.
 *
 * Exact-path access control, not a meaning filter: Signal vs. Authority does
 * not apply to an enumerated floor, and no config key can loosen it
 * (`PATCH /api/files/config` only narrows `allowedPaths`; this list is consulted
 * before and after it). Only the KEY files under `threadline/` are listed —
 * `conversations.json`, `trust-profiles.json` and thread history are the
 * operator's own audit surfaces and stay servable.
 */
export const KEY_MATERIAL_PATHS: readonly string[] = Object.freeze([
  // The agent identity (routing private key). Covers `.superseded-*` /
  // `.invalid-*` siblings and the owner-only writer's temp names.
  'identity.json',
  // Legacy routing identity mirror — the same private key in the old location.
  'threadline/identity.json',
  // Listener inbox HMAC key (operator-provisioned; the daemon reads it).
  'threadline/inbox-hmac.key',
  // Invitation-token HMAC secret.
  'threadline/invitation-secret.key',
  // Signed-invitation redemption/revocation state (token material inside).
  'threadline/secure-invitations.json',
  // Instar's dedicated SSH client/host key pairs (never ~/.ssh).
  'machine-ssh/',
  // Inbound-delivery observer HMAC key.
  'state/inbound-delivery.hmac-key',
  // Relay session tokens handed out by handshakes.
  'relay-tokens.json',
  // Headless worktree key vault (`local-state/keys.enc`) and its siblings.
  'local-state/',
  // Telegram-origin session credentials (`origin-sessions-<id>`): already in
  // ORIGIN_LOCAL_PREFIXES for gitignore + backup; listed here so the file
  // routes refuse it by the same list.
  'origin-sessions-',
  // Conversation-bind token secret (32-byte HMAC key).
  'state/conversation-bind-token.secret',
  // Manifest-integrity signing secret (`.instar/state/.manifest-key`,
  // generated at init, 0600). Found by the §5.4 walk: a key the parent lists
  // never named.
  'state/.manifest-key',
  // The machine's own signing/encryption keys + pairing session. Already
  // never-served, gitignored and never-sync through IDENTITY_AUTO_ACCEPT_
  // PROTECTED_PATHS and the scaffold; listed here because BackupManager only
  // refused the bare `machine/` ENTRY (basename equality) — an includeFiles
  // entry naming `machine/signing-key.pem` directly was copied. Found by the
  // §5.4 walk.
  'machine/',
  // Remediation key vault's env-passphrase flatfile backend
  // (`RemediationKeyVault`, AES-256-GCM, 0600). Same class as the headless
  // key vault above. Found by the second-pass review of §5.4.
  'remediation-keys.age',
  // Telemetry HMAC secret (`TelemetryAuth`, 32 random bytes, 0600). The
  // install-id beside it is a bare UUID, not key material, and stays servable.
  // Found by the second-pass review of §5.4.
  'telemetry/local-secret',
]);

/**
 * Concrete key FILES (not directories) whose inode a hard link elsewhere could
 * carry under an innocent name. `read`/`download` compare the opened
 * descriptor's device+inode against each of these when the descriptor
 * reports `nlink > 1` (§5.2). stateDir-relative; the machine identity keys
 * (already never-served through `.instar/machine/`) are included because a
 * hard link to them escapes every prefix check just the same.
 */
export const KEY_MATERIAL_FILES: readonly string[] = Object.freeze([
  'identity.json',
  'threadline/identity.json',
  'threadline/inbox-hmac.key',
  'threadline/invitation-secret.key',
  'threadline/secure-invitations.json',
  'state/inbound-delivery.hmac-key',
  'relay-tokens.json',
  'local-state/keys.enc',
  'state/conversation-bind-token.secret',
  'state/.manifest-key',
  'machine/signing-key.pem',
  'machine/encryption-key.pem',
  'machine/secrets-master.key',
  'secrets/passkeys/store.enc',
  'remediation-keys.age',
  'telemetry/local-secret',
  'config.json',
]);

/**
 * Directories whose key files carry GENERATED names a static list cannot
 * enumerate (`machine-ssh/<kind>-ed25519-g<N>`), plus the stateDir-root name
 * prefix of the origin-session credential files (`origin-sessions-<digest>`).
 * The hard-link check (§5.2) lists these at request time — only on the rare
 * `nlink > 1` path — so a hard link to a generation-named key is caught too.
 */
export const KEY_MATERIAL_DYNAMIC_DIRS: readonly string[] = Object.freeze(['machine-ssh/']);
export const KEY_MATERIAL_ROOT_NAME_PREFIXES: readonly string[] = Object.freeze(['origin-sessions-']);

/** The project-relative spelling the file routes match (`.instar/<prefix>`). */
export const KEY_MATERIAL_NEVER_SERVED_PREFIXES: readonly string[] = Object.freeze(
  KEY_MATERIAL_PATHS.map((p) => `.instar/${p}`),
);

/**
 * Both spellings BackupManager's prefix set uses: `includeFiles` entries
 * resolve relative to stateDir (`identity.json`), while callers may also
 * express the project-relative form (`.instar/identity.json`).
 */
export const KEY_MATERIAL_BACKUP_PREFIXES: readonly string[] = Object.freeze([
  ...KEY_MATERIAL_PATHS,
  ...KEY_MATERIAL_PATHS.map((p) => `.instar/${p}`),
]);

/**
 * Gitignore entries for the agent's INTERNAL state repo (`.instar/.gitignore`,
 * stateDir-relative). A directory prefix is written as-is; a file prefix gets
 * a trailing `*` so the writer's temp names and renamed-aside siblings are
 * ignored too (the same convention as ORIGIN_LOCAL_GITIGNORE).
 */
export const KEY_MATERIAL_GITIGNORE_STATE: readonly string[] = Object.freeze(
  KEY_MATERIAL_PATHS.map((p) => (p.endsWith('/') ? p : `${p}*`)),
);

/** Gitignore entries for the PROJECT repo (`<projectDir>/.gitignore`). */
export const KEY_MATERIAL_GITIGNORE_PROJECT: readonly string[] = Object.freeze(
  KEY_MATERIAL_GITIGNORE_STATE.map((p) => `.instar/${p}`),
);

/**
 * FileClassifier secret patterns. The classifier matches a `dir/` pattern as a
 * prefix and a `*`-bearing pattern as an anchored glob over the relative path,
 * so a file prefix is written `.instar/<file>*` to cover its siblings (the
 * parent list carried `.instar/identity.json` as an EXACT match, which left
 * `identity.json.superseded-*` syncable).
 */
export const KEY_MATERIAL_SECRET_PATTERNS: readonly string[] = Object.freeze(
  KEY_MATERIAL_PATHS.map((p) => (p.endsWith('/') ? `.instar/${p}` : `.instar/${p}*`)),
);
