#!/usr/bin/env node
/**
 * Telegram egress boundary.
 *
 * WHAT CHANGED, AND WHY IT IS A DIFFERENT KIND OF CHECK
 *
 * Its predecessor (`lint-telegram-send-funnel-guarded.mjs`) asked a question about SENDERS: for each
 * one, is the guard present, imported, and in the right order? Review passes 34 and 35 showed that
 * question cannot be answered without work that lint was not doing — it could not prove a call
 * resolved to the imported guard (an unused import plus a shadowing local satisfied both halves), and
 * it could only classify API methods written as direct string literals.
 *
 * Both gaps are properties of the QUESTION, not bugs in the answer. Asking "is each of six senders
 * guarded" requires binding resolution and method inference. Asking "may anyone but the door reach
 * the network" requires neither: a decoy import creates no `fetch`, and a method passed through a
 * variable still travels in a URL. Moving the boundary made the hard sub-problems disappear rather
 * than solving them, which is why this replaces its predecessor instead of extending it.
 *
 * WHAT IT PROVES
 *   1. Exactly one file may call `fetch` on a Telegram Bot API URL: src/messaging/telegram-egress.ts.
 *   2. That file runs the visibility check before its `fetch`.
 *
 * WHAT IT DOES NOT PROVE, stated because the previous version's claims outran its analysis:
 *   - It resolves a URL through a LOCAL declaration or a local helper only. A Bot API URL assembled
 *     in another module and imported would not be recognised.
 *   - It follows a `fetch` stored in a LOCAL variable declaration (added 2026-08-14), but NOT one
 *     re-assigned after declaration, arriving as a function parameter, or imported as a wrapper from
 *     another module.
 *   All are narrower than the gaps they replace, and all are named here rather than discovered.
 *
 * WHERE THIS ENDS AND THE TESTS BEGIN — established by sabotage, not by assumption. Breaking the
 * door's OWN url-to-method recogniser (so it silently skips the check on every send) leaves this lint
 * CLEAN: the boundary is intact, nobody bypasses the door, and the door still calls the guard before
 * fetching. What changed was the guard's ARGUMENT, which is behaviour, not structure.
 *
 * That case is covered by tests/unit/telegram-egress-boundary.test.ts — the same sabotage reds the
 * method-recovery test and the refusal tests there (measured; an earlier version of this comment
 * claimed 7, which counted failures across TWO files and was corrected by review pass 36 finding 8 —
 * a number asserted from a run I had not scoped to the file I was naming). So: this lint answers
 * "may anyone reach the network without passing the door", the tests
 * answer "does the door actually check what passes through it". Neither covers the other, and a
 * reader who assumed this file alone protected the guarantee would be wrong in a way that only shows
 * up when it matters.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DOOR = path.join(SRC, 'messaging', 'telegram-egress.ts');
// Both Bot API shapes: the method host and the FILE-download host. The marker covered only the
// first, so three direct file fetches in the live tree were invisible while the lint printed
// categorical confinement (pass 39 F8).
const HOST_MARK = 'api.telegram.org/';
const hasHostMark = (t) => t.toLowerCase().includes(HOST_MARK);
const GUARD = 'assertOutgoingPayloadVisible';

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    // `.js` and `.mjs` are executable too, and scanning only `.ts` meant a direct Bot API fetch in
    // either was invisible while this printed categorical confinement (pass 40 F3).
    else if (e.isFile() && /\.(ts|js|mjs|cjs)$/.test(p)) out.push(p);
  }
  return out;
}

const parse = (f, text) => ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);

/**
 * Does this expression denote a Telegram Bot API URL? Checks the expression's own text, then — if it
 * is a bare identifier or a call to a local helper — the text of that binding's local declaration.
 */
function denotesBotApiUrl(node, sf) {
  if (!node) return false;
  if (hasHostMark(node.getText(sf))) return true;

  // Review pass 37 finding 4: a URL built by CONCATENATION — `api('getUpdates') + '?limit=5'` —
  // is a binary expression, and the live tree already contained two. The lint printed
  // "confined" while direct Bot API fetches existed in src/. Recurse through `+`.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return denotesBotApiUrl(node.left, sf) || denotesBotApiUrl(node.right, sf);
  }
  if (ts.isParenthesizedExpression(node)) return denotesBotApiUrl(node.expression, sf);

  const nameOf = (n) => (ts.isIdentifier(n) ? n.text
    : ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? n.expression.text
      : null);
  const name = nameOf(node);
  if (!name) return false;

  let found = false;
  const seek = (n) => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === name && n.initializer) {
      if (hasHostMark(n.initializer.getText(sf))) found = true;
    }
    ts.forEachChild(n, seek);
  };
  seek(sf);
  return found;
}

