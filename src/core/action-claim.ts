/**
 * action-claim — deterministic classifier for the Action-Claim Follow-Through
 * Sentinel (spec: docs/specs/action-claim-followthrough-sentinel.md).
 *
 * Detects when an outbound message makes a CONCRETE, checkable FUTURE-action claim
 * ("I'll restart it", "relaunching now", "pushing the change") so a follow-through
 * commitment can be registered. Mirrors `time-claim.ts`'s shape: pure, total,
 * first-person scoped, quote-skipping.
 *
 * HIGH PRECISION / FAIL TOWARD NOT-REGISTERING (FD2): unlike time-claim (where a
 * missed claim is a safe under-block), a false action-claim is a durable NAGGING
 * commitment. So we trigger ONLY on a CLOSED set of concrete action verbs, in
 * first-person near-future or present-progressive — never bare "I'll"/"now"/vague
 * "look into". On any ambiguity → not a claim.
 *
 * PAST TENSE is NOT a future-action claim (FD4): "relaunched"/"pushed" is the
 * descoped A2 (completed-action) class — this classifier returns false for it.
 */

export interface ActionClaim {
  /** The concrete action verb, normalized to its canonical lemma (the dedupe anchor). */
  normalizedClaimVerb: string;
  /** The raw matched phrase (for audit). */
  matched: string;
}

export interface ActionClaimResult {
  isActionClaim: boolean;
  claim?: ActionClaim;
}

/**
 * Closed set of CONCRETE, checkable first-person action verbs. Each maps surface
 * forms (incl. present-participle) to a canonical lemma so "restarting"/"restart"
 * collapse for the dedupe key, while distinct actions stay distinct.
 */
// `pattern` = all surface forms (used by the first-person-anchored regexes 1 & 2).
// `participle` = the -ing form ONLY (used by the sentence-initial regex 3, which has
// no explicit subject, so it must be a participle — an imperative base form like
// "Merge the PR" is a command TO the agent, not the agent's own claim).
const VERB_LEMMAS: Array<{ canonical: string; pattern: string; participle: string }> = [
  { canonical: 'relaunch', pattern: 'relaunch(?:ing|es)?', participle: 'relaunching' },
  { canonical: 'restart', pattern: 'restart(?:ing|s)?', participle: 'restarting' },
  { canonical: 'redeploy', pattern: 'redeploy(?:ing|s)?', participle: 'redeploying' },
  { canonical: 'deploy', pattern: 'deploy(?:ing|s)?', participle: 'deploying' },
  { canonical: 'push', pattern: 'push(?:ing|es)?', participle: 'pushing' },
  { canonical: 'merge', pattern: 'merg(?:e|ing|es)?', participle: 'merging' },
  { canonical: 'revert', pattern: 'revert(?:ing|s)?', participle: 'reverting' },
  { canonical: 'rebase', pattern: 'rebas(?:e|ing|es)?', participle: 'rebasing' },
  { canonical: 'rerun', pattern: 're-?run(?:ning|s)?', participle: 're-?running' },
  { canonical: 'fix', pattern: 'fix(?:ing|es)?', participle: 'fixing' },
];

// near-future intent markers that must precede the verb (first-person scoped).
// "I'll restart", "I will push", "I'm going to deploy", "let me rebase",
// "going to merge", "about to redeploy".
const FUTURE_LEAD =
  String.raw`(?:i'?ll|i\s+will|i'?m\s+going\s+to|i\s+am\s+going\s+to|let\s+me|going\s+to|about\s+to|i'?m\s+about\s+to)`;

// present-progressive (FD4): "restarting now", "pushing it", "relaunching" — a
// first-person in-flight claim. We require either a leading "I'm "/"I am " OR a
// trailing " now"/" it"/" the ..." to keep it first-person and avoid matching a
// bare gerund inside unrelated prose.
const PROG_TRAIL = String.raw`(?:\s+(?:now|it|this|that|the\b[^.!?\n]{0,40}))`;

