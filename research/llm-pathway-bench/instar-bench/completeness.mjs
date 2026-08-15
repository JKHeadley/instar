// Report per-pathway sample counts across the two runs, and what still needs the floor.
import { readFileSync, existsSync } from 'node:fs';
const R = 'results/instar-bench';
function load(p) { return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
const r8 = load(`${R}/r8-instar-bench/raw.jsonl`);
const r8b = load(`${R}/r8b-instar-bench/raw.jsonl`);
const allPw = [...new Set([...r8, ...r8b].map((r) => r.pathway))].sort();
const count = (rows, pw) => rows.filter((r) => r.pathway === pw).length;
const okRate = (rows, pw) => { const s = rows.filter((r) => r.pathway === pw); return s.length ? (s.filter((r) => r.ok).length / s.length) : 0; };
console.log('pathway                     r8   r8b(512)  r8b-ok   needsFloorRerun');
for (const pw of allPw) {
  const c8 = count(r8, pw), c8b = count(r8b, pw);
  const ok8 = okRate(r8, pw), ok8b = okRate(r8b, pw);
  // A pathway is "done well" if r8b has full 69 rows with good ok-rate.
  const r8bDone = c8b >= 69 && ok8b > 0.9;
  // Terse models already valid in r8 (high ok-rate, no truncation): don't need floor.
  const terseValid = ok8 > 0.95 && c8 >= 69;
  const need = !r8bDone && !terseValid;
  console.log(`${pw.padEnd(26)} ${String(c8).padStart(3)}  ${String(c8b).padStart(4)}     ${ok8b.toFixed(2)}     ${need ? 'YES' : (r8bDone ? 'no(r8b-done)' : 'no(terse-r8)')}`);
}