/**
 * A call that reaches the network. Review pass 36 finding 4: the first version matched ONLY a bare
 * identifier `fetch`, so `globalThis.fetch(...)` — an ordinary way to write the same call — was
 * invisible to a lint whose headline claim is "exactly one file". A property access whose final name
 * is `fetch` counts too.
 *
 * Alias resolution ADDED 2026-08-14 (a peer-agent audit ranked this check #2 of 25 defeatable by
 * renaming, and this header had honestly named its own gap): a fetch bound to a DIFFERENT name
 * (`const send = fetch; send(url)`) is now caught, resolved on the AST via collectFetchAliases and
 * followed to a fixpoint so `const a = fetch; const b = a;` closes too. A computed member on a
 * string literal (`x['fetch']`) was already covered.
 *
 * Still NOT covered, said plainly rather than left for the next reading to find: re-assignment after
 * declaration, a fetch arriving as a function PARAMETER, and a wrapper imported from another module.
 * Those need flow and cross-module analysis this does not do. The claim below is written to match
 * this scope.
 */
function isFetchCall(n, aliases = EMPTY_ALIASES) {
  if (!ts.isCallExpression(n)) return false;
  const e = n.expression;
  if (ts.isIdentifier(e)) return e.text === 'fetch' || aliases.has(e.text);
  if (ts.isPropertyAccessExpression(e)) {
    // `fetch.call(...)` / `fetch.apply(...)` are direct invocations of fetch, and `x['fetch']` is a
    // property access spelled differently (pass 40 F3).
    if (e.name.text === 'call' || e.name.text === 'apply') return isFetchTarget(e.expression, aliases);
    return e.name.text === 'fetch';
  }
  if (ts.isElementAccessExpression(e)) {
    const a = e.argumentExpression;
    return !!a && ts.isStringLiteralLike(a) && a.text === 'fetch';
  }
  return false;
}

/** Is this expression the `fetch` function itself (for `.call`/`.apply` forms)? */
function isFetchTarget(e, aliases = EMPTY_ALIASES) {
  if (ts.isIdentifier(e)) return e.text === 'fetch' || aliases.has(e.text);
  if (ts.isPropertyAccessExpression(e)) return e.name.text === 'fetch';
  return false;
}

const EMPTY_ALIASES = new Set();

/**
 * Local names bound to `fetch` in this file, resolved to a fixpoint so a chain
 * (`const a = fetch; const b = a;`) closes too.
 *
 * This closes the gap the header above named plainly and left open: a fetch
 * bound to a DIFFERENT name. Done on the AST rather than by text, because the
 * file is already parsed — a variable declaration whose initialiser IS the
 * fetch function is unambiguous, where a regex over `= fetch` would also match
 * a property called fetch on an unrelated object.
 *
 * Deliberately NOT resolved: re-assignment after declaration, parameters, and
 * imports of a wrapper from another module. Those need flow/cross-module
 * analysis; the claim stays scoped to what is actually checked.
 */
export function collectFetchAliases(sf) {
  const names = new Set();
  const decls = [];
  const walkNode = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      decls.push([n.name.text, n.initializer]);
    }
    ts.forEachChild(n, walkNode);
  };
  walkNode(sf);
  for (let pass = 0; pass < 10; pass++) {
    const before = names.size;
    for (const [name, init] of decls) {
      if (isFetchTarget(init, names)) names.add(name);
    }
    if (names.size === before) break;
  }
  return names;
}

// ── CLI body ─────────────────────────────────────────────────────────────
// Guarded so collectFetchAliases can be imported by tests WITHOUT running the
// scan: this module has four process.exit(1) paths, so an unguarded import
// would kill any test run the moment the repo had a violation. Same pattern as
// scripts/eli16-pr-description-check.mjs.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
const violations = [];
let doorSeen = false;