const QUOTE_CHARS = new Set(['"', "'", '“', '”', '‘', '’', '`']);

/** A claim directly preceded by a quote/backtick is being QUOTED, not asserted. */
function isQuoted(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0 && index - i <= 2; i--) {
    const ch = text[i];
    if (ch === ' ') continue;
    return QUOTE_CHARS.has(ch);
  }
  return false;
}

function buildRegexes(): Array<{ canonical: string; re: RegExp }> {
  const out: Array<{ canonical: string; re: RegExp }> = [];
  for (const { canonical, pattern, participle } of VERB_LEMMAS) {
    // future-lead form: "I'll <verb>", "going to <verb>", …
    out.push({
      canonical,
      re: new RegExp(String.raw`\b${FUTURE_LEAD}\s+(?:${pattern})\b`, 'gi'),
    });
    // present-progressive first-person form: "I'm <verb>ing", "I am <verb>ing"
    out.push({
      canonical,
      re: new RegExp(String.raw`\bi'?(?:m|\s+am)\s+(?:${pattern})\b`, 'gi'),
    });
    // SENTENCE-INITIAL present-participle with a binding trailer: "Relaunching now",
    // "Done. Pushing it now." — idiomatically a first-person in-flight claim. MUST be
    // a participle (not a base form) AND at the start of the message or right after a
    // sentence boundary — so it never matches a mid-sentence imperative/question/
    // third-person ("Did you restart it?", "Please merge the PR", "He is deploying it").
    out.push({
      canonical,
      re: new RegExp(String.raw`(?:^|[.!?]\s+)(?:${participle})${PROG_TRAIL}`, 'gi'),
    });
  }
  return out;
}

const REGEXES = buildRegexes();

// Past-tense guard (FD4): a clear past-tense form is the descoped A2 class, never
// a future-action claim. We reject a match whose verb appears ONLY in past tense.
const PAST_RE =
  /\b(?:relaunched|restarted|redeployed|deployed|pushed|merged|reverted|rebased|re-?ran|fixed)\b/i;

/**
 * Classify an outbound message. Returns the FIRST concrete future-action claim
 * (high-precision; fail toward not-registering). Pure + total.
 */
export function classifyActionClaim(text: string): ActionClaimResult {
  if (!text || typeof text !== 'string') return { isActionClaim: false };
  let best: { index: number; canonical: string; matched: string } | null = null;
  for (const { canonical, re } of REGEXES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isQuoted(text, m.index)) continue;
      // The matched span itself must not be a past-tense assertion.
      if (PAST_RE.test(m[0])) continue;
      if (best === null || m.index < best.index) {
        best = { index: m.index, canonical, matched: m[0].trim() };
      }
    }
  }
  if (!best) return { isActionClaim: false };
  return {
    isActionClaim: true,
    claim: { normalizedClaimVerb: best.canonical, matched: best.matched },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Operator-approval REQUESTS (CMT-810, 2026-10-14 parallel-session incident).
//
// "May I restart the Mac Studio?" is a REQUEST, not a claim — the claim classifier
// above correctly ignores it (no first-person future-action assertion), yet it is
// the exact shape that let two sessions give the operator opposite advice about
// the same restart on the same afternoon. This classifier catches that shape so
// the cross-topic activity index can record "this topic is asking the operator to
// approve a restart" at the moment the question is asked.
//
// SIGNAL-ONLY: the result writes an activity note for other sessions to see. It
// never opens a commitment, never gates, never changes what the operator sees.
// Fail toward NOT-classifying on ambiguity (same posture as the claim classifier):
// a false positive only puts a slightly wrong focus line in a read-only index, but
// a loose detector trains readers to ignore the index, which is worse than silence.
// ─────────────────────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  /** Canonical lemma of the action being asked about (the dedupe anchor). */
  normalizedVerb: string;
  /** The raw matched phrase (for audit). */
  matched: string;
}

