/**
 * Queue pace admission rows from the executor (docs/specs/queue-pace.md §2): every start check
 * with candidates appends `{ source: 'executor', kind: 'admission', admission }` — the refusal
 * reason, or null when admitted — instead of only overwriting the single meta key.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createExecHarness, type ExecHarness } from '../../fixtures/feedbackExecuteHarness.js';

let h: ExecHarness;
afterEach(() => h?.cleanup());

describe('executor → queue pace admission rows', () => {
  it('a refused start check records its reason; an admitted one records null', async () => {
    const rows: Array<Record<string, unknown>> = [];
    h = await createExecHarness({ paceTicks: { append: (r) => { rows.push(r); } } });
    await h.workItem('c1');
    h.cfg.maxOpenPrs = 0;
    await h.exec.tick();
    expect(rows.at(-1)).toEqual({ source: 'executor', kind: 'admission', admission: 'max-open-prs' });
    h.cfg.maxOpenPrs = 4;
    h.fixWith({ 'src/thing.ts': 'x' });
    h.now.value += 60_000;
    await h.exec.tick();
    expect(rows.at(-1)).toEqual({ source: 'executor', kind: 'admission', admission: null });
  });
});
