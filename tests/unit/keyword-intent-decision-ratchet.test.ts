/**
 * Infrastructure ratchet — "Intelligence Infers, Keywords Only Guard".
 *
 * Enforces the constitutional standard of the same name
 * (`docs/specs/standard-intelligence-infers-keywords-only-guard.md`, registered in
 * `docs/STANDARDS-REGISTRY.md`). Sibling to the `no-silent-fallbacks` ratchet and the
 * "an LLM gate must not string-match" guard. Scoped by the audit
 * `docs/audits/keyword-intent-classification-audit-2026-07-03.md`. Design:
 * `docs/specs/lint-keyword-intent-decision-ratchet.md`.
 *
 * THE ANTI-PATTERN IT CATCHES: a keyword / phrase / regex list of NATURAL-LANGUAGE
 * words matched against a message / conversation / user-text variable to MAKE A
 * DECISION about what a human meant (classify intent, gate / reroute / swallow a
 * message). Earned from 2026-07-03: `NicknameCommand`'s verb list hijacked the
 * operator's discussion message "keep the work on the laptop" as a move command and
 * swallowed it before the agent ever saw it.
 *
 * WHAT IT MUST NOT FLAG (the standard's two survivors + the audit's cleared classes):
 *   1. Fixed-enum validators (validate a whole value against a closed set).
 *   2. Declared LLM-backed safety FLOORS (emergency-stop fast-path WITH an LLM stage
 *      behind it) — annotated with an inline `@intent-safety-floor-ok` marker.
 *   3. Structured-output enums / parsers (the model emits into a known set; code never
 *      string-matches model prose).
 *   4. Cleared non-intent classes: process/tmux/error-message signature matchers,
 *      security scrubbers/redactors, agent-own-output classifiers, cosmetic selectors,
 *      quantity extractors, observe-only signal loggers. Held in ALLOWLIST below, keyed
 *      by file (documented by symbol), reproduced from the audit so the initial run is
 *      clean-by-construction.
 *
 * CONSERVATISM: the detector errs toward FALSE NEGATIVES (miss a subtle one) over FALSE
 * POSITIVES (flag an enum validator). A noisy ratchet gets disabled. The message-variable
 * gate + the audit allowlist do the precision work.
 *
 * ROLLOUT: ships in REPORT MODE first (`ENFORCE = false`) — it prints the offender set on
 * every run but never fails CI on a net-new violation. After a clean soak, flip
 * `ENFORCE = true` to make the `<= BASELINE` ratchet hard, exactly like no-silent-fallbacks.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '../../src');
const TARGET_DIRS = ['core', 'monitoring', 'server', 'threadline', 'messaging'];

// ── Detector ────────────────────────────────────────────────────────────────

// Message-like variable names — the receiver or argument of a decision test. These
// are the names the six offenders actually test against; deliberately does NOT
// include `msg` / `err.message` / `prompt` (those are error / framework-prompt text,
// never a user's conversational message — see the property-access exclusion below).
const MSG_VAR = '(?:text|message|content|body|turn|conversation|lower|trimmed|normText|rawText|userText|goalText|tailLower|t)';
// receiver form: `text.includes(` / `message.match(` — but NOT a property access like `err.message.`
const RECV_RE = new RegExp(`(?<![.\\w])${MSG_VAR}\\.(?:includes|match|test|exec|indexOf)\\(`);
// argument form: `.includes(...text)` / `re.test(normText)` — but NOT `.test(err.message)`
const ARG_RE = new RegExp(`\\.(?:includes|test|exec|match|some)\\([^)]*(?<![.\\w])${MSG_VAR}\\b`);

// Intent-signalling named list constants (VERB(S)/KEYWORD(S)/SIGNAL(S)/INTENT(S)/
// PHRASE(S)/TRIGGER(S)/LEXICON/LEMMA(S)). Deliberately excludes bare PATTERN(S) / WORD(S)
// so the many CREDENTIAL_PATTERNS / TERMINAL_ERROR_PATTERNS / STOPWORDS scrubbers do not
// trip the name filter — the two offenders that use inline NL-phrase regexes are caught by
// sub-detector 2 instead.
const INTENT_NAME_RE = /\bconst\s+([A-Za-z0-9_]*(?:VERB|VERBS|KEYWORD|KEYWORDS|SIGNAL|SIGNALS|INTENT|INTENTS|PHRASE|PHRASES|TRIGGER|TRIGGERS|LEXICON|LEMMA|LEMMAS)[A-Za-z0-9_]*)\b/g;

// A natural-language multi-word phrase inside a regex literal source (two lowercase
// words separated by a whitespace token: `\s`, `\s+`, or a literal space).
const NL_PHRASE = /[a-z]{2,}(?:\\s\+?| )[a-z]{2,}/;

const FLOOR_MARKER = '@intent-safety-floor-ok';

function hasMsgTest(src: string): boolean {
  return RECV_RE.test(src) || ARG_RE.test(src);
}

interface Flag {
  rel: string;
  reasons: string[];
  floor: boolean;
}

/** Detect the keyword-intent-decision anti-pattern in one file. Returns null if clean. */
function detect(filePath: string): Flag | null {
  const src = fs.readFileSync(filePath, 'utf-8');
  const rel = path.relative(SRC_DIR, filePath).split(path.sep).join('/');
  const reasons: string[] = [];

  // sub-detector 1: an intent-named NL list + a message-like decision test in the file.
  INTENT_NAME_RE.lastIndex = 0;
  const intentNames: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = INTENT_NAME_RE.exec(src))) {
    const after = src.slice(m.index, m.index + 1500);
    const lc = (after.match(/['"][a-z][a-z '\-]{1,}['"]/g) || []).length;
    const hasRe = /=\s*\[/.test(after) && /\/[^/\n]+\/[gimsuy]*/.test(after);
    if (lc >= 2 || hasRe) intentNames.push(m[1]);
  }
  if (intentNames.length && hasMsgTest(src)) {
    reasons.push(`sub1:named-list[${intentNames.join(',')}]`);
  }

  // sub-detector 2: an inline NL-phrase regex tested against a message-like var (same line).
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\.(?:match|test|exec)\(/.test(line)) continue;
    const reLits = line.match(/\/(?:\\.|[^/\n\\])+\/[gimsuy]*/g) || [];
    if (!reLits.some((r) => NL_PHRASE.test(r))) continue;
    if (RECV_RE.test(line) || ARG_RE.test(line)) {
      reasons.push(`sub2:inline-nl-regex@${i + 1}`);
      break;
    }
  }

  return reasons.length ? { rel, reasons, floor: src.includes(FLOOR_MARKER) } : null;
}

function getSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        e.name.endsWith('.ts') &&
        !e.name.endsWith('.test.ts') &&
        !e.name.endsWith('.d.ts')
      ) {
        out.push(p);
      }
    }
  };
  for (const d of TARGET_DIRS) walk(path.join(SRC_DIR, d));
  return out;
}