export interface ApprovalRequestResult {
  isApprovalRequest: boolean;
  request?: ApprovalRequest;
}

/**
 * Verbs an operator is typically asked to APPROVE. Wider than the claim set on
 * purpose: the claim set is bounded by "what should open a nagging commitment";
 * this set is bounded by "what a second session needs to know is being proposed"
 * — destructive or disruptive actions (reboot, shut down, kill, delete, rotate…)
 * belong here even though they never belong in the auto-commitment lane.
 * `pattern` covers the base + inflected verb forms; `noun` the nominal form used
 * after "approve/authorize/confirm" ("approve the restart", "ok the rollback").
 */
const APPROVAL_VERBS: Array<{ canonical: string; pattern: string; noun?: string }> = [
  { canonical: 'restart', pattern: 'restart(?:ing|s)?', noun: 'restart' },
  { canonical: 'reboot', pattern: 'reboot(?:ing|s)?', noun: 'reboot' },
  { canonical: 'relaunch', pattern: 'relaunch(?:ing|es)?', noun: 'relaunch' },
  { canonical: 'shutdown', pattern: 'shut(?:\\s|-)?down|power(?:\\s|-)?off', noun: 'shutdown|shut-?down' },
  { canonical: 'kill', pattern: 'kill(?:ing|s)?' },
  { canonical: 'stop', pattern: 'stop(?:ping|s)?' },
  { canonical: 'delete', pattern: 'delet(?:e|ing|es)|remov(?:e|ing|es)|wip(?:e|ing|es)', noun: 'deletion|delete|removal|wipe' },
  { canonical: 'redeploy', pattern: 'redeploy(?:ing|s)?', noun: 'redeploy' },
  { canonical: 'deploy', pattern: 'deploy(?:ing|s)?', noun: 'deploy(?:ment)?' },
  { canonical: 'push', pattern: 'push(?:ing|es)?', noun: 'push' },
  { canonical: 'merge', pattern: 'merg(?:e|ing|es)', noun: 'merge' },
  { canonical: 'revert', pattern: 'revert(?:ing|s)?', noun: 'revert' },
  { canonical: 'rollback', pattern: 'roll(?:\\s|-)?back(?:ing)?', noun: 'roll-?back' },
  { canonical: 'rotate', pattern: 'rotat(?:e|ing|es)', noun: 'rotation' },
  { canonical: 'revoke', pattern: 'revok(?:e|ing|es)', noun: 'revocation' },
  { canonical: 'cancel', pattern: 'cancel(?:l?ing|s)?', noun: 'cancellation' },
  { canonical: 'update', pattern: 'updat(?:e|ing|es)|upgrad(?:e|ing|es)', noun: 'update|upgrade' },
  { canonical: 'install', pattern: 'install(?:ing|s)?|uninstall(?:ing|s)?', noun: 'install(?:ation)?' },
  { canonical: 'rerun', pattern: 're-?run(?:ning|s)?', noun: 're-?run' },
];

// Up to a few hedging words between the lead and the verb: "may I go ahead and
// restart", "can I just restart", "should I now restart".
const HEDGE = String.raw`(?:\s+(?:go\s+ahead\s+and|just|now|please|also|then|first|safely|actually))?`;

