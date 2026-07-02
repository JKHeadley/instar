/**
 * Test-Identity Refusal (silent-loss-refusal-conservation §2.D — "Test Identity
 * Never Enters Production State"). The 2026-07-01 silent-loss incident began 19
 * days earlier when a live-test / harness run clobbered a machine's `users.json`
 * with FIXTURE identities. A registry populated with only fixtures rejects every
 * real sender (including the operator) once sender re-validation arms.
 *
 * This module is the single source of truth for WHICH identities are fixtures
 * and HOW a legitimate name-collision is overridden. It is pure + dependency-free
 * so both the write-path guard (UserManager.validateProfile — typed throw) and the
 * load-path guard (UserManager.loadUsers — refuse-and-skip, never throw) and the
 * §4 boot remediation share ONE matcher and can never drift.
 *
 * MATCH RULE (round-2 adversarial #10): exact match on the known fixture platform
 * IDS + reserved-token anchored prefixes on ids — DISPLAY NAME IS NEVER A MATCH
 * CRITERION (a real user named "Olivia" registers fine). See §2.D / decision 3.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { UserProfile } from '../core/types.js';

/**
 * The closed fixture-identity set. IDS + reserved tokens only — never a
 * display-name. Exact-match on the known platform ids; anchored-prefix match on
 * the reserved `livetest`/`g3test` tokens.
 *
 * - `slackIds`   — the demo Slack workspace user ids used by the live-test harness.
 * - `harnessIds` — the `u-*` / `U_*` fixture user ids the integration harness writes.
 * - `reservedTokenPrefixes` — anchored id/username prefixes the isolated test-home
 *   scaffold uses (`livetest…`, `g3test…`).
 */
export const TEST_IDENTITY_MARKERS = {
  slackIds: ['U0BA7QGPBQS', 'U0BA5NW9QA2', 'U0B9SFJ7QAK', 'U0B9SFV2BAT', 'U0BA4L8RMFF'] as const,
  harnessIds: [
    'u-olivia', 'u-adam', 'u-mia', 'u-cory', 'u-oscar',
    'U_OLIVIA', 'U_ADAM', 'U_MIA', 'U_CORY', 'U_OSCAR',
  ] as const,
  reservedTokenPrefixes: ['livetest', 'g3test'] as const,
} as const;

const EXACT_IDS: ReadonlySet<string> = new Set<string>([
  ...TEST_IDENTITY_MARKERS.slackIds,
  ...TEST_IDENTITY_MARKERS.harnessIds,
]);

/**
 * Does a single string token match a fixture marker? Exact match against the
 * known-id set, OR an anchored (^) reserved-token prefix. Case-sensitive on the
 * exact set (platform ids are case-significant); the reserved-token prefix is
 * matched case-INsensitively (a `LiveTest…` id is still a fixture).
 */
export function matchesTestIdentityToken(token: string | undefined | null): string | null {
  if (typeof token !== 'string' || !token) return null;
  if (EXACT_IDS.has(token)) return token;
  const lower = token.toLowerCase();
  for (const prefix of TEST_IDENTITY_MARKERS.reservedTokenPrefixes) {
    if (lower.startsWith(prefix)) return token;
  }
  return null;
}

/**
 * Classify a profile against the fixture-identity set. Checks the id, the Slack
 * user id, and slack-typed channel identifiers — NEVER the display name.
 * Returns the matched marker string (for the audit + the allow-marker) or null.
 */
export function matchTestIdentity(profile: Pick<UserProfile, 'id' | 'slackUserId' | 'channels'>): string | null {
  const idMatch = matchesTestIdentityToken(profile.id);
  if (idMatch) return idMatch;
  const slackMatch = matchesTestIdentityToken(profile.slackUserId ?? null);
  if (slackMatch) return slackMatch;
  if (Array.isArray(profile.channels)) {
    for (const ch of profile.channels) {
      if (ch && ch.type === 'slack') {
        const chMatch = matchesTestIdentityToken(ch.identifier);
        if (chMatch) return chMatch;
      }
    }
  }
  return null;
}

/** Typed error thrown by the WRITE path (validateProfile) when a fixture identity
 *  is written without a verifying allow-marker + the double-keyed test escape. */
