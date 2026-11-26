/**
 * Ratchet: the templates.js import in PostUpdateMigrator stays one-symbol-per-line.
 *
 * That single import is the file's merge hot-spot — every change adding a CLAUDE.md awareness
 * marker appends a symbol to it. While it was one long line, two branches adding different symbols
 * ALWAYS collided on the same line (hand-resolved five times on 2026-10-21 alone, and the operator
 * saw the resulting conflicts on consecutive PRs). One symbol per line lets git merge two additions
 * without help. This test exists so a future tidy-up cannot silently collapse it back.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = path.join(process.cwd(), 'src', 'core', 'PostUpdateMigrator.ts');

describe('PostUpdateMigrator templates.js import shape', () => {
  it('is a multi-line import with exactly one symbol per line, and no duplicates', () => {
    const src = fs.readFileSync(SOURCE, 'utf-8');
    const m = /^import \{\n([\s\S]*?)\n\} from '\.\.\/scaffold\/templates\.js';$/m.exec(src);
    expect(
      m,
      "the templates.js import must be a multi-line `import {\\n  Sym,\\n} from '../scaffold/templates.js';` " +
        'block — a single-line import makes every concurrent symbol addition conflict on the same line',
    ).not.toBeNull();
    const lines = (m![1]).split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    // Exactly one symbol per line: each line is `Symbol,` and never carries a second comma.
    for (const line of lines) expect(line, `one symbol per line, got: ${line}`).toMatch(/^[A-Za-z_$][\w$]*,$/);
    const symbols = lines.map((l) => l.slice(0, -1));
    expect(new Set(symbols).size, 'no duplicate symbols').toBe(symbols.length);
  });

  it('every imported symbol is actually used in the file (the split did not strip or invent one)', () => {
    const src = fs.readFileSync(SOURCE, 'utf-8');
    const m = /^import \{\n([\s\S]*?)\n\} from '\.\.\/scaffold\/templates\.js';$/m.exec(src);
    const symbols = (m![1]).split('\n').map((l) => l.trim().replace(/,$/, '')).filter(Boolean);
    const body = src.slice((m!.index ?? 0) + m![0].length);
    const unused = symbols.filter((s) => !new RegExp(`\\b${s}\\b`).test(body));
    expect(unused, `imported but unused: ${unused.join(', ')}`).toEqual([]);
  });
});