// Lead forms that make a sentence a REQUEST for permission — every lead is either
// first-person interrogative ("may I", "should I", "mind if I"), an explicit ask of the
// addressee ("do you want me to", "please approve the"), or a bare permissive phrase
// that only counts when the sentence is a QUESTION ("Ok to restart?", "Safe to reboot
// now?"). Second-pass review (2026-10-14) caught the earlier bare "safe/clear/ok to
// <verb>" lead firing on "It is not safe to restart the Studio yet" — the hold-off
// advice from the incident itself — and on "You are clear to restart whenever you
// like"; a STATEMENT of permission or prohibition is never a request.
const ASK_LEADS: Array<{ re: string; needsQuestion: boolean }> = [
  // "may I / can I / could I / shall I / should I <verb>"
  { re: String.raw`\b(?:may|can|could|shall|should)\s+i${HEDGE}\s+`, needsQuestion: false },
  // "do you want me to / would you like me to / want me to / need me to <verb>"
  { re: String.raw`\b(?:do\s+you\s+want|would\s+you\s+like|want|like|need)\s+me\s+to${HEDGE}\s+`, needsQuestion: false },
  // interrogative permission: "is it ok (if I|to)", "would it be safe to", "am I clear to", "mind if I"
  { re: String.raw`\b(?:is\s+it|would\s+it\s+be|am\s+i)\s+(?:ok(?:ay)?|alright|safe|clear|fine|good)\s+(?:for\s+me\s+)?(?:to|if\s+i)${HEDGE}\s+`, needsQuestion: false },
  { re: String.raw`\bmind\s+if\s+i${HEDGE}\s+`, needsQuestion: false },
  // bare permissive phrase — ONLY as a question: "Ok to restart the Studio?", "Permission to reboot?"
  { re: String.raw`\b(?:ok(?:ay)?|alright|safe|clear|permission|green[\s-]?light|go[\s-]?ahead|approval)\s+(?:for\s+me\s+)?to${HEDGE}\s+`, needsQuestion: true },
  // "I'd like to <verb> … ?" (a statement unless asked)
  { re: String.raw`\bi(?:'d|\s+would)\s+like\s+to${HEDGE}\s+`, needsQuestion: true },
  // "requesting approval to <verb>", "asking for your permission to <verb>"
  { re: String.raw`\b(?:request(?:ing)?|ask(?:ing)?\s+for)\s+(?:your\s+)?(?:approval|permission|go[\s-]?ahead|ok(?:ay)?)\s+to${HEDGE}\s+`, needsQuestion: false },
];

// Nominal asks of the addressee. Each is an explicit REQUEST, never a bare
// "approve/confirm" that also appears in statements ("I can confirm the restart
// finished", "only the operator can approve a restart" — both caught by review).
const NOUN_OBJ = String.raw`\s+(?:the|this|that|a|an|my)\s+(?:[a-z-]+\s+){0,2}`;
const APPROVE_LEADS: Array<{ re: string; needsQuestion: boolean }> = [
  // "please approve the restart", "can you authorize this rollback", "I need you to confirm the reboot"
  { re: String.raw`\b(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+need\s+you\s+to\s+|i(?:'d|\s+would)\s+like\s+you\s+to\s+)(?:approve|authorize|authorise|confirm|green[\s-]?light|ok(?:ay)?|sign\s+off\s+on)${NOUN_OBJ}`, needsQuestion: false },
  // "I need / want / am waiting for / am asking for your approval for the restart"
  { re: String.raw`\b(?:need|needs|want|waiting\s+for|asking\s+for|request(?:ing)?)\s+your\s+(?:approval|go[\s-]?ahead|ok(?:ay)?|sign[\s-]?off)\s+(?:for|on|of|to)(?:${NOUN_OBJ}|\s+)`, needsQuestion: false },
  // bare imperative, ONLY as a question: "Approve the restart?"
  { re: String.raw`(?:^|[.!?]\s+)(?:approve|authorize|authorise|confirm|ok(?:ay)?)${NOUN_OBJ}`, needsQuestion: true },
];

function buildApprovalRegexes(): Array<{ canonical: string; re: RegExp; needsQuestion: boolean }> {
  const out: Array<{ canonical: string; re: RegExp; needsQuestion: boolean }> = [];
  for (const { canonical, pattern, noun } of APPROVAL_VERBS) {
    for (const lead of ASK_LEADS) {
      out.push({ canonical, re: new RegExp(String.raw`${lead.re}(?:${pattern})\b`, 'gi'), needsQuestion: lead.needsQuestion });
    }
    if (noun) {
      for (const lead of APPROVE_LEADS) {
        out.push({ canonical, re: new RegExp(String.raw`${lead.re}(?:${noun})\b`, 'gi'), needsQuestion: lead.needsQuestion });
      }
    }
  }
  return out;
}

