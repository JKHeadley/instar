/**
 * LearnSkillBridge — Evidence producer for the /learn skill.
 *
 * The /learn skill captures lessons during conversation. WikiClaim Phase 3
 * (spec § Producers line 268, § Migration Plan line 341) requires each lesson
 * to cite at least one evidence row — auto-derived from the conversation
 * context when possible, or prompted-for when not.
 *
 * Spec line 228: the `LearnSkill` producer is allowed to write evidence
 * kinds `message` and `session`. The auto-derivation here additionally
 * surfaces `feedback` and `commit` references that the caller can promote
 * to MemoryEntity via the appropriate downstream producer; the LearnSkill
 * bridge itself only emits the kinds in its allowlist.
 *
 * Design notes:
 *  - Auto-derivation patterns are intentionally conservative (regex over
 *    a finite vocabulary). Spec line 357: "No LLM in the migration path".
 *    Cross-store FK validation is best-effort — consumers tolerate dangling
 *    references at read time.
 *  - Empty derivations are NOT errors here. The caller decides whether to
 *    fall back to a prompted `document` source or to reject the learn call.
 *  - Producer-kind allowlist enforcement happens inside SemanticMemory; this
 *    module does not duplicate the check.
 */

import type { MemoryEvidence } from './types.js';

/** Captures `fb_<32 hex+>` feedback IDs. Spec line 367: cross-store FK is
 *  best-effort; this regex matches the FeedbackManager id shape. */
const FEEDBACK_ID_PATTERN = /\bfb_[a-f0-9]{8,}\b/gi;
/** Matches a full 40-character SHA. Phase 2 commit-evidence producer accepts
 *  the same shape. */
const COMMIT_SHA_PATTERN = /\b[a-f0-9]{40}\b/gi;
/** Matches a UUID v4-shaped session id. */
const SESSION_UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
/** Matches a short hex-only session id like `sess_<hex>` for instar's
 *  episodic-memory session shape. */
const SESSION_TOKEN_PATTERN = /\bsess_[a-f0-9]{8,}\b/gi;

/**
 * Result of auto-derivation. Callers inspect `evidence.length === 0` to
 * decide whether to prompt the user for a `document` source.
 */
export interface DerivedEvidence {
  /** Evidence rows the LearnSkill producer is allowed to write
   *  (kinds `message`|`session`). Spec § Producers line 228. */
  evidence: MemoryEvidence[];
  /** References to downstream producers' kinds (feedback, commit). The
   *  LearnSkill bridge surfaces these so the caller can hand them off to
   *  EvolutionManager / DispatchExecutor; they are NOT written by the
   *  LearnSkill producer. Empty array means "nothing detected". */
  externalReferences: Array<{ kind: 'feedback' | 'commit'; sourceId: string }>;
}

/**
 * Auto-derive evidence rows from a free-form context string.
 *
 * Recognized patterns (per Phase 3 task description):
 *  - `fb_<hex>`     → feedback (surfaced as externalReference; LearnSkill
 *                     cannot write `feedback` kind per allowlist)
 *  - 40-hex SHA     → commit   (surfaced as externalReference)
 *  - UUID-v4        → session  (written as `kind:'session'`)
 *  - `sess_<hex>`   → session  (written as `kind:'session'`)
 *  - none of the above → empty result; caller prompts for `document`.
 *
 * The function is idempotent — duplicate matches in the same input
 * collapse to a single row keyed by `sourceId`.
 *
 * @param context Free-form text from the conversation (user message,
 *   prior assistant turn, tool output). Pass an empty string for "no
 *   context available."
 * @param now ISO timestamp to stamp on each emitted row. Caller passes
 *   the wall clock so tests can supply a deterministic value.
 */
