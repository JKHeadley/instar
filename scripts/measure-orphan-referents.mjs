#!/usr/bin/env node
/**
 * COMMITTED after review pass 15 finding 12: the constitution publishes a table of counts and cites
 * "two independent replays", but the instrument was not in the repository — evidence a reader could not
 * follow, which is the exact shape *Deferral = Deletion* forbids, in the article that states it.
 *
 * Second measurement, using the guard's EXACT rules this time — imported verbatim, not re-typed.
 * Pass 13 falsified the first attempt: it used a 1-character-minimum token rule (so a bare `4`
 * counted as an identifier) where the guard requires 3, and included `#` while excluding `/`.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// VERBATIM from scripts/lint-deferral-referent-resolves.mjs:124-127.
const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._/-]{2,}/g;
const isIdShaped = (t) => /\d/.test(t);
const idPattern = (id) => new RegExp(`(?:^|[^A-Za-z0-9._/-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._/-])`);

const PROSE_EXT = /\.(md|markdown|txt|rst|adoc)$/i;
const HANDLED_EXT = /\.(m?[jt]sx?|c[jt]s|json|jsonl|ya?ml|sh|bash|zsh|toml)$/i;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((s) => s.trim()).filter(Boolean);
const resolving = files.filter((f) => !f.startsWith('docs/') && !f.includes('node_modules/')
  && !PROSE_EXT.test(f) && HANDLED_EXT.test(f));

const orphans = JSON.parse(fs.readFileSync('docs/deferral-referent-baseline.json', 'utf8')).orphans;
const toks = (id) => (id.match(TOKEN_RE) ?? []).filter(isIdShaped);

const noToken = orphans.filter((o) => toks(o).length === 0);
const withToken = orphans.filter((o) => toks(o).length > 0);

const looksBinary = (buf) => {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return true;
  let n = 0;
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) n += 1;
  return head.length > 0 && n / head.length > 0.05;
};

// ALL tokens must be seen somewhere in the corpus — the guard's rule.
const seen = new Map(withToken.map((o) => [o, new Set()]));
for (const rel of resolving) {
  let buf; try { buf = fs.readFileSync(rel); } catch { continue; }
  if (looksBinary(buf)) continue;
  const text = buf.toString('utf8'); // comment-stripping OFF — that is the question
  for (const o of withToken) {
    const t = toks(o);
    for (let i = 0; i < t.length; i += 1) if (idPattern(t[i]).test(text)) seen.get(o).add(i);
  }
}
const resolvedAnywhere = withToken.filter((o) => seen.get(o).size === toks(o).length);

// Where does each resolve?
const where = new Map();
for (const rel of resolving) {
  let buf; try { buf = fs.readFileSync(rel); } catch { continue; }
  if (looksBinary(buf)) continue;
  const text = buf.toString('utf8');
  for (const o of resolvedAnywhere) {
    if (toks(o).every((t) => idPattern(t).test(text))) {
      if (!where.has(o)) where.set(o, []);
      where.get(o).push(rel);
    }
  }
}
const inSrcTests = resolvedAnywhere.filter((o) =>
  (where.get(o) ?? []).some((p) => p.startsWith('src/') || p.startsWith('tests/')));

console.log('orphans in baseline:               ', orphans.length);
console.log('carry NO id-shaped token (guard rule):', noToken.length);
console.log('resolve anywhere w/o comment-strip:', resolvedAnywhere.length);
console.log('  ...of those, in src/ or tests/:  ', inSrcTests.length);
console.log('cross-check, 217 - with-token:     ', 217 - (orphans.length - noToken.length + 16), '(should reconcile with "4 of 168")');