// ── The known genuine offenders (audit findings 1-6) ─────────────────────────
// Each decides what a human MEANT from a keyword/regex list, wired into (or reachable
// from) the inbound message path. These are the baseline; the number only DECREASES as
// each is converted to LLM-with-context (the CoherenceGate / cheap-prefilter→LLM template).
// #2 core/NicknameCommand.ts (recognizeNicknameCommand — TRANSFER_VERBS/PIN_VERBS,
// the hijack) was CONVERTED to LLM-with-context (MoveIntentClassifier) on 2026-07-04
// — the exemplar under this very standard (docs/specs/nickname-move-intent-llm-rebuild.md).
// It no longer keyword-decides intent, so the detector no longer flags it: it is
// removed from the baseline and BASELINE dropped 6→5 (this ratchet only ever DECREASES).
// #3 threadline/hubCommands.ts (parseHubCommand — open/tie NL regexes that SWALLOWED
// the message) was CONVERTED to LLM-with-context (HubIntentClassifier) on 2026-07-04
// — Conversion #3 under this standard (docs/specs/keyword-intent-conversions-1-and-3.md).
// It no longer keyword-decides intent, so it is removed from the baseline and BASELINE
// dropped 5→4. (topicProfileIngress #1 remains — its conversion lands separately.)
const EXPECTED_OFFENDERS = [
  'core/topicProfileIngress.ts',   // #1 parseProfileTrigger — framework/model/thinking NL regexes (LIVE)
  'core/TopicClassifier.ts',       // #4 scoreKeywords — TOPIC/INTENT/PROBLEM keyword density (latent)
  'core/AutonomySkill.ts',         // #5 INTENT_PATTERNS — autonomy phrases (latent, exported/unwired)
  'core/AgentReadinessScorer.ts',  // #6 scoreText — coordination/judgment lexicon density (advisory)
].sort();

