#!/usr/bin/env node
/**
 * lint-retired-article-redirects — a retired constitutional article must never strand a citation.
 *
 * Operator ruling 4a (2026-08-13) retires articles ARCHIVALLY: the article keeps its text and gains
 * a retirement record. His second condition is that retirement must not orphan the structure that
 * superseded it — "removing the structures can't break the rules because the rules are gone" — and
 * the review addendum sharpened it: a retirement that breaks a surviving citation violates that
 * condition.
 *
 * Three properties, all mechanical:
 *
 *   R1  Every retired article names a LIVE successor ("its obligations live in *X*"), and X exists
 *       and is not itself retired. A successor that is retired is a redirect into a dead end.
 *   R2  Every citation of a retired article FROM a live article carries a forwarding marker
 *       "(retired <date> → *successor*)" at the citation site. This is why the redirect is additive
 *       rather than a substitution: the citation keeps its own claim about what the retired article
 *       said, and the reader is forwarded in the same breath.
 *   R3  A retired article's forwarding marker names the SAME successor its own record names — so the
 *       two cannot drift apart as the document is edited.
 *
 * Why a lint rather than 29 careful edits: the edits are the easy half. Keeping them true through
 * every future amendment is the half that rots, and this registry's own root principle says to
 * enforce that in structure rather than in remembering.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.STANDARDS_REGISTRY_PATH || path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md');

let raw;
try { raw = fs.readFileSync(FILE, 'utf8'); } catch {
  console.log('lint-retired-article-redirects: no registry at the resolved path — skipping');
  process.exit(0);
}

const lines = raw.split('\n');
const spans = [];
let cur = null;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^### (.+)$/);
  if (m) { cur = { title: m[1].trim(), from: i + 1, to: lines.length }; spans.push(cur); continue; }
  if (/^## /.test(lines[i]) && cur) { cur.to = i; cur = null; }
}
for (let i = 0; i < spans.length; i++) {
  const next = spans[i + 1];
  if (next && next.from - 1 < spans[i].to) spans[i].to = next.from - 1;
}

const bodyOf = (s) => lines.slice(s.from, s.to);
const retiredRecord = (s) => bodyOf(s).find((l) => l.startsWith('**Retired.**'));
const retired = spans.filter((s) => retiredRecord(s));
const titles = spans.map((s) => s.title);
const errors = [];

/** short name -> successor named by the article's own retirement record */
const successor = new Map();
for (const s of retired) {
  const rec = retiredRecord(s);
  const m = rec.match(/its obligations live in \*([^*]+)\*/);
  const short = s.title.split(' — ')[0];
  if (!m) { errors.push(`R1 ${short}: retirement record names no successor`); continue; }
  const target = titles.find((t) => t === m[1] || t.startsWith(m[1]));
  if (!target) { errors.push(`R1 ${short}: successor "${m[1]}" is not an article in this registry`); continue; }
  const targetSpan = spans.find((x) => x.title === target);
  if (retiredRecord(targetSpan)) {
    errors.push(`R1 ${short}: successor "${target}" is ITSELF retired — a redirect into a dead end`);
    continue;
  }
  successor.set(short, m[1]);
}

// R2 + R3 — EVERY citation site from a live article carries a forwarding marker naming the right
// successor.
//
// The marker must sit IMMEDIATELY after the citation (allowing its own closing emphasis). Matching
// "the first marker anywhere after this citation" reads a neighbouring citation's marker when one
// line cites several retired articles — which produced a false R3 on *The User Experience Is the
// Product* the first time this lint ran. An over-broad matcher reporting a defect that is not there
// is the failure this registry keeps catching; the anchored check is the fix.
const MARK_AT = /^ \(retired \d{4}-\d{2}-\d{2} → \*([^*]+)\*\)/;
let citations = 0;
let forwarded = 0;
for (const s of spans) {
  if (retiredRecord(s)) continue;
  const body = bodyOf(s);
  for (const [short, succ] of successor) {
    for (const l of body) {
      if (l.startsWith('**Retired.**') || l.startsWith('**Retirement held.**')) continue;
      let from = 0;
      for (;;) {
        const i = l.indexOf(short, from);
        if (i < 0) break;
        const after = i + short.length;
        const close = l.slice(after).match(/^([^\s*]*\*)/);
        const at = after + (close ? close[1].length : 0);
        const m = l.slice(at).match(MARK_AT);
        citations++;
        if (!m) {
          errors.push(`R2 ${s.title.split(' — ')[0]}: cites retired "${short}" with no forwarding marker at the citation — the reader is stranded on a rule that no longer governs`);
        } else {
          forwarded++;
          if (m[1] !== succ) {
            errors.push(`R3 ${s.title.split(' — ')[0]} → ${short}: forwards to "${m[1]}" but the retirement record names "${succ}"`);
          }
        }
        from = at + (m ? m[0].length : 0);
      }
    }
  }
}

if (errors.length) {
  console.error('lint-retired-article-redirects: FAILED');
  errors.forEach((e) => console.error('  ✗', e));
  process.exit(1);
}
console.log(
  `lint-retired-article-redirects: clean — ${retired.length} retired article(s), ` +
    `${successor.size} with a live successor, ${forwarded}/${citations} inbound citation(s) forwarded.`,
);
