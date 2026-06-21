#!/usr/bin/env node
/**
 * lint-no-wholefile-sync-read.js — Bounded Accumulation §3c (Lint 2).
 *
 * Forbids a whole-file SYNCHRONOUS read of a store the registry marks
 * `access: 'streamed'` (a store that can exceed 8MB): `JSON.parse(fs.readFileSync(p))`
 * or `fs.readFileSync(p, ...).split(...)`. Reading a multi-MB file whole on the event
 * loop is the stall this standard exists to kill (#1239; the cartographer index,
 * instar#1069). Such stores must be read by streaming / segment / SQLite.
 *
 * COVERAGE HONESTY (No Silent Degradation): this is a static guardrail, NOT complete.
 * It resolves a `streamed` store by its path BASENAME appearing as a literal near the
 * read. A read via a variable path (`fs.readFileSync(this.logPath)`) is NOT statically
 * resolvable and is NOT caught here — that gap is closed by the accessor funnel (route
 * all reads through src/core/storage/, Bounded Accumulation Increment 2). The complete
 * runtime check is the growth-burst test; this lint is the cheap forward ratchet that
 * stops a NEW literal whole-file read of a bounded store.
 *
 * Ships WARN-then-ratchet: a FROZEN baseline grandfathers today's literal hits; a NEW
 * hit fails. Exit codes: 0 pass · 1 new violation · 2 cannot-read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// --registry / --baseline / --root override the defaults (for tests + alternate checkouts).
function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const REGISTRY = path.resolve(argVal('--registry') || path.join(ROOT, 'src', 'data', 'state-coherence-registry.json'));
const BASELINE = path.resolve(argVal('--baseline') || path.join(ROOT, 'scripts', 'bounded-accumulation-wholefile-read-baseline.json'));
const SRC = path.resolve(argVal('--root') || path.join(ROOT, 'src'));

// Files exempt: the accessor + rotation definitions, and the standard's own machinery.
const EXEMPT = [/\/core\/storage\//, /\/utils\/jsonl-rotation\.ts$/];

function streamedBasenames() {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const names = new Set();
  for (const e of reg.entries || []) {
    if (e.retention && (e.retention.access === 'streamed')) {
      for (const p of e.paths || []) {
        const b = path.basename(p).replace(/\*/g, '');
        if (b && b.endsWith('.jsonl')) names.add(b);
      }
    }
  }
  return names;
}

function walk(dir, out) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, f.name);
    if (f.isDirectory()) walk(fp, out);
    else if (f.name.endsWith('.ts') && !f.name.endsWith('.test.ts')) out.push(fp);
  }
  return out;
}

// A whole-file sync read: JSON.parse(...readFileSync...) OR readFileSync(...).split
const WHOLE_READ = /(JSON\.parse\([^)]*readFileSync|readFileSync\s*\([^)]*\)\s*\.\s*split)/;

let registryBasenames;
try {
  registryBasenames = streamedBasenames();
} catch (e) {
  console.error('lint-no-wholefile-sync-read: cannot read registry: ' + e.message);
  process.exit(2);
}

let baseline = { violations: [] };
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
} catch {
  // No baseline yet → treat as empty (first run records nothing as grandfathered).
}
const baselineSet = new Set((baseline.violations || []).map((v) => v.file + '::' + v.basename));

const found = [];
for (const file of walk(SRC, [])) {
  if (EXEMPT.some((re) => re.test(file))) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!WHOLE_READ.test(line)) continue;
    // Resolve to a streamed store by a basename literal on this or the 2 lines above.
    const ctx = (lines[i - 2] || '') + '\n' + (lines[i - 1] || '') + '\n' + line;
    for (const b of registryBasenames) {
      if (ctx.includes(b)) {
        found.push({ file: path.relative(ROOT, file), basename: b, line: i + 1 });
      }
    }
  }
}

// Generate-baseline mode: record current hits as grandfathered.
if (process.argv.includes('--write-baseline')) {
  fs.writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note: 'FROZEN baseline of literal whole-file-sync reads of streamed stores at Bounded Accumulation Increment 1. May only shrink. New hits fail the lint.',
        frozenAt: '2026-06-21',
        violations: found.map((f) => ({ file: f.file, basename: f.basename })),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`lint-no-wholefile-sync-read: wrote baseline with ${found.length} grandfathered hit(s).`);
  process.exit(0);
}

const newViolations = found.filter((f) => !baselineSet.has(f.file + '::' + f.basename));
if (newViolations.length) {
  console.error('lint-no-wholefile-sync-read: FAIL — new whole-file sync read(s) of a streamed store:');
  for (const v of newViolations) {
    console.error(`  • ${v.file}:${v.line} reads ${v.basename} whole. Use streaming / segment / SQLite, or route through src/core/storage/.`);
  }
  process.exit(1);
}
console.log(
  `lint-no-wholefile-sync-read: OK — ${found.length} literal hit(s), all grandfathered (${baselineSet.size} baselined).`,
);
process.exit(0);