for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, 'utf-8');
  // Case-INSENSITIVE prefilter: it was lowercase-only, so an upper-case host skipped the file
  // entirely and the recogniser's case-insensitivity never ran (pass 39 F5).
  if (!text.toLowerCase().includes('api.telegram.org')) continue;
  const sf = parse(file, text);
  const isDoor = path.resolve(file) === DOOR;
  const aliases = collectFetchAliases(sf);

  const visit = (n) => {
    if (isFetchCall(n, aliases) && ts.isCallExpression(n)) {
      if (denotesBotApiUrl(n.arguments[0], sf)) {
        if (isDoor) doorSeen = true;
        else {
          violations.push({
            file,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            snippet: n.arguments[0] ? n.arguments[0].getText(sf).replace(/\s+/g, ' ').slice(0, 60) : '',
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

if (!fs.existsSync(DOOR)) {
  console.error('[telegram-egress] FAIL — the door itself is missing: src/messaging/telegram-egress.ts');
  process.exit(1);
}

// The door must guard BEFORE it reaches the network. Positions, not statement order: the `fetch` may
// sit inside a nested expression, and an index-based comparison silently selected the wrong function
// when this was tried on the previous lint (review pass 35).
{
  const text = fs.readFileSync(DOOR, 'utf-8');
  const sf = parse(DOOR, text);
  const posOf = (name) => {
    let at = -1;
    const seek = (n) => {
      if (at < 0 && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
        at = n.getStart(sf);
      }
      if (at < 0) ts.forEachChild(n, seek);
    };
    seek(sf);
    return at;
  };
  const g = posOf(GUARD);
  const f = posOf('fetch');
  if (g < 0 || f < 0 || g > f) {
    console.error(
      `[telegram-egress] FAIL — the door does not check before it sends.\n`
      + `  ${GUARD} at ${g}, fetch at ${f} in src/messaging/telegram-egress.ts.\n`
      + `  Every sender now relies on this one call. If it does not run first, nothing is checked.`,
    );
    process.exit(1);
  }
  // The door's own URL is a PARAMETER, so it is correctly unrecognisable to the URL test — the door
  // is the door by identity, not by what its argument looks like. `doorSeen` therefore proves nothing
  // here, and the first run of this lint failed on exactly that mistake.
  //
  // The real hazard is silent blindness: if `denotesBotApiUrl` ever stops recognising a Bot API URL,
  // every file passes and the boundary evaporates with a clean green line. So test the RECOGNISER on
  // known-positive and known-negative sources before trusting its verdict on real files. A lint that
  // cannot demonstrate it can still see is not entitled to report clean.
  const canaries = [
    ['inline template', 'const r = fetch(`https://api.telegram.org/bot${t}/sendMessage`, {});', true],
    ['local variable', 'const u = `https://api.telegram.org/bot${t}/sendMessage`; fetch(u, {});', true],
    ['local helper', "const api = (m) => `https://api.telegram.org/bot${t}/${m}`; fetch(api('sendMessage'), {});", true],
    ['concatenated helper + query', "const api = (m) => `https://api.telegram.org/bot${t}/${m}`; fetch(api('getUpdates') + '?x=1', {});", true],
    ['upper-case host', 'fetch(`https://API.TELEGRAM.ORG/bot${t}/sendMessage`, {});', true],
    ['unrelated host', 'fetch(`https://example.invalid/x`, {});', false],
    ['peer mesh call', 'const u = `${peer.url}/sessions`; fetch(u, {});', false],
    ['property-access fetch', 'globalThis.fetch(`https://api.telegram.org/bot${t}/sendMessage`, {});', true],
  ];
  for (const [label, code, expected] of canaries) {
    const csf = parse('canary.ts', code);
    let saw = false;
    const seek = (n) => {
      if (isFetchCall(n) && denotesBotApiUrl(n.arguments[0], csf)) saw = true;
      ts.forEachChild(n, seek);
    };
    seek(csf);
    if (saw !== expected) {
      console.error(
        `[telegram-egress] FAIL — the URL recogniser is wrong on a ${label} canary `
        + `(expected ${expected}, got ${saw}).\n`
        + '  Every verdict this lint produces depends on that recogniser, so it reports nothing until\n'
        + '  it can prove it still sees. Fix `denotesBotApiUrl`, not the canary.',
      );
      process.exit(1);
    }
  }
  void doorSeen;
}

if (violations.length > 0) {
  console.error('[telegram-egress] FAIL — Telegram Bot API reached outside the single door:\n');
  for (const v of violations) {
    console.error(`  ${path.relative(ROOT, v.file)}:${v.line}  fetch(${v.snippet})`);
  }
  console.error(
    '\n  Import `telegramFetch` from src/messaging/telegram-egress.ts and call it instead of `fetch`.'
    + '\n  Every Bot API send carrying a body must pass one door, so that "is the payload checked" is a'
    + '\n  question about one function rather than about every sender that exists now or later.',
  );
  process.exit(1);
}

console.log(
  'lint-telegram-egress-boundary: clean — Telegram Bot API egress is confined to '
  + 'src/messaging/telegram-egress.ts, which checks the serialised body before sending.',
);

}
