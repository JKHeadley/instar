// self-action-detect.mjs — the SINGLE shared detector for the
// `unbounded-self-action` defect class (docs/specs/self-action-convergence.md
// → Part E1). Dependency-free ESM, mirroring how the class-closure gate shares
// `class-closure-grader.mjs` as one library used by both the CI lint and the
// commit gate.
//
// It answers three questions, all deterministically (Signal vs. Authority — it
// FORCES a declaration, it never LLM-guesses):
//   1. Does an ADDED diff introduce/modify a self-action EMIT? (the trigger for
//      the class declaration requirement — emit-anchored, comment/prose-safe).
//   2. Is a file a self-action CONTROLLER source file? (the scope predicate the
//      CI lint + forcing lint use).
//   3. What is the raw verb-token set? (the single source the D3 ratchet's
//      registry `actionVerb`s must be a subset of — coherence test E5/D5).
//
// SAFETY ASYMMETRY (fail-OPEN on tooling failure — the E3/E2 gates rely on it):
// empty/blank added-diff text returns FALSE (no fire). A false-negative here is
// backstopped by the CI lint; a false-positive that blocked all commits would
// sever the developer's ability to ship. The obfuscation limit (a string-based
// detector cannot beat DELIBERATE evasion — `const v='swap'; self[v]()`) is the
// known gap named in the spec, tracked to the follow-on funnel (Part B).

// ── The self-action verb TOKENS ────────────────────────────────────────────
// Seeded from the synthesis taxonomy (restart|swap|respawn|spawn|notify|retry|
// re-drive|kill) and widened to the concrete instar symbols those verbs appear
// as. This is the SINGLE source: the emit regex is built from it, and the D3
// ratchet's registry `actionVerb`s are asserted to each contain one of these
// tokens (so a new controller can never register a verb the detector is blind
// to). Keep alphabetized-by-family for review.
export const SELF_ACTION_VERB_TOKENS = Object.freeze([
  // restart / respawn family
  'refresh', 'respawn', 'restart',
  // reap / kill family
  'reap', 'requestKill', 'kill',
  // swap family
  'swap', 'proactiveSwap',
  // spawn family
  'spawnSession', 'spawn',
  // notify / emit family
  'notify', 'createForumTopic', 'createAttentionItem', 'sendToTopic',
  // re-drive / re-pin family
  'reDrive', 'redrive', 'rePin', 'repin',
  // record-repair family (ownership-gated-spawn §3.2 — the reconciler's fenced CAS)
  'converge',
  // retry / nudge / escalate family
  'retry', 'nudge', 'escalate',
]);

// A call in an EMITTING position: `verb(` (a bare/qualified call) OR `.verb(`
// (a method call). A bare NOUN in a comment or prose line does not match
// because the line-level filter in addedDiffIntroducesSelfAction strips
// comment/prose lines before testing; the regex itself additionally requires a
// `(` so `// swap accounts` (no paren) never matches even if the filter is
// bypassed.
const CALL_VERBS = SELF_ACTION_VERB_TOKENS.join('|');
// Method-position verbs — the subset that commonly appears as `obj.verb(`.
const METHOD_VERBS = [
  'refresh', 'respawn', 'restart', 'swap', 'reap', 'kill', 'retry',
  'escalate', 'nudge', 'notify', 'spawn', 'redrive',
].join('|');

export const SELF_ACTION_EMIT = new RegExp(
  `\\b(${CALL_VERBS})\\s*\\(|\\.\\s*(${METHOD_VERBS})\\s*\\(`,
);

