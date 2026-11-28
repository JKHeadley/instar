/**
 * STD-SUBCOUNTDOWN-per-item-routing-retirement ("Notices Route to the Alerts Topic, Never a New
 * One"): single-topic is the default and the only mode for new work; the legacy per-item mode is a
 * dated rollback lever, and no shipped source selects it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PER_ITEM_ROUTING_REMOVED_ON, resolveAttentionRoutingMode, setPerItemRoutingClockForTests } from '../../src/messaging/attentionRoutingMode.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const before = Date.parse(`${PER_ITEM_ROUTING_REMOVED_ON}T00:00:00Z`) - 1;
const after = before + 1;

describe('per-item attention routing retirement', () => {
  it('defaults to single-topic for a missing, unknown or explicit single-topic setting, with no notice', () => {
    for (const v of [undefined, null, '', 'single-topic', 'PER-ITEM', 'per-item ', 42]) {
      expect(resolveAttentionRoutingMode(v, before)).toEqual({ mode: 'single-topic', notice: null });
    }
  });

  it('before the removal date, per-item still works and says when it stops', () => {
    const r = resolveAttentionRoutingMode('per-item', before);
    expect(r.mode).toBe('per-item');
    expect(r.notice).toContain('deprecated');
    expect(r.notice).toContain(PER_ITEM_ROUTING_REMOVED_ON);
  });

  it('from the removal date, per-item is ignored and the notice says so', () => {
    const r = resolveAttentionRoutingMode('per-item', after);
    expect(r.mode).toBe('single-topic');
    expect(r.notice).toContain('retired');
  });

  it('the removal date is a real UTC date', () => {
    expect(PER_ITEM_ROUTING_REMOVED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isFinite(Date.parse(`${PER_ITEM_ROUTING_REMOVED_ON}T00:00:00Z`))).toBe(true);
  });

  it('no shipped source selects the per-item mode (ratchet: every quoted per-item is a known declaration)', () => {
    // Every quoted 'per-item' / "per-item" / `per-item` in every file under src/ and scripts/, pinned
    // per file. New code that sets the mode anywhere (config writers, migrations, setup, scripts,
    // skill files) adds one and fails here. Each pinned use is a type, a comment, the resolver or
    // the migration that REWRITES the old opt-in sentence.
    const expected: Record<string, number> = {
      'src/messaging/TelegramAdapter.ts': 4, // config type, field type, two comments
      'src/messaging/attentionRoutingMode.ts': 7, // the resolver and its messages
      'src/core/PostUpdateMigrator.ts': 1, // the old opt-in clause it finds and rewrites
    };
    const files: string[] = [];
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const f = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(f); }
        else if (e.isFile() && !/\.(png|jpg|jpeg|gif|ico|wasm|node|woff2?)$/i.test(e.name)) files.push(f);
      }
    };
    walk('src'); walk('scripts');
    // A gitignored build copy of docs/STANDARDS-REGISTRY.md (prose that names the deprecated mode).
    const generated = new Set(['src/data/standards-registry.md']);
    const found: Record<string, number> = {};
    for (const f of files.filter((x) => !generated.has(x))) {
      const n = (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/['"`]per-item['"`]/g) ?? []).length;
      if (n) found[f] = n;
    }
    expect(found).toEqual(expected);
  });

  it('a new agent is told the mode is deprecated, not how to switch it on', () => {
    const templates = fs.readFileSync(path.join(ROOT, 'src/scaffold/templates.ts'), 'utf8');
    expect(templates).not.toMatch(/attentionRouting = \{ "mode": "per-item" \}/);
    expect(fs.readFileSync(path.join(ROOT, 'src/data/awareness/per-item-attention-routing-retired.md'), 'utf8')).toContain(PER_ITEM_ROUTING_REMOVED_ON);
  });

  it('without an explicit time, the resolver uses its clock (pinned by the shared test setup, real otherwise)', () => {
    try {
      setPerItemRoutingClockForTests(() => Date.parse(`${PER_ITEM_ROUTING_REMOVED_ON}T00:00:00Z`));
      expect(resolveAttentionRoutingMode('per-item').mode).toBe('single-topic');
      setPerItemRoutingClockForTests(() => Date.parse('2026-12-01T00:00:00Z'));
      expect(resolveAttentionRoutingMode('per-item').mode).toBe('per-item');
    } finally {
      setPerItemRoutingClockForTests(() => Date.parse('2026-12-01T00:00:00Z'));
    }
  });
});
