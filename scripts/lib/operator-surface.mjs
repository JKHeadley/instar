/**
 * operator-surface.mjs — pure decision logic for the Operator-Surface Quality
 * review gate in the instar-dev commit gate (docs/STANDARDS-REGISTRY.md →
 * "Operator-Surface Quality", CMT-1434).
 *
 * Two pure predicates, extracted so the gate's load-bearing decisions are
 * unit-testable without git/fs mocking (the classify-tier.mjs pattern):
 *
 *   - isOperatorSurfaceFile(path): is this staged file an operator surface — a
 *     dashboard renderer/markup file, an approval page, or a grant/secret form?
 *   - artifactAddressesOperatorSurfaceQuality(content): does the side-effects
 *     artifact engage the operator-surface-quality question in writing?
 *
 * SIGNAL-FREE: these never block; the gate (instar-dev-precommit.js) reads them
 * and decides. Keeping them pure means both sides of every boundary are pinned
 * by tests (Testing Integrity → semantic-correctness).
 */

/**
 * An operator surface is anything a person uses to authorize, decide, or act:
 *   - dashboard renderer / markup files (dashboard/*.js, dashboard/*.html), AND
 *   - approval pages / one-time-approval links / secret-drop forms (a file whose
 *     basename starts with approval / operator-approval / secret-drop).
 * Build/test/spec siblings (*.test.js, *.spec.js) are NOT surfaces.
 */
export const OPERATOR_SURFACE_RE =
  /^dashboard\/.+\.(?:js|html)$|(?:^|\/)(?:approval|operator-approval|secret-drop)[^/]*\.(?:js|html|ts)$/i;

/**
 * True when a staged file path is an operator surface.
 * @param {string} file repo-relative path
 * @returns {boolean}
 */
export function isOperatorSurfaceFile(file) {
  const f = String(file ?? '');
  if (!f) return false;
  // A test/spec file that happens to live under dashboard/ or match the approval
  // basename is NOT itself an operator surface — it's a guard for one.
  if (/\.(?:test|spec)\.(?:js|ts|mjs)$/.test(f)) return false;
  return OPERATOR_SURFACE_RE.test(f);
}

/**
 * The artifact engages the operator-surface-quality question when it carries the
 * §6b heading/phrase (seeded by side-effects-artifact.md). The gate's job is to
 * ensure the question is structurally PRESENT for every operator-surface change —
 * an agent that deletes/skips the section (or writes a bespoke artifact omitting
 * it) is blocked. (Same strength as the framework-generality gate.)
 * @param {string} content the side-effects artifact text
 * @returns {boolean}
 */
export function artifactAddressesOperatorSurfaceQuality(content) {
  return /operator[- ]surface quality/i.test(String(content ?? ''));
}

/**
 * MECHANICAL content check (Part C arm 1 of ws52-operator-tap-not-text) — the
 * "Operators Act in Taps, Not Text" clause of Operator-Surface Quality.
 *
 * Upgrades the §6b gate from prose-attestation (does the artifact MENTION the
 * question) to a real inspection of the SURFACE FILE itself: does this operator
 * surface require the operator to paste raw/technical text — a JSON template in a
 * textarea, an input labelled for a fingerprint/token/base64/curl, or instruction
 * text telling the operator to paste/author such text? Operators act in taps; the
 * UI assembles structured data. A surface that needs raw technical input is
 * finished for an engineer, not its user.
 *
 * Allowlist (Structure > Willpower, with its own cap — see "guard bypass carries
 * its own cap"): a genuine power-user surface may opt out ONLY with an explicit,
 * co-located, reviewable marker — the token `operator-surface-power-user`
 * anywhere in the file (e.g. a `data-power-user-surface` attribute, or a comment
 * of the form "operator-surface-power-user: <reason>"). The marker is the
 * surface author asserting, on the record, "this is deliberately a power-user
 * surface and never the default operator path." (The constant/fixture dodge —
 * moving the JSON template into an imported constant the scanner can't see — is
 * documented out-of-scope and is backstopped by code review, not pretended
 * airtight; the gate catches the naive inline regression that actually shipped.)
 *
 * SIGNAL-FREE pure predicate: returns the finding; the gate decides.
 * @param {string} content the operator-surface file text
 * @returns {{ requiresRawInput: boolean, hasPowerUserMarker: boolean, reasons: string[] }}
 */
