#!/usr/bin/env node
/**
 * lint-telegram-send-funnel-guarded.mjs — every class that can reach the Telegram API must refuse
 * an invisible payload AT ITS FUNNEL.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────────────────
 * The invisible-payload refusal was placed four times and its scope over-claimed four times:
 *
 *   pass  9 → one HTTP route,          written up as "fixed at the point of sending"
 *   pass 27 → falsified by a 2nd route; guarded, written up as "both doors"
 *   pass 28 → falsified by a 3rd route; moved into sendToTopic, written up as
 *             "the single chokepoint every Telegram send passes through"
 *   pass 29 → falsified BY EXECUTION: `send()` reaches the API without entering sendToTopic
 *
 * Four wrong enumerations is not four mistakes, it is one habit: asserting the shape of a set
 * instead of deriving its members. Every repair in that window that HELD was a derivation, and
 * every one that failed was a hand-maintained list. So this lint does not carry a list of senders.
 *
 * ── What it derives ────────────────────────────────────────────────────────────────────────────
 * The population is defined by the MECHANISM, not by a name: a file that builds an
 * `api.telegram.org` URL and calls `fetch` can reach Telegram. That is what "a sender" means, and
 * a future fifth sender joins the population by existing rather than by being remembered.
 *
 * For each such file it asserts the refusal is invoked. It deliberately does NOT check WHERE the
 * call sits: proving "the call is in the same function as the fetch" needs a parser, and a weak
 * positional heuristic that passes for the wrong reason is worse than an honest narrower check
 * (window 11 produced three of those). The narrow claim it does make is checkable and true.
 *
 * ── Honest scope, stated because the last four claims here were not ───────────────────────────
 *   COVERED: a file that can reach the Telegram API and never invokes the refusal at all.
 *   NOT COVERED: a file that invokes it on a branch the send does not take, or that imports it and
 *   calls it with a method outside the body-carrying set. Those need a parser and are not claimed.
 *   NOT COVERED: any non-Telegram adapter. This is a Telegram lint and says so.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const GUARD = 'assertTelegramPayloadVisible';
/** The mechanism that defines a sender: builds the API URL and calls fetch. */
const API_HOST = 'api.telegram.org';
const GUARD_SRC = path.join(SRC, 'messaging', 'invisible-payload.ts');

/**
 * The body-carrying method names are READ from the guard's own source, never restated here.
 * A second copy of this list would drift from the first, and a hand-maintained list drifting from
 * its source is the precise defect this window is named after — the fix that keeps working is
 * always the one that derives. A pointer cannot disagree with what it points at.
 */
function guardSource() {
  if (!fs.existsSync(GUARD_SRC)) {
    console.error(`[telegram-send-funnel] ${path.relative(ROOT, GUARD_SRC)} is missing — refusing to report clean.`);
    process.exit(1);
  }
  return fs.readFileSync(GUARD_SRC, 'utf-8');
}

function readBodyCarryingMethods() {
  const block = guardSource().match(/READER_VISIBLE_TELEGRAM_PARAMS[^=]*=\s*\{([\s\S]*?)\n\};/);
  const methods = block
    ? [...block[1].matchAll(/^\s{2}([A-Za-z]+)\s*:\s*'[A-Za-z_]+'/gm)].map((m) => m[1])
    : [];
  if (methods.length === 0) {
    console.error(
      '[telegram-send-funnel] could not read READER_VISIBLE_TELEGRAM_PARAMS from the guard source — '
      + 'the matcher is broken or the constant moved. Refusing to report clean.',
    );
    process.exit(1);
  }
  return methods;
}