const APPROVAL_REGEXES = buildApprovalRegexes();

/** The sentence (bounded at . ! ? or newline) containing `index`. */
function sentenceOf(text: string, index: number): string {
  let start = index;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  const rest = text.slice(index);
  const end = rest.search(/[.!?\n]/);
  return text.slice(start, end >= 0 ? index + end + 1 : text.length);
}

/** Does the sentence containing `index` end in a question mark? */
function sentenceIsQuestion(text: string, index: number): boolean {
  const rest = text.slice(index);
  const end = rest.search(/[.!?\n]/);
  return end >= 0 && rest[end] === '?';
}

/**
 * Classify an outbound message as an operator-approval REQUEST for a concrete
 * action. Returns the FIRST match. Pure + total; quote-skipping like
 * classifyActionClaim. Past-tense ("you approved the restart") is not a request.
 */
export function classifyApprovalRequest(text: string): ApprovalRequestResult {
  if (!text || typeof text !== 'string') return { isApprovalRequest: false };
  let best: { index: number; canonical: string; matched: string } | null = null;
  for (const { canonical, re, needsQuestion } of APPROVAL_REGEXES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isQuoted(text, m.index)) continue;
      if (/\b(?:approved|authorized|authorised|confirmed)\b/i.test(m[0])) continue;
      // Negation makes it a statement, not a request: "not safe to restart", "never ok to
      // reboot", "you do not need me to restart anything".
      const lead = text.slice(Math.max(0, m.index - 16), m.index + m[0].length);
      if (/\b(?:not|never|n't|isn't|wasn't)\s+(?:yet\s+)?(?:ok(?:ay)?|alright|safe|clear|fine|good)\s+to\b/i.test(lead)) continue;
      if (/\b(?:do(?:es)?n't|do\s+not|does\s+not|never|won't|wouldn't)\s+(?:really\s+)?(?:need|want|like)\s+me\s+to\b/i.test(lead)) continue;
      // A VERIFICATION ask is not an APPROVAL ask: "please confirm the restart completed".
      if (/\bconfirm\b/i.test(m[0]) && /\b(?:completed?|finished|went\s+through|succeeded|worked|is\s+done|was\s+done)\b/i.test(sentenceOf(text, m.index))) continue;
      if (needsQuestion && !sentenceIsQuestion(text, m.index)) continue;
      if (best === null || m.index < best.index) {
        best = { index: m.index, canonical, matched: m[0].trim() };
      }
    }
  }
  if (!best) return { isApprovalRequest: false };
  return { isApprovalRequest: true, request: { normalizedVerb: best.canonical, matched: best.matched } };
}

/**
 * The sentence (bounded) that contains `needle`, for an audit-friendly excerpt.
 * Returns the first `maxLen` chars of the containing sentence; falls back to the
 * head of the message when the needle is not found. Pure.
 */
export function excerptAround(text: string, needle: string, maxLen = 200): string {
  const src = String(text ?? '');
  const at = needle ? src.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return src.replace(/\s+/g, ' ').trim().slice(0, maxLen);
  // A sentence ends at . ! ? or at a BLANK line (paragraph break). A single wrapped
  // newline inside a sentence is just whitespace — Telegram replies wrap freely.
  const isBoundary = (i: number): boolean => {
    const ch = src[i];
    if (ch === '.' || ch === '!' || ch === '?') return true;
    return ch === '\n' && /^[ \t]*\n/.test(src.slice(i + 1, i + 40));
  };
  let start = at;
  while (start > 0 && !isBoundary(start - 1)) start--;
  let end = at;
  while (end < src.length && !isBoundary(end)) end++;
  if (end < src.length && src[end] !== '\n') end++; // include . ! ? (not the blank line)
  return src.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
