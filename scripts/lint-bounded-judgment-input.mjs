#!/usr/bin/env node
/**
 * lint-bounded-judgment-input — the ratchet for bounds on data a judgment reads.
 *
 * Governed by: *Never Silently Cut the Data a Decision Depends On*
 * (docs/STANDARDS-REGISTRY.md), a child of *Verify the State, Not Its Symbol*.
 *
 * Justin, 2026-08-22, naming the pattern:
 *
 *   "in many many many of the solutions and features that you build you tend to default to
 *    truncating data in an effort to be more data efficient — however, often it just cuts off very
 *    critical information or causes more issues … losing critical data in critical processes like
 *    this is unacceptable."
 *
 * WHAT IT CHECKS. A site that (a) bounds a value with a bare `.slice(0, N)` / `.substring(0, N)`,
 * (b) binds the result to a name, and (c) interpolates that name into a template literal, inside a
 * file that builds prompts for a model. That combination is data being cut down and then handed to
 * a judgment — the shape the standard governs. A site is CLEAN when it bounds through
 * `src/core/boundedInput.ts` (`boundedTail` / `boundedHead`), which keeps the end by default,
 * discloses the cut inside the value where the consumer will read it, and refuses a bound too small
 * to hold its own disclosure.
 *
 * WHY A SHRINK-ONLY BASELINE. The population predates the standard, and converting a site is not
 * mechanical: each needs its bound RE-DERIVED against what its consumer accepts and its producer
 * emits, and needs a judgment about whether its input is load-bearing (in which case the answer is a
 * refusal, not a marker). Converting all of them in one pass would mean picking numbers by
 * resemblance — which is the defect, performed at speed. So the unconverted set is baselined and MAY
 * ONLY SHRINK.
 *
 * WHAT IT DOES NOT CHECK, stated rather than implied. It sees a syntactic shape. It cannot tell
 * whether a number is well derived, nor whether an input is load-bearing enough that the site should
 * refuse rather than disclose — both remain readings, carried as a named sub-obligation with a
 * countdown on the article. And it only sees the shape where the bounded value is NAMED before use:
 * an inline `.slice()` written directly inside a template literal is outside its population today.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const BASELINE = path.join(ROOT, 'docs/bounded-judgment-input-baseline.json');

/**
 * Below this, a `.slice(0, N)` is overwhelmingly an identifier/hash/label clamp (`sha.slice(0, 8)`,
 * a 32-char display name) rather than a bound on judgment input. Set at 100 so the population stays
 * the real thing; a genuinely load-bearing input bounded under 100 characters would be a defect this
 * lint misses and a reading would catch.
 */
const MIN_MEANINGFUL_BOUND = 100;

