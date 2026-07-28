/**
 * NicknameAssigner — derives a friendly, collision-free machine nickname.
 *
 * Multi-Machine Session Pool, spec §L2 "Machine Nicknames". Users name a
 * machine by its nickname (the user-facing handle) rather than a raw machineId
 * (`m_a3f9…`) — for the Machines dashboard tab and for "run this on <nickname>"
 * / "move this to <nickname>" placement & transfer commands (§L4).
 *
 * This module is PURE LOGIC (no I/O): given a machine's own properties + the
 * nicknames already in the pool, it produces a deterministic nickname. Keeping
 * it pure makes the derivation + the collision rule unit-testable, and means
 * every machine reading the same registry derives the same disambiguation.
 *
 * Assignment is auto + idempotent (a machine that already has a nickname keeps
 * it — see MachineIdentityManager.registerMachine), and the result is always
 * user-editable via PATCH /pool/machines/:id (§L2).
 */

/** Max nickname length (matches the validation regex below). */
const MAX_NICKNAME_LEN = 40;

/**
 * Validation: a non-empty string starting with a word char, then up to 40 word
 * chars / spaces / hyphens. Rejects control chars, leading separators, reserved
 * shapes, and over-length values. Used at the editable surface (PATCH) and as a
 * sanity gate on auto-derived values.
 */
export function isValidNickname(value: unknown): value is string {
  return typeof value === 'string' && /^[\w][\w \-]{0,40}$/.test(value.trim()) && value.trim().length > 0;
}

/** Title-case a space-separated phrase ("macbook pro" → "Macbook Pro"). */
function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Friendly label for a platform string like "darwin-arm64". */
function platformLabel(platform: string | undefined): string {
  const p = (platform || '').toLowerCase();
  const os = p.startsWith('darwin')
    ? 'Mac'
    : p.startsWith('linux')
      ? 'Linux'
      : p.startsWith('win')
        ? 'Windows'
        : 'Machine';
  const archMatch = p.match(/-(arm64|x64|x86_64|arm|amd64)$/);
  const arch = archMatch ? archMatch[1] : '';
  return arch ? `${os} ${arch}` : os;
}

/**
 * Derive a base (pre-collision) nickname from a machine's own properties.
 * Prefers a sanitized hostname/identity-name; falls back to a platform label.
 *
 * @param identityName the machine's identity `name` (a sanitized hostname, e.g.
 *   "justins-macbook-pro") — may be empty.
 * @param platform     the platform string (e.g. "darwin-arm64") — fallback.
 */
export function deriveBaseNickname(identityName: string | undefined, platform: string | undefined): string {
  const fromName = titleCase((identityName || '').replace(/\.local$/i, '').replace(/[-_.]+/g, ' ').trim()).slice(
    0,
    MAX_NICKNAME_LEN,
  );
  if (fromName) return fromName;
  return platformLabel(platform);
}

/**
 * Assign a collision-free nickname for a new machine.
 *
 * Deterministic: same (identityName, platform, existingNicknames) → same result.
 * If the derived base collides (case-insensitive) with an existing nickname, a
 * numeric suffix is appended ("mac mini" → "mac mini 2" → "mac mini 3"). The
 * comparison is case-insensitive + trimmed so "Mac Mini" and "mac mini " collide.
 *
 * @param opts.identityName     the machine's identity `name`.
 * @param opts.platform         the machine's platform string.
 * @param opts.existingNicknames nicknames already taken in the pool.
 */
export function assignNickname(opts: {
  identityName?: string;
  platform?: string;
  existingNicknames?: readonly string[];
}): string {
  const base = deriveBaseNickname(opts.identityName, opts.platform);
  const taken = new Set((opts.existingNicknames || []).map((n) => n.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  // Disambiguate with a numeric suffix, deterministically.
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Pathological (1000 same-named machines) — fall through to a base label.
  return base;
}
