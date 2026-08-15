/**
 * Method-scoped atomicity analysis for the atomic-writes consistency check.
 *
 * WHY THIS EXISTS
 * ---------------
 * The original check tracked `inSaveMethod` with a flag that was set when a
 * method NAME appeared on a line and was never set back to false. Its
 * `hasWriteFile`/`hasRename` booleans were re-zeroed at each name occurrence,
 * so the assertion at the end of the loop reflected only the window between the
 * LAST method-name mention and EOF — 125 of 617 lines (20%) in StateManager.ts,
 * leaving three of its four declared methods structurally unreachable. Within
 * that window the two booleans were file-scope, so a `renameSync` anywhere
 * satisfied a `writeFileSync` anywhere, in a different method.
 *
 * Measured consequence: a bare, non-atomic `fs.writeFileSync` of durable session
 * state, inserted into `saveSession` — a DECLARED method of a DECLARED module —
 * passed all 21 tests. The check could not fail on its own subject.
 *
 * These helpers replace the flag with brace-matched method bodies, and resolve
 * ONE level of `this.helper()` delegation so a module that funnels its writes
 * through a private `atomicWrite()` is verified through the funnel rather than
 * passing trivially because its own body contains no write call.
 *
 * SCOPE, stated rather than implied: this is source-text analysis, not a
 * TypeScript symbol graph. Delegation resolves one level, within one file.
 */

/** A method body located by brace matching, with the line its declaration starts on. */
export interface MethodBody {
  /** 1-indexed line of the declaration. */
  line: number;
  /** Body text INCLUDING the outer braces. */
  text: string;
}

export type AtomicityVerdict =
  | 'atomic-inline' // writes and renames in its own body
  | 'atomic-via-funnel' // no direct write; delegates to an in-file body that is atomic-inline
  | 'non-atomic' // a write with no rename on the resolved path
  | 'no-write'; // neither writes nor delegates to anything that writes

export interface MethodClassification {
  found: boolean;
  verdict: AtomicityVerdict | null;
  /** Where the deciding write lives — the method itself, or the helper it delegates to. */
  via: string | null;
  line: number | null;
}

/**
 * Remove `//` and block comments while preserving line count and never touching
 * text inside string or template literals.
 *
 * Comment-stripping is load-bearing in BOTH directions here: a commented-out
 * `writeFileSync` must not count as a write (false alarm), and — the reason this
 * function exists at all — a comment mentioning `renameSync` beside a bare write
 * must not launder that write into looking atomic.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (quote) {
      if (c === '\\') {
        out += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue; // the newline itself is emitted by the next iteration
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'; // preserve line numbering
        i += 1;
      }
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/**
 * Brace-matched bodies of every declaration of `method` in `src`.
 *
 * Only DECLARATIONS are returned, never call sites: a line such as
 * `this.saveSession({...})` is a call, and treating it as a declaration is how
 * the original check conflated one method's write with another's rename.
 * Brace depth is tracked string-aware so a `{` inside a literal cannot
 * desynchronise the match; an unbalanced body yields nothing rather than a
 * wrong region, so a syntax error elsewhere can never become a false verdict.
 */
export function methodBodies(src: string, method: string): MethodBody[] {
  const clean = stripComments(src);
  const bodies: MethodBody[] = [];

  // A declaration is `name(` whose preceding non-space token opens a member
  // position — start of file, `{`, `}` or `;` — after skipping any modifiers.
  // Deciding by the PRECEDING token rather than by line position is what rejects
  // `this.saveSession(` and `helper(save(1))` as calls while still accepting a
  // declaration that does not begin its own line.
  const declRe = new RegExp(String.raw`\b` + escapeRe(method) + String.raw`\s*\(`, 'g');
  const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'async', 'readonly', 'override']);

  let m: RegExpExecArray | null;
  while ((m = declRe.exec(clean)) !== null) {
    if (!opensMemberPosition(clean, m.index, MODIFIERS)) continue;
    const open = clean.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;

    let depth = 0;
    let quote: string | null = null;
    let end = -1;

    for (let j = open; j < clean.length; j += 1) {
      const c = clean[j];
      if (quote) {
        if (c === '\\') {
          j += 1;
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    if (end < 0) continue; // unbalanced — fail toward NOT reporting a region
    bodies.push({ line: clean.slice(0, m.index).split('\n').length, text: clean.slice(open, end + 1) });
  }

  return bodies;
}

/** `this.helper(` call targets inside a body. */
export function delegateTargets(body: string): string[] {
  const out = new Set<string>();
  const re = /\bthis\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out];
}

const writesDirectly = (body: string) => /\bwriteFileSync\s*\(/.test(body);
const renamesDirectly = (body: string) => /\brenameSync\s*\(/.test(body);

/**
 * Classify a declared state-writing method.
 *
 * The invariant: a write on the method's resolved path must be paired with a
 * rename IN THE SAME BODY. Per-body pairing is the whole point — a rename in a
 * sibling method proves nothing about this one.
 */
export function classifyMethod(src: string, method: string): MethodClassification {
  const bodies = methodBodies(src, method);
  if (bodies.length === 0) return { found: false, verdict: null, via: null, line: null };

  let best: MethodClassification | null = null;

  for (const body of bodies) {
    let verdict: AtomicityVerdict;
    let via: string | null = null;

    if (writesDirectly(body.text)) {
      verdict = renamesDirectly(body.text) ? 'atomic-inline' : 'non-atomic';
      via = method;
    } else {
      verdict = 'no-write';
      for (const target of delegateTargets(body.text)) {
        if (target === method) continue; // recursion is not resolution
        const helpers = methodBodies(src, target);
        for (const helper of helpers) {
          if (!writesDirectly(helper.text)) continue;
          via = target;
          verdict = renamesDirectly(helper.text) ? 'atomic-via-funnel' : 'non-atomic';
          break;
        }
        if (verdict !== 'no-write') break;
      }
    }

    const candidate: MethodClassification = { found: true, verdict, via, line: body.line };
    // Report the WORST verdict across overloads/duplicate declarations: a single
    // non-atomic path is the finding, and letting a clean sibling mask it would
    // reintroduce exactly the conflation this replaces.
    if (!best || rank(verdict) > rank(best.verdict!)) best = candidate;
  }

  return best!;
}

function rank(v: AtomicityVerdict): number {
  return v === 'non-atomic' ? 3 : v === 'atomic-inline' || v === 'atomic-via-funnel' ? 2 : 1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the text immediately before `index` puts this occurrence in a
 * member-declaration position rather than a call position.
 *
 * Walks back over whitespace and any modifier keywords, then inspects the first
 * real character. `.` means a method CALL (`this.saveSession(`), `(` or `,` mean
 * an argument (`helper(save(1))`), `=` means an assignment — none of which
 * declare the method being looked for.
 */
function opensMemberPosition(src: string, index: number, modifiers: Set<string>): boolean {
  let i = index - 1;

  for (;;) {
    while (i >= 0 && /\s/.test(src[i])) i -= 1;
    if (i < 0) return true; // start of file

    // Step back over a preceding modifier keyword, then re-test what precedes it.
    let end = i;
    while (i >= 0 && /[A-Za-z]/.test(src[i])) i -= 1;
    const word = src.slice(i + 1, end + 1);
    if (word && modifiers.has(word)) continue;

    const ch = src[end];
    return ch === '{' || ch === '}' || ch === ';';
  }
}