/** A file only enters the population if it actually builds prompts for a model. */
const PROMPT_FILE = /\.evaluate\s*\(|IntelligenceProvider|const prompt\s*=|let prompt\s*=/;

/** An explicit, reviewed exemption. Must state WHY, so it is a decision on the record. */
const EXEMPT = /bounded-input-reviewed:/;

/**
 * Strip comments and ordinary string literals, and report which lines sit INSIDE
 * a multi-line template literal.
 *
 * WHY A SCANNER RATHER THAN COUNTING BACKTICKS (independent review 2026-08-22,
 * finding C4). The first version tracked template literals by counting backticks
 * per line and flipping state on an odd count. A single unmatched backtick
 * anywhere — including inside a `//` comment — desynchronised every line after
 * it. That was not hypothetical: `src/commands/server.ts:6205` is the comment
 *
 *     // 'claude-code'`, so a codex-cli-only agent that didn't set the
 *
 * and from there ~11,800 lines of that file were treated as "inside a template
 * literal". FOUR of the five inline entries in the baseline were artifacts of
 * that bug rather than real sites — and the same desync hides genuine violations
 * behind any stray apostrophe-backtick earlier in a file, so it was wrong in both
 * directions at once.
 *
 * A ratchet that is wrong in both directions is worse than none: it manufactures
 * work, and it certifies the absence of the thing it was built to find.
 *
 * Returns `{ code, inTemplate }` where `code` is the source with comments and
 * non-template strings blanked (positions preserved, so line numbers still line
 * up) and `inTemplate` is a per-line boolean.
 */
export function scanSource(src) {
  const n = src.length;
  const out = new Array(n);
  const inTemplate = [];
  let line = 0;
  let templateDepth = 0;
  // Stack of '`' (inside template) and '{' (inside a ${ } expression).
  const stack = [];
  let i = 0;
  let state = 'code'; // code | line-comment | block-comment | squote | dquote
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '\n') {
      out[i] = '\n';
      inTemplate[line] = templateDepth > 0;
      line++;
      if (state === 'line-comment') state = 'code';
      i++;
      continue;
    }
    if (state === 'line-comment' || state === 'block-comment') {
      out[i] = ' ';
      if (state === 'block-comment' && c === '*' && c2 === '/') { out[i + 1] = ' '; i += 2; state = 'code'; continue; }
      i++;
      continue;
    }
    if (state === 'squote' || state === 'dquote') {
      out[i] = ' ';
      if (c === '\\') { out[i + 1] = ' '; i += 2; continue; }
      if ((state === 'squote' && c === "'") || (state === 'dquote' && c === '"')) state = 'code';
      i++;
      continue;
    }
    // state === 'code' (which includes template-literal text)
    if (templateDepth === 0) {
      if (c === '/' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'line-comment'; continue; }
      if (c === '/' && c2 === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'block-comment'; continue; }
      if (c === "'") { out[i] = ' '; i++; state = 'squote'; continue; }
      if (c === '"') { out[i] = ' '; i++; state = 'dquote'; continue; }
    }
    if (c === '\\' && templateDepth > 0) { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
    if (c === '`') {
      out[i] = '`';
      if (stack[stack.length - 1] === '`') { stack.pop(); templateDepth--; }
      else { stack.push('`'); templateDepth++; }
      i++;
      continue;
    }
    if (templateDepth > 0 && c === '$' && c2 === '{') {
      out[i] = '$'; out[i + 1] = '{';
      stack.push('{'); templateDepth--;
      i += 2;
      continue;
    }
    if (c === '}' && stack[stack.length - 1] === '{') {
      out[i] = '}';
      stack.pop(); templateDepth++;
      i++;
      continue;
    }
    out[i] = c;
    i++;
  }
  inTemplate[line] = templateDepth > 0;
  return { code: out.join(''), inTemplate };
}

/**
 * A stable key for an inline site: the file plus a short content hash of the
 * matched line, NOT its line number (independent review, finding C5). Keying on
 * the line number meant a single blank line inserted anywhere above produced BOTH
 * a "new violation" and a "stale baseline entry" error, failing the blocking lint
 * chain on an unrelated edit — and the only remedy, bumping the number by hand,
 * let an author swap a converted site for an unconverted one at the shifted
 * position without the ratchet noticing.
 */
