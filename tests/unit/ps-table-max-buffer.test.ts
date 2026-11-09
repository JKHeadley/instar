/**
 * Every read of the full process table that includes command lines must raise
 * node's 1 MiB default output buffer. On a busy host that output passes 1 MiB,
 * the call fails with ENOBUFS, and the caller's fallback quietly takes over
 * (SessionManager's probes then "assume active", so idle sessions are never
 * reaped or drained). Seen as `spawnSync ps ENOBUFS` on the Studio verifier,
 * 2026-11-08.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// A `ps` call whose argument list selects every process (-e, -A, -ax...) and
// prints the command column.
const PS_CALL = /\(\s*'ps'\s*,\s*\[([^\]]*)\]/g;

describe('full process-table reads raise the output buffer', () => {
  it('every all-process ps read with command lines passes maxBuffer', () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(PS_CALL)) {
        const args = m[1];
        const allProcs = /'-(e|A|ax)[a-z]*'/.test(args);
        const withCommand = /command/.test(args);
        if (!allProcs || !withCommand) continue;
        const options = text.slice(m.index! + m[0].length, m.index! + m[0].length + 300);
        if (!/maxBuffer/.test(options.split(/\)\s*[;)]/)[0])) {
          const line = text.slice(0, m.index).split('\n').length;
          missing.push(`${path.relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