export function operatorSurfaceRequiresRawInput(content) {
  const text = String(content ?? '');
  const hasPowerUserMarker = /operator-surface-power-user|data-power-user-surface/i.test(text);
  const reasons = [];

  // 1. A JSON / authorities template offered to the operator as a placeholder or
  //    default value (the exact raw-JSON mandate-form regression, 2026-06-13).
  //    Look for a JSON-array/object literal of authority-shaped objects, or a
  //    placeholder/value attribute that carries one.
  if (/\[\s*\{\s*["']action["']\s*:/.test(text) || /["']authorities["']\s*:\s*\[/.test(text)) {
    reasons.push('offers a JSON authorities template for the operator to paste/edit');
  }
  if (/(?:placeholder|value|defaultValue)\s*=\s*["'][^"']*[[{][^"']*["']/.test(text)
      && /[[{]\s*["'][a-zA-Z]/.test(text)) {
    reasons.push('an input placeholder/default is a raw JSON/array template');
  }

  // 2. An input whose label/placeholder/aria-label asks for a raw technical value
  //    the operator would have to copy from elsewhere (fingerprint, token, id,
  //    base64, curl/CLI command, or "paste … JSON").
  const RAW_INPUT_LABEL =
    /(?:placeholder|aria-label|label|name)\s*=\s*["'][^"']*\b(?:fingerprint|base64|bearer token|curl|JSON blob|authorities JSON)\b[^"']*["']/i;
  if (RAW_INPUT_LABEL.test(text)) {
    reasons.push('an input is labelled for a raw technical value (fingerprint/token/base64/curl/JSON)');
  }

  // 3. Instruction text telling the operator to paste/author raw technical text.
  const PASTE_INSTRUCTION =
    /\b(?:paste|copy)\b[^.\n]{0,40}\b(?:this|the following|the)\b[^.\n]{0,30}\b(?:JSON|fingerprint|authorities|token|command|blob)\b/i;
  if (PASTE_INSTRUCTION.test(text)) {
    reasons.push('instructs the operator to paste/copy raw technical text');
  }

  return { requiresRawInput: reasons.length > 0, hasPowerUserMarker, reasons };
}

/**
 * Is this staged file an AUTHORIZATION/APPROVAL surface specifically — one where the
 * operator confers authority (a grant/mandate/approval form or its renderer)? A subset
 * of operator surfaces that additionally triggers the "Agent Proposes, Operator
 * Approves" question (the operator must be APPROVING, never AUTHORING; and the authority
 * text must be server-authored, not agent free-text).
 */
export const AUTHORIZATION_SURFACE_RE =
  /(?:^|\/)(?:mandates|grant|authorization-request|approval|operator-approval)[^/]*\.(?:js|html|ts)$/i;

export function isAuthorizationSurfaceFile(file) {
  const f = String(file ?? '');
  if (/\.(?:test|spec)\.(?:js|ts|mjs)$/i.test(f)) return false;
  return AUTHORIZATION_SURFACE_RE.test(f);
}

/**
 * The artifact engages the "Agent Proposes, Operator Approves" question when it carries
 * the phrase (seeded by side-effects-artifact.md). Same structural-presence strength as
 * the operator-surface-quality gate: an artifact touching an authorization surface that
 * omits the section is blocked. The standard's display-integrity corollary — the
 * authority text the operator approves must be server-authored, never agent free-text —
 * is what this question forces the author to confirm in writing.
 * @param {string} content the side-effects artifact text
 * @returns {boolean}
 */
export function artifactAddressesAgentProposesApproves(content) {
  return /agent[- ]proposes,? operator[- ]approves/i.test(String(content ?? ''));
}