function inlineKey(rel, lineText, seen) {
  const norm = lineText.trim().replace(/\s+/g, ' ');
  const h = createHash('sha256').update(norm).digest('hex').slice(0, 8);
  const base = `${rel}:inline#${h}`;
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}~${count}`;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (p.endsWith('.ts') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/**
 * The population: every `file:varName` where a bare truncation is bound to a
 * name and that name is interpolated into a template literal, inside a file
 * that builds prompts. Pure over a root directory so tests can drive it against
 * a fixture tree rather than the live repo.
 */
export function findBareTruncationSites(root) {
  const files = walk(path.join(root, 'src'), []);
  const found = [];
  for (const abs of files) {
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (!PROMPT_FILE.test(src)) continue;
    const rel = path.relative(root, abs);
    const lines = src.split('\n');
    // Blank out whole-line comments so a commented-out example cannot be a finding.
    const codeLines = lines.map((l) => (/^\s*(?:\/\/|\*|\/\*)/.test(l) ? '' : l));
    const seen = new Map();

    // ── SHAPE 1 — the bound is given a NAME, then interpolated into a prompt.
    //
    // Matched against a STATEMENT-JOINED, comment-stripped view rather than
    // line-by-line (independent review, finding C6): the old single-line regex
    // missed a declaration wrapped across two lines, which prettier produces
    // routinely. `substr` is accepted here too — shape 2 already matched it, and
    // a ratchet whose two halves disagree about what counts is a gap by
    // construction.
    //
    // The bound may be a NUMERIC LITERAL or a NAMED CONSTANT. Requiring a literal
    // was the worst of the evasions found: the standard itself says to hoist the
    // number into a named constant with its derivation beside it, so FOLLOWING
    // the rule made a site invisible to the rule's own enforcement.
    const bounded = new Map();
    const joined = codeLines.join('\n');
    const declRe = /(?:const|let)\s+(\w+)\s*=\s*[^;]*?\.(?:slice|substring|substr)\s*\(\s*0\s*,\s*([A-Za-z0-9_$]+)\s*\)/g;
    let m;
    while ((m = declRe.exec(joined)) !== null) {
      const lineIdx = joined.slice(0, m.index).split('\n').length - 1;
      const ctx = [lines[lineIdx] ?? '', lines[lineIdx - 1] ?? '', lines[lineIdx - 2] ?? ''];
      if (ctx.some((l) => EXEMPT.test(l))) continue;
      if (!isMeaningfulBound(m[2], joined)) continue;
      bounded.set(m[1], lineIdx + 1);
    }

    for (const [name] of bounded) {
      const re = new RegExp('\\$\\{[^}]*\\b' + name + '\\b');
      if (codeLines.some((l) => re.test(l))) found.push(`${rel}:${name}`);
    }

    // ── SHAPE 2 — the truncation written INLINE inside a template literal, with
    // no intermediate name.
    //
    // The multi-line discriminator is LOCAL, and deliberately so. Two global
    // approaches were tried and both were wrong:
    //
    //   1. Counting backticks per line and flipping a flag (the shipped version)
    //      desynchronised permanently on one unmatched backtick in a comment —
    //      `src/commands/server.ts:6205` — turning ~11,800 lines of that file
    //      into phantom template interior. FOUR of the five inline baseline
    //      entries were artifacts of it, and the same desync HIDES real sites
    //      behind any earlier stray backtick. Wrong in both directions at once.
    //
    //   2. A proper scanner tracking template depth is defeated by regex
    //      literals containing quotes or backticks (`/['"]/`), which this
    //      codebase has many of. Writing a JavaScript lexer good enough to be
    //      trusted is not a lint's job.
    //
    // So the question is answered WITHOUT global state: is there a backtick
    // before the match ON THIS LINE? If yes, the template opened here and is
    // self-contained — a log line or an error string, which is OUTPUT and a
    // different article's business. If no, the template opened on an earlier
    // line, which is what a prompt looks like.
    //
    // HONEST FAILURE DIRECTION: a stray backtick earlier on the same line makes
    // this MISS a site rather than invent one. That is the direction to fail in —
    // a fabricated finding forces work that does not exist and teaches authors to
    // distrust the ratchet, which is how a check ends up ignored.
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      if (/^\s*(?:\/\/|\*|\/\*)/.test(raw)) continue; // a comment line
      const hit = raw.match(/\$\{[^}]*?\.(?:slice|substring|substr)\s*\(\s*0\s*,\s*([A-Za-z0-9_$]+)/);
      if (!hit) continue;
      if (raw.slice(0, hit.index).includes('`')) continue; // template opened on THIS line
      const ctx = [raw, lines[i - 1] ?? '', lines[i - 2] ?? ''];
      if (ctx.some((l) => EXEMPT.test(l))) continue;
      if (!isMeaningfulBound(hit[1], joined)) continue;
      found.push(inlineKey(rel, raw, seen));
    }
  }
  return found.sort();
}