// ── Comment / prose line detection ─────────────────────────────────────────
// The added-diff text handed to us is already `+`-stripped by the precommit
// hook (or a raw file line, for the forcing lint). We skip lines that are
// obviously NOT an emitting statement — a comment, a markdown/prose line, an
// import, or a string-literal-only mention — before testing the emit regex.
function isNonEmitLine(line) {
  const t = line.trimStart();
  if (t === '') return true;
  // Line comments / block-comment continuations / hash comments.
  if (/^(\/\/|\*|\/\*|#)/.test(t)) return true;
  // Import / export-from lines mention symbols but do not call them.
  if (/^(import|export)\b/.test(t) && /\bfrom\b/.test(t)) return true;
  return false;
}

/**
 * Does the ADDED diff text introduce/modify a self-action emit? Emitting
 * position only — a bare noun in a comment/prose line does NOT match. Empty /
 * blank text → false (fail-open on a tooling hiccup).
 * @param {string} addedDiffText  concatenation of added lines (`+`-stripped)
 * @returns {boolean}
 */
export function addedDiffIntroducesSelfAction(addedDiffText) {
  if (typeof addedDiffText !== 'string' || addedDiffText.trim() === '') return false;
  for (const line of addedDiffText.split('\n')) {
    if (isNonEmitLine(line)) continue;
    if (SELF_ACTION_EMIT.test(line)) return true;
  }
  return false;
}

// ── Controller-source scope predicate ──────────────────────────────────────
// A `src/` file whose NAME matches the controller shape, OR any file that
// carries the `@self-action-controller` registration marker in its content.
const CONTROLLER_NAME =
  /(Monitor|Sentinel|Reaper|Beacon|Engine|Scheduler|Watchdog|Poller|Manager)\.ts$/;
const CONTROLLER_MARKER = /@self-action-controller\s*:/;

/**
 * Is `file` a self-action controller source file (for scope)?
 * @param {string} file  repo-relative path
 * @param {string} [contentMaybe]  optional file content, to catch the marker
 * @returns {boolean}
 */
export function isSelfActionControllerFile(file, contentMaybe) {
  const f = String(file ?? '');
  if (typeof contentMaybe === 'string' && CONTROLLER_MARKER.test(contentMaybe)) return true;
  if (!f.startsWith('src/')) return false;
  if (f.endsWith('.test.ts')) return false;
  const base = f.split('/').pop() ?? f;
  return CONTROLLER_NAME.test(base);
}

/**
 * Parse the `@self-action-controller: <id>` marker id out of file content, if
 * present. Returns the id string, or null. (Used by the forcing lint to
 * cross-check the marker id against the SELF_ACTION_CONTROLLERS registry.)
 * @param {string} content
 * @returns {string|null}
 */
export function selfActionControllerMarkerId(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(/@self-action-controller\s*:\s*([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export const SELF_ACTION_CLASS_ID = 'unbounded-self-action';

/**
 * The PURE decision behind the instar-dev pre-commit gate `assertSelfActionDeclared`
 * (Part E3). Extracted here so the decision is a tested function (Structure >
 * Willpower) that BOTH the enforceTier1 and Tier-2 call sites exercise via one
 * gate. FAIL-OPEN: no self-action emit, or no src/ file touched -> not required.
 * A declaration is satisfied by a real classClosure (guard|gap) OR an explicit
 * negative declaration (closure:'n/a' + reason).
 * @param {{ addedDiffText: string, inScopeFiles: string[], classClosure: any }} input
 * @returns {{ required: boolean, satisfied: boolean, reason: string }}
 */
export function selfActionDeclarationVerdict({ addedDiffText, inScopeFiles, classClosure }) {
  if (!addedDiffIntroducesSelfAction(addedDiffText)) {
    return { required: false, satisfied: true, reason: 'no self-action emit in added diff (fail-open)' };
  }
  const srcTouched = (inScopeFiles || []).some((f) => String(f).startsWith('src/'));
  if (!srcTouched) {
    return { required: false, satisfied: true, reason: 'no src/ file touched (false-positive-safe)' };
  }
  const cc = classClosure;
  const named = cc && typeof cc === 'object' && cc.defectClass === SELF_ACTION_CLASS_ID;
  const isRealDecl = Boolean(named && (cc.closure === 'guard' || cc.closure === 'gap'));
  const isNegative = Boolean(
    named && cc.closure === 'n/a' && typeof cc.reason === 'string' && cc.reason.trim().length > 0,
  );
  const satisfied = isRealDecl || isNegative;
  return {
    required: true,
    satisfied,
    reason: satisfied ? 'unbounded-self-action declared' : 'missing unbounded-self-action declaration',
  };
}