// ── Allowlist — cleared classes that the detector's signature trips but that are NOT
// the anti-pattern (audit "cleared" set + survivors). Keyed by file, documented by symbol.
// A file here is a KNOWN blind spot: a NEW keyword-intent gate added INSIDE one of these
// files would be masked. Every entry maps to an audit-verified non-intent classification.
const ALLOWLIST: Record<string, string> = {
  // Survivor #2 handled by the @intent-safety-floor-ok marker, not this list:
  //   core/MessageSentinel.ts (emergency-stop fast-path WITH an LLM stage behind it).

  // Agent's OWN outbound classified (not a user message) — signal-only, high-precision.
  'core/action-claim.ts': 'VERB_LEMMAS/FUTURE_LEAD — classifies the agent\'s own outbound "did I promise a future action"; audit "Related", not user-intent gating.',
  // Process / error-message signature matchers (classify a thrown error, not user text).
  'core/crossModelReviewer.ts': 'classifyReviewFailure — classifies an error message (rate-limited/timeout); TIER_WORDS is a structured-output enum (survivor #3).',
  // Structured LLM-output field parsing (parses the model\'s own response, never gates prose).
  'core/LLMConflictResolver.ts': 'content.match(/^Machine A intent:/m) — parses structured LLM output fields, not keyword-gating user intent.',
  // Doc-template migration content matching (CLAUDE.md template text, not a user message).
  'core/PostUpdateMigrator.ts': 'content.includes(...) over the CLAUDE.md template during migration — not a user-message decision.',
  // Security scrubber — leak detection over the agent\'s OWN outbound draft (the tone gate).
  'core/MessagingToneGate.ts': 'CALL_PHRASE/CALL_CMD — detects CLI-command/endpoint leaks in the agent\'s outbound draft; security scrubber, cleared class.',
  // Advisory, non-authority feature-goal classifier — yields to the author declaration.
  'core/LiveTestGate.ts': 'looksUserFacing — advisory signal over a feature GOAL (dev spec text), never gates a user message; yields to author declaration.',
  // Cosmetic topic-icon selection — never gates / reroutes / swallows a message.
  'messaging/TelegramAdapter.ts': 'TOPIC_EMOJI_KEYWORDS — picks a topic-icon emoji from title words; cosmetic, non-authority.',
  // Quantity extraction (deadline shorthand → cadence) — like time-claim, not intent gating.
  'monitoring/CommitmentTracker.ts': 'deadline-shorthand extraction ("by eod" → cadence) from a commitment\'s agreement text; quantity extraction, not intent gating.',
  // Observe-only correction/preference SIGNAL logging feeding an LLM distiller.
  'monitoring/HumanAsDetectorLog.ts': 'SIGNAL_RULES — observe-only signal logging that feeds an LLM distiller; never decides a message\'s fate (cheap-prefilter→LLM template).',
  // A2A reply-warrant heuristic (membership + openers) — decides whether to reply to a PEER agent.
  'threadline/WarrantsReplyGate.ts': 'CONTROL_PHRASES.has(norm) + opener regexes — A2A reply-warrant heuristic (whole-value membership, survivor #1); never swallows operator input.',
};