/**
 * Is this bound big enough to be a bound on judgment input rather than an
 * identifier clamp? Accepts a literal or resolves a named constant declared in
 * the same file; an unresolvable name counts as MEANINGFUL (fail toward
 * including it), because the alternative is a name that hides a site.
 */
function isMeaningfulBound(token, joined) {
  if (/^[0-9_]+$/.test(token)) return Number(token.replace(/_/g, '')) >= MIN_MEANINGFUL_BOUND;
  const decl = new RegExp('(?:const|let)\\s+' + token + '\\s*=\\s*([0-9_]+)').exec(joined);
  if (decl) return Number(decl[1].replace(/_/g, '')) >= MIN_MEANINGFUL_BOUND;
  return true;
}

/**
 * Compare the live population against the shrink-only baseline. Returns the
 * error strings — empty means clean. Both directions are errors: a NEW bare
 * truncation is a regression, and a baselined entry that no longer matches must
 * be removed, because a baseline that silently keeps stale entries stops being
 * a ratchet.
 */
export function validateBoundedJudgmentInput(root, baseline) {
  const found = findBareTruncationSites(root);
  const grandfathered = new Set(baseline?.grandfatheredBareTruncation || []);
  const errors = [];

  for (const site of found) {
    if (!grandfathered.has(site)) {
      errors.push(
        `${site} bounds a value with a bare .slice()/.substring() and feeds it to a prompt. Bound it ` +
          `through src/core/boundedInput.ts (boundedTail keeps the END — the newest content — and ` +
          `writes the disclosure where the consumer reads it), record the derivation of the number ` +
          `beside it, and if the cut can remove the input the decision depends on, REFUSE rather than ` +
          `disclose. If this genuinely is exempt, say why on the line: "bounded-input-reviewed: <reason>".`,
      );
    }
  }
  for (const site of grandfathered) {
    if (!found.includes(site)) {
      errors.push(
        `${site} is baselined as a bare truncation but no longer matches — remove it from the ` +
          `baseline. The baseline may only shrink.`,
      );
    }
  }
  // MECHANICAL SHRINK-ONLY (independent review 2026-08-22, finding C5). Until
  // now "the baseline may only shrink" was a sentence in a comment: the code
  // compared the live set to whatever the file happened to say, so an author
  // could add an entry and the ratchet would agree. A ceiling makes it real —
  // the population may never exceed the committed number, and lowering that
  // number is the only edit the diff will accept quietly. Raising it is a
  // visible, argued change, which is exactly what a ratchet is for.
  const ceiling = baseline?.ceiling;
  if (typeof ceiling !== 'number') {
    errors.push(
      'the baseline has no numeric `ceiling`. A shrink-only claim that nothing enforces is a ' +
        'comment, not a ratchet — add "ceiling": <current population size>.',
    );
  } else if (grandfathered.size > ceiling) {
    errors.push(
      `the baseline lists ${grandfathered.size} grandfathered sites but its ceiling is ${ceiling}. ` +
        `The baseline may only shrink: convert a site, or argue the ceiling up in the diff.`,
    );
  }

  return { errors, found };
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  let baseline;
  try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { baseline = null; }
  if (!baseline) {
    console.error('lint-bounded-judgment-input: FAILED — no baseline at docs/bounded-judgment-input-baseline.json');
    console.error('  Write it with: { "grandfatheredBareTruncation": [ ..."file:varName"... ] }  (may only shrink)');
    process.exit(1);
  }
  const { errors, found } = validateBoundedJudgmentInput(ROOT, baseline);
  if (errors.length) {
    console.error('lint-bounded-judgment-input: FAILED');
    errors.forEach((e) => console.error('  \u2717', e));
    process.exit(1);
  }
  console.log(
    `lint-bounded-judgment-input: clean — ${found.length} bare-truncation site(s) feeding a prompt, ` +
      `all grandfathered (shrink-only).`,
  );
}