export class TestIdentityRefusedError extends Error {
  readonly marker: string;
  constructor(profileId: string, marker: string) {
    super(
      `Refusing to persist test/fixture identity "${profileId}" (matched marker "${marker}") into the production user registry ` +
      `— "Test Identity Never Enters Production State" (silent-loss-refusal-conservation §2.D). ` +
      `A legitimate name-collision uses the dashboard-PIN-authed X-Instar-Allow-Identity override; ` +
      `an isolated test home sets INSTAR_ALLOW_TEST_IDENTITIES=1 plus the on-disk test-home marker.`,
    );
    this.name = 'TestIdentityRefusedError';
    this.marker = marker;
  }
}

// ── Double-keyed test escape (env + on-disk test-home marker) ────────────────

/** The on-disk marker a test home's scaffold writes to opt that home into
 *  fixture-identity writes. Its PRESENCE is the second key; contents are ignored. */
export const TEST_HOME_MARKER_FILENAME = '.instar-test-home';

/**
 * The narrow escape is double-keyed (§2.D / decision 11): the env var
 * `INSTAR_ALLOW_TEST_IDENTITIES=1` is honored ONLY when an on-disk test-home
 * marker is ALSO present under the state dir. Env-set-but-marker-absent → refuse
 * (a stray env var on a production box can never open the door).
 */
export function testIdentitiesAllowed(stateDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.INSTAR_ALLOW_TEST_IDENTITIES !== '1') return false;
  try {
    return fs.existsSync(path.join(stateDir, TEST_HOME_MARKER_FILENAME));
  } catch {
    return false;
  }
}

// ── Signed allow-marker (dashboard-PIN-minted, load-verifiable) ──────────────

/**
 * A profile that legitimately collides with a fixture marker carries a signed
 * allow-marker `{ marker, sig }`. The PIN gates MINTING (the route); the LOAD
 * path VERIFIES the HMAC with no PIN. `sig = HMAC-SHA256(serverKey, userId + ":" + marker)`
 * where `serverKey` is a server-held vault secret loaded only by the server
 * process — NOT the authToken/dashboardPin, NOT a state-dir file a plain
 * users.json writer reads (§2.D / decision 23, honest threat model).
 */
export interface AllowTestIdentityMarker {
  marker: string;
  sig: string;
}

function allowMarkerMessage(userId: string, marker: string): string {
  return `${userId}:${marker}`;
}

/**
 * Derive the server-held allow-marker HMAC key from the machine SIGNING key PEM
 * — a server-held secret loaded only by the server process, NOT the
 * authToken/dashboardPin and NOT users.json (§2.D / decision 23, honest scope:
 * a fully-FS-privileged process is out of scope). Returns undefined when no
 * signing key exists (a single-machine non-mesh install) — then a fixture
 * override can be neither minted nor verified (the safe direction). The raw PEM
 * is never used directly; the key is a domain-separated hash of it.
 */
export function loadTestIdentityKey(stateDir: string): string | undefined {
  for (const name of ['signing-key.pem', 'signing-private.pem']) {
    try {
      const pem = fs.readFileSync(path.join(stateDir, 'machine', name), 'utf-8');
      if (pem && pem.trim()) {
        return crypto.createHash('sha256').update(`instar-test-identity-allow:${pem}`).digest('hex');
      }
    } catch { /* try next / none */ }
  }
  return undefined;
}

/** Mint the HMAC signature for a legitimate fixture-collision override. */
export function signAllowTestIdentity(serverKey: string, userId: string, marker: string): string {
  return crypto.createHmac('sha256', serverKey).update(allowMarkerMessage(userId, marker)).digest('hex');
}

/**
 * Verify a profile's signed allow-marker on the LOAD path (no PIN present).
 * Constant-time compare. Returns true iff the profile carries an
 * `allowTestIdentity` whose `marker` equals the matched marker AND whose `sig`
 * recomputes under the server key. A missing/bogus sig → false → quarantine.
 */
export function verifyAllowTestIdentity(
  serverKey: string | undefined | null,
  userId: string,
  matchedMarker: string,
  allow: AllowTestIdentityMarker | undefined | null,
): boolean {
  if (!serverKey) return false;
  if (!allow || typeof allow.marker !== 'string' || typeof allow.sig !== 'string') return false;
  if (allow.marker !== matchedMarker) return false;
  const expected = signAllowTestIdentity(serverKey, userId, matchedMarker);
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(allow.sig, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