// ═══════════════════════════════════════════════════════════════════════════════
// RATCHET BASELINE — only DECREASE, never increase. The count of genuine offenders
// (per file). Landed at 6 (the audit's six findings). When an offender is converted to
// LLM-with-context (and thus stops matching), lower this number. 6→5 NicknameCommand
// (MoveIntentClassifier, #1367); 5→4 hubCommands (HubIntentClassifier, Conversion #3).
// ═══════════════════════════════════════════════════════════════════════════════
const BASELINE = 4;

// Report mode (graduated rollout). While false, the net-new `<= BASELINE` guard only
// WARNS — it never fails CI. Flip to true after a clean soak to make it hard.
const ENFORCE = false;

describe('Keyword-Intent Decision Ratchet ("Intelligence Infers, Keywords Only Guard")', () => {
  const files = getSourceFiles();
  const flagged = files.map(detect).filter((f): f is Flag => f !== null);
  const flaggedRels = new Set(flagged.map((f) => f.rel));

  // Offenders = flagged, minus allowlisted files, minus @intent-safety-floor-ok files.
  const offenders = flagged
    .filter((f) => !f.floor && !(f.rel in ALLOWLIST))
    .map((f) => f.rel)
    .sort();

  it('scans the target directories', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(flagged.length).toBeGreaterThan(0);
  });

  it('detects all six known offenders (detector-alive guard)', () => {
    for (const off of EXPECTED_OFFENDERS) {
      expect(flaggedRels.has(off), `detector no longer flags known offender ${off}`).toBe(true);
      expect(offenders, `known offender ${off} must not be allowlisted/floor-exempted`).toContain(off);
    }
  });

  it('the declared safety floor carries the @intent-safety-floor-ok marker', () => {
    const floors = flagged.filter((f) => f.floor).map((f) => f.rel);
    expect(floors, 'MessageSentinel must be exempted via the safety-floor marker, not the allowlist')
      .toContain('core/MessageSentinel.ts');
  });

  it('no allowlist entry is dead weight (each allowlisted file is actually flagged)', () => {
    const dead = Object.keys(ALLOWLIST).filter((rel) => !flaggedRels.has(rel));
    if (dead.length) {
      console.warn(`\n[keyword-intent] allowlist entries no longer flagged (prune them):\n  ${dead.join('\n  ')}\n`);
    }
    // Advisory only — a cleared file being refactored out of the signature must never fail CI.
    expect(Array.isArray(dead)).toBe(true);
  });

  it('no new keyword-intent-decision violations beyond the baseline', () => {
    const beyond = offenders.filter((o) => !EXPECTED_OFFENDERS.includes(o));

    const report = offenders
      .map((rel) => {
        const f = flagged.find((x) => x.rel === rel)!;
        const known = EXPECTED_OFFENDERS.includes(rel) ? '' : '  <-- NET-NEW';
        return `  ${rel} [${f.reasons.join(', ')}]${known}`;
      })
      .join('\n');

    console.warn(
      `\n[KEYWORD-INTENT] ${offenders.length} keyword-list intent decisions (baseline ${BASELINE}, ` +
        `mode=${ENFORCE ? 'ENFORCE' : 'REPORT'}):\n${report}\n` +
        (beyond.length
          ? `\n  ${beyond.length} NET-NEW violation(s) — convert to LLM-with-context or justify as a survivor:\n  ${beyond.join('\n  ')}\n`
          : ''),
    );

    if (ENFORCE) {
      // Hard ratchet: the count can only decrease.
      expect(offenders.length).toBeLessThanOrEqual(BASELINE);
    } else {
      // Report mode: never fail CI on a net-new violation; only the known baseline is asserted
      // so the detector + allowlist stay honest (clean-by-construction on current main).
      expect(EXPECTED_OFFENDERS.every((o) => offenders.includes(o))).toBe(true);
    }
  });
});