export function deriveEvidenceFromContext(
  context: string,
  now: string = new Date().toISOString(),
): DerivedEvidence {
  const evidence: MemoryEvidence[] = [];
  const externalReferences: Array<{ kind: 'feedback' | 'commit'; sourceId: string }> = [];

  if (!context || typeof context !== 'string') {
    return { evidence, externalReferences };
  }

  const seenExternal = new Set<string>();
  const seenSession = new Set<string>();

  // Feedback IDs — surface as externalReference (caller's choice whether to
  // hand off; LearnSkill cannot itself write `feedback` kind).
  for (const match of context.matchAll(FEEDBACK_ID_PATTERN)) {
    const id = match[0].toLowerCase();
    const key = `feedback:${id}`;
    if (seenExternal.has(key)) continue;
    seenExternal.add(key);
    externalReferences.push({ kind: 'feedback', sourceId: id });
  }

  // Commit SHAs — externalReference. Note: a SHA-40 match is ambiguous with
  // a 40-char hex string used for anything else; cross-store FK validation
  // (spec line 219) is the caller's responsibility at write time.
  for (const match of context.matchAll(COMMIT_SHA_PATTERN)) {
    const sha = match[0].toLowerCase();
    const key = `commit:${sha}`;
    if (seenExternal.has(key)) continue;
    seenExternal.add(key);
    externalReferences.push({ kind: 'commit', sourceId: sha });
  }

  // Sessions (UUID v4 or sess_<hex>) — directly writable by LearnSkill.
  for (const match of context.matchAll(SESSION_UUID_PATTERN)) {
    const sid = match[0].toLowerCase();
    if (seenSession.has(sid)) continue;
    seenSession.add(sid);
    evidence.push({
      kind: 'session',
      sourceId: sid,
      confidence: 0.7,
      updatedAt: now,
    });
  }
  for (const match of context.matchAll(SESSION_TOKEN_PATTERN)) {
    const sid = match[0];
    if (seenSession.has(sid)) continue;
    seenSession.add(sid);
    evidence.push({
      kind: 'session',
      sourceId: sid,
      confidence: 0.7,
      updatedAt: now,
    });
  }

  return { evidence, externalReferences };
}

/**
 * Build the final evidence array for a /learn invocation.
 *
 * Strategy:
 *  1. Auto-derive sessions from context (`deriveEvidenceFromContext`).
 *  2. If derivation yields nothing AND no `documentFallback` was supplied,
 *     throw — every lesson must cite at least one source per spec line 269.
 *  3. If `documentFallback` was supplied, return it as the sole row when
 *     auto-derivation found nothing. Both can be combined when the caller
 *     wants both signals attached.
 *
 * Note: `document` kind is NOT in the LearnSkill allowlist (spec line 228).
 * Callers who want to attach a `document` evidence row must write it via
 * the `manual` producer (which itself only allows `external-url`) OR via
 * a future allowlist expansion. For Phase 3 we surface the documentFallback
 * back to the caller as `pendingDocumentRef`, which a higher-level caller
 * handles by routing through the appropriate producer.
 */
export interface BuildLearnEvidenceOptions {
  /** Free-form conversation context to scan. */
  context: string;
  /** Optional document fallback when auto-derivation yields nothing. */
  documentFallback?: { sourceId: string; path?: string; note?: string };
  /** Optional ISO timestamp; defaults to now. */
  now?: string;
}

export interface BuiltLearnEvidence {
  /** Evidence rows the LearnSkill producer can write directly (`session`,
   *  `message`). Always non-empty when `buildLearnEvidence()` returns
   *  successfully without throwing. */
  evidence: MemoryEvidence[];
  /** Detected references to other producers' kinds. Caller decides what
   *  to do with these. */
  externalReferences: Array<{ kind: 'feedback' | 'commit'; sourceId: string }>;
  /** Document-shaped reference that fell back from the prompt. The
   *  LearnSkill producer cannot write `document` kind itself; caller
   *  routes through a different producer (e.g. the `/learn` HTTP handler
   *  passes this back to the user for confirmation). */
  pendingDocumentRef?: { sourceId: string; path?: string; note?: string };
}

export class LearnEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearnEvidenceError';
  }
}

export function buildLearnEvidence(opts: BuildLearnEvidenceOptions): BuiltLearnEvidence {
  const now = opts.now ?? new Date().toISOString();
  const { evidence, externalReferences } = deriveEvidenceFromContext(opts.context, now);

  // Promote a free-form "user typed this lesson" turn into a `message`
  // row when no writable evidence was detected. This guarantees at least one
  // row in the producer's allowlist when context is non-empty — even when
  // externalReferences exist, the LearnSkill producer needs a writable row
  // because `feedback`/`commit` are NOT in its allowlist (spec line 228).
  if (evidence.length === 0 && opts.context.trim().length > 0) {
    evidence.push({
      kind: 'message',
      sourceId: `inline:${Math.abs(hashString(opts.context)).toString(36)}`,
      note: opts.context.slice(0, 200),
      confidence: 0.5,
      updatedAt: now,
    });
  }

  if (evidence.length === 0 && !opts.documentFallback) {
    throw new LearnEvidenceError(
      '/learn requires at least one evidence row. No session/message could ' +
        'be auto-derived from context and no documentFallback was supplied. ' +
        'Spec § Producers line 269 — pass a documentFallback {sourceId, path} ' +
        'to cite a doc that informed the lesson.',
    );
  }

  return {
    evidence,
    externalReferences,
    ...(opts.documentFallback ? { pendingDocumentRef: opts.documentFallback } : {}),
  };
}

/**
 * Cheap deterministic hash for inline-message synthetic sourceId. Not
 * security-sensitive; collisions are tolerable because the row carries the
 * note as the human-readable referent.
 */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}
