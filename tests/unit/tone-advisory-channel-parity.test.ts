import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Channel-parity ratchet for the tone-gate advisory migration.
 *
 * The review found the reaction metadata plumbed into 2 of 7 outbound
 * callsites. That is a silent failure: the other five would return a
 * `422 tone-gate-advisory` whose `howToProceed` PROMISES an override the route
 * structurally cannot accept, so the agent loops with nowhere to go — and the
 * decision-quality sample quietly becomes "whatever happened on Telegram".
 *
 * Per-callsite duplication is how that happened, so the fix is one shared
 * helper plus this ratchet: every `checkOutboundMessage` callsite either spreads
 * `toneAdvisoryMetadata(...)` or is named below with the reason it cannot.
 *
 * This reads SOURCE rather than exercising HTTP on purpose — it is asserting a
 * property of the callsite SET, which is exactly the thing a behavioural test
 * per route cannot notice the absence of.
 */
const ROUTES = path.join(process.cwd(), 'src/server/routes.ts');

/**
 * Callsites with no agent-supplied `metadata` surface to carry a reaction.
 * Each entry is a deliberate exemption, not an omission.
 */
const EXEMPT: ReadonlyArray<{ channel: string; marker: string; why: string }> = [
  {
    channel: 'telegram',
    marker: "checkOutboundMessage(candidate, 'telegram', res, {",
    why: 'the attention route composes its own item text — there is no agent request metadata to carry an ack, and an attention item has no re-send path',
  },
];

/**
 * The callsite's option object, delimited by brace matching rather than a fixed
 * character window. A fixed window silently truncates a callsite with a long
 * explanatory comment and reports it as missing — a false positive that would
 * teach the next author to delete the comment or the test.
 */
function optionBlockAfter(src: string, index: number): string {
  const open = src.indexOf('{', index);
  if (open === -1) return src.slice(index, index + 400);
  let depth = 0;
  for (let i = open; i < src.length && i < open + 4000; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(index, i + 1);
    }
  }
  return src.slice(index, index + 4000);
}

describe('tone-advisory channel parity', () => {
  const src = fs.readFileSync(ROUTES, 'utf-8');

  it('every checkOutboundMessage callsite carries the reaction metadata or is a named exemption', () => {
    const callsites: Array<{ line: number; snippet: string }> = [];
    const needle = 'await checkOutboundMessage(';
    let from = 0;
    for (;;) {
      const i = src.indexOf(needle, from);
      if (i === -1) break;
      from = i + needle.length;
      callsites.push({
        line: src.slice(0, i).split('\n').length,
        snippet: optionBlockAfter(src, i),
      });
    }

    // Guard the guard: if the needle stops matching, this test would pass
    // vacuously while covering nothing.
    expect(callsites.length).toBeGreaterThanOrEqual(5);

    const missing = callsites.filter(({ snippet }) => {
      if (snippet.includes('toneAdvisoryMetadata(')) return false;
      if (snippet.includes('toneAdvisoryAck')) return false;
      return !EXEMPT.some((e) => snippet.includes(e.marker.slice('checkOutboundMessage('.length)));
    });

    expect(
      missing.map((m) => `routes.ts:${m.line}`),
      'outbound callsites missing the tone-advisory reaction metadata',
    ).toEqual([]);
  });

  it('the shared helper exists — parity is one edit, not seven', () => {
    expect(src).toContain('function toneAdvisoryMetadata(');
  });

  it('every exemption states why it cannot carry a reaction', () => {
    for (const e of EXEMPT) {
      expect(e.why.length, e.channel).toBeGreaterThan(30);
    }
  });
});
