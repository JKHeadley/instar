/**
 * conversationBindToken — the §7 bind-time authority primitive (B7 / R3-M5 /
 * R4-M3, docs/specs/durable-conversation-identity.md).
 *
 * A durable-state BIND (`POST /commitments`, working-set carry) on a minted
 * conversation id must be scoped to the session's OWN authenticated bootstrap
 * context. The enforcement primitive is a per-session bind token minted at
 * session spawn and delivered ONLY through the spawned session's environment
 * (`INSTAR_BIND_TOKEN` in the tmux -e block) — never over a route.
 *
 * The token is SELF-AUTHENTICATING and validation is STATELESS (R4-M3):
 * sessions are tmux processes that OUTLIVE the server process, and the server
 * restarts on every auto-update — so the server stores nothing per-session.
 * It verifies the HMAC and reads the bootstrap set FROM the token; a live
 * session's token remains valid across any number of server restarts.
 *
 * Shape: `base64url(payload) + "." + base64url(HMAC-SHA256(secret, payload))`
 * where payload = { sessionName, bootstrapConversationIds, mintedAt }.
 *
 * The secret is a random 32-byte value generated once at first boot and
 * persisted in the stateDir (same at-rest posture as authToken — plaintext
 * machine-local; it authorizes only bind-scoping, never delivery or message
 * content). It is deliberately EXCLUDED from the backup manifest (R5-minor-4):
 * a disaster restore regenerates it, so all outstanding tokens invalidate —
 * live sessions then hit the loud typed refusal until respawned, never a
 * silent failure. Rotating it (delete the file, restart) is the revocation
 * story — a LOUD deliberate trade.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface BindTokenPayload {
  sessionName: string;
  bootstrapConversationIds: number[];
  mintedAt: string;
}

/** §7 R7-minor-2: the token-less positive-id straggler backstop window. */
export const TOKENLESS_BIND_GRACE_DAYS = 14;

const SECRET_RELATIVE_PATH = path.join('state', 'conversation-bind-token.secret');
const DEPLOY_STAMP_RELATIVE_PATH = path.join('state', 'conversation-registry-deploy.json');

/** Read-or-create the 32-byte bind-token secret (first-boot generation). */
export function ensureBindTokenSecret(stateDir: string): Buffer {
  const p = path.join(stateDir, SECRET_RELATIVE_PATH);
  try {
    const existing = fs.readFileSync(p);
    if (existing.length >= 32) return existing;
  } catch {
    /* falls through to generation */
  }
  const secret = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, secret, { mode: 0o600 });
  return secret;
}

export function mintBindToken(secret: Buffer, payload: BindTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/**
 * Verify a token. Returns the CLAMPED payload on a valid MAC, null otherwise
 * (missing/tampered/undecodable — the caller maps null to the typed
 * `conversation-bind-not-authorized` refusal, fail-closed on minted-id binds).
 */
export function verifyBindToken(secret: Buffer, token: string): BindTokenPayload | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const idx = token.indexOf('.');
  if (idx <= 0 || idx === token.length - 1) return null;
  const body = token.slice(0, idx);
  const givenMac = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(givenMac, 'base64url');
  } catch {
    // @silent-fallback-ok — a non-decodable MAC is an INVALID token; returning
    // null is the fail-CLOSED security contract (the caller refuses the bind),
    // not a degraded-service fallback.
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as BindTokenPayload;
    if (
      !parsed ||
      typeof parsed.sessionName !== 'string' ||
      !Array.isArray(parsed.bootstrapConversationIds) ||
      typeof parsed.mintedAt !== 'string'
    ) {
      return null;
    }
    return {
      sessionName: parsed.sessionName.slice(0, 128),
      bootstrapConversationIds: parsed.bootstrapConversationIds.filter(
        (n): n is number => typeof n === 'number' && Number.isSafeInteger(n),
      ),
      mintedAt: parsed.mintedAt.slice(0, 64),
    };
  } catch {
    return null;
  }
}

/**
 * Write the per-feature deploy stamp on first boot (idempotent — the house
 * per-feature deploy-stamp shape, R8-low-3). The stamp anchors the
 * `tokenlessBindGraceDays` clock for the R7-minor-2 straggler backstop.
 */
export function ensureBindDeployStamp(stateDir: string, version: string): void {
  const p = path.join(stateDir, DEPLOY_STAMP_RELATIVE_PATH);
  if (fs.existsSync(p)) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ firstBootVersion: version, at: new Date().toISOString() }, null, 2));
  } catch {
    /* @silent-fallback-ok — the stamp only arms the fail-OPEN straggler
       attention backstop; a missed write means the backstop stays unarmed
       (today's behavior), never a refused bind. */
  }
}

/** Age of the deploy stamp in whole days, or null when unstamped/unreadable. */
export function bindDeployStampAgeDays(stateDir: string, now: () => number = Date.now): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, DEPLOY_STAMP_RELATIVE_PATH), 'utf-8')) as { at?: string };
    const at = raw?.at ? Date.parse(raw.at) : NaN;
    if (!Number.isFinite(at)) return null;
    return Math.floor((now() - at) / 86400000);
  } catch {
    // @silent-fallback-ok — an unreadable/absent deploy stamp reads as "no age"
    // (null), so the R7-minor-2 straggler backstop simply stays UNARMED (today's
    // fail-open behavior) — never a refused bind, never a degraded service path.
    return null;
  }
}

/** The ctx surface the routes-layer bind gate consumes (wired at bootstrap;
 *  AgentServer default-constructs it so the gate is alive on every init path).
 *  `mint` is the SessionManager spawn-env side (INSTAR_BIND_TOKEN); `verify` +
 *  `deployStampAgeDays` are the POST /commitments gate side — one shared
 *  secret backs both. */
export interface ConversationBindAuth {
  mint: (sessionName: string, bootstrapConversationIds: number[]) => string;
  verify: (token: string) => BindTokenPayload | null;
  deployStampAgeDays: () => number | null;
}

export function createConversationBindAuth(stateDir: string): ConversationBindAuth {
  const secret = ensureBindTokenSecret(stateDir);
  return {
    mint: (sessionName, bootstrapConversationIds) =>
      mintBindToken(secret, { sessionName, bootstrapConversationIds, mintedAt: new Date().toISOString() }),
    verify: (token) => verifyBindToken(secret, token),
    deployStampAgeDays: () => bindDeployStampAgeDays(stateDir),
  };
}