/** Read a declared `new Set([...])` of method names from the guard source. Same fail-closed rule. */
function readDeclaredSet(name) {
  const block = guardSource().match(new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  const names = block ? [...block[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]) : [];
  if (names.length === 0) {
    console.error(
      `[telegram-send-funnel] could not read ${name} from the guard source — the matcher is broken or the `
      + 'constant moved. Refusing to report clean.',
    );
    process.exit(1);
  }
  return names;
}

const BODY_METHODS = readBodyCarryingMethods();

/**
 * A LIVE CALL to the guard, not a mention of its name.
 *
 * The first version of this function was `text.includes(GUARD)`, and its sabotage proof passed on
 * all six senders — because the sabotage renamed the call to `assertTelegramPayloadVisible_DISABLED`
 * and a bare substring test still matched it. The check could not fail, which is the alive-but-inert
 * shape this lint exists to catch, reproduced inside the lint itself within minutes of writing it.
 * (It is also review pass 24's lesson exactly: when you strip a word to build a test case, the
 * replacement must not CONTAIN the word being stripped.)
 *
 * So three things must hold: the identifier is followed by `(`, it is not part of a longer
 * identifier, and the line is not commented out — a commented-out guard is not a guard.
 */
function hasLiveGuardCall(text) {
  // Strip BLOCK comments across the whole file before looking at lines. The line-at-a-time version
  // stripped only `//` and skipped lines beginning `*`, which an independent reviewer defeated in
  // two shapes: a single-line `/* assertTelegramPayloadVisible(...); */` and a multi-line block —
  // both reported the file as GUARDED with the call commented out, and the whole test suite stayed
  // green. That is the third time in this increment that a check of mine could not fail.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const call = new RegExp(String.raw`(?<![A-Za-z0-9_$])${GUARD}\s*\(`);
  return code.split('\n').some((line) => {
    const bare = line.replace(/\/\/.*$/, '');
    if (!call.test(bare)) return false;
    if (/^\s*import\b/.test(bare)) return false;         // naming it in an import is not calling it
    // A LOCAL DEFINITION is not a call. The reviewer deleted the call, dropped the import, and
    // declared a no-op `function assertTelegramPayloadVisible(){}` in the same file — the regex
    // matched the definition and the lint passed, defeating its own delete-the-call sabotage.
    if (/^\s*(export\s+)?(async\s+)?function\s/.test(bare)) return false;
    if (/^\s*(export\s+)?(const|let|var)\s/.test(bare)) return false;
    return true;
  });
}

/**
 * A file that calls the guard must also IMPORT it from the one shared module. Without this, a local
 * re-declaration satisfies the call check — the decoy-definition escape above, closed from both ends.
 */
function importsSharedGuard(text) {
  const re = new RegExp(
    String.raw`import\s*\{[^}]*(?<![A-Za-z0-9_$])${GUARD}(?![A-Za-z0-9_$])[^}]*\}\s*from\s*['"][^'"]*invisible-payload\.js['"]`,
  );
  return re.test(text);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

if (!fs.existsSync(SRC)) {
  console.error('[telegram-send-funnel] src/ is missing — refusing to report clean.');
  process.exit(1);
}

const senders = [];
for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, 'utf-8');
  if (!text.includes(API_HOST)) continue;
  if (!/\bfetch\s*\(/.test(text)) continue;
  // Reaching the API is not enough to be in the population — a file that only calls `getChat` or
  // `getMe` carries no reader-visible body and nothing to refuse. Narrowed 2026-08-10 after the
  // first run of this lint flagged such a file: the over-broad population was the matcher's defect,
  // not the code's, and "fixing" that file would have been a repair aimed at my own instrument.
  const carries = BODY_METHODS.filter((m) => text.includes(m));
  if (carries.length === 0) continue;
  senders.push({
    file,
    guarded: hasLiveGuardCall(text) && importsSharedGuard(text),
    carries,
  });
}

// A lint that finds nothing must never report clean — it is indistinguishable from a broken
// matcher, which is the alive-but-inert shape this whole guard family exists to refuse.
if (senders.length === 0) {
  console.error(
    '[telegram-send-funnel] parsed ZERO Telegram senders — the matcher is broken or the API host '
    + 'string changed. Refusing to report clean.',
  );
  process.exit(1);
}

// SHRINK-ONLY RATCHET on the derived population.
//
// A zero-tripwire only catches TOTAL matcher failure. An independent reviewer escaped the
// population by splitting the host literal in one sender — the lint then reported "clean — 5
// sender(s)" and the file it could no longer see was the very one whose missing guard was this
// increment's headline discovery. A population that can silently shrink is a census that quietly
// stops counting, which is the defect this whole window is named after.
//
// Raise this ONLY together with the evidence that a genuine new sender was added.
const SENDER_BASELINE = 6;
if (senders.length < SENDER_BASELINE) {
  console.error(
    `[telegram-send-funnel] FAIL — derived ${senders.length} Telegram body-sender(s), baseline is `
    + `${SENDER_BASELINE}. The population SHRANK, which means either a sender was legitimately removed `
    + '(lower the baseline in this file, in the same commit) or the matcher can no longer see one — '
    + 'e.g. the API host or a method name is built from concatenated fragments.\n\n  Derived: '
    + senders.map((s) => path.relative(ROOT, s.file)).join(', '),
  );
  process.exit(1);
}

// CLOSED-WORLD METHOD CLASSIFICATION (round-3 convergence finding).
//
// Being in the guarded map made a method guarded; being in NEITHER list made it silently unguarded. So a
// future `sendPhoto` with a caption would enter the codebase unclassified and nothing would say a word —
// an unclassified member escaping the population, which is this branch's defining failure shape. Every
// method a sender calls must now be classified one way or the other; anything else is review-required.
const KNOWN = new Set([...BODY_METHODS, ...readDeclaredSet('NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS')]);
const METHOD_RE = /(?:apiCall\(|api\()\s*'([a-zA-Z]+)'|api\.telegram\.org\/bot[^'"`\s]*\/([a-zA-Z]+)/g;
const unclassified = new Map();
for (const s of senders) {
  const text = fs.readFileSync(s.file, 'utf-8');
  for (const m of text.matchAll(METHOD_RE)) {
    const method = m[1] ?? m[2];
    if (!method || KNOWN.has(method)) continue;
    if (!unclassified.has(method)) unclassified.set(method, new Set());
    unclassified.get(method).add(path.relative(ROOT, s.file));
  }
}
if (unclassified.size > 0) {
  console.error('[telegram-send-funnel] FAIL — Telegram method(s) called by a sender and classified NOWHERE:\n');
  for (const [method, files] of unclassified) {
    console.error(`  ${method}  (in ${[...files].join(', ')})`);
  }
  console.error(
    '\n  Every method a sender calls must be declared in src/messaging/invisible-payload.ts as either:'
    + '\n    READER_VISIBLE_TELEGRAM_PARAMS         — it shows a reader a field; name that field, and it is guarded'
    + '\n    NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS — it shows a reader nothing; declare it and say why'
    + '\n\n  An unclassified method is REVIEW-REQUIRED, never assumed safe. This check exists because'
    + '\n  "in the map = guarded, everything else = silently unguarded" is an open world, and an'
    + '\n  unclassified member escaping the population is how every repeat failure on this branch happened.',
  );
  process.exit(1);
}

const unguarded = senders.filter((s) => !s.guarded);
if (unguarded.length > 0) {
  console.error('[telegram-send-funnel] FAIL — a class can reach the Telegram API without the invisible-payload refusal:\n');
  for (const s of unguarded) {
    console.error(`  ${path.relative(ROOT, s.file)}`);
  }
  console.error(
    `\n  Call \`${GUARD}(method, params)\` as the first statement of the function that calls fetch.`
    + '\n  It is exported from src/messaging/invisible-payload.js.'
    + '\n\n  This check exists because "every send passes through here" was written four times about'
    + '\n  four different functions, and falsified four times. Derive the set; do not assert it.',
  );
  process.exit(1);
}

console.log(
  `lint-telegram-send-funnel-guarded: clean — ${senders.length} Telegram body-sender(s) derived by mechanism `
  + `(builds ${API_HOST} + calls fetch), all invoking ${GUARD}: `
  + senders.map((s) => path.relative(ROOT, s.file)).join(', '),
);
