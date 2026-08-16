/**
 * Unit — the dark-ship surface list must never have its count restated in prose.
 *
 * WHY THIS EXISTS. This one enumeration has drifted FIVE times across the
 * grok-build review:
 *   round 12 → the list said four
 *   round 18 → four became six
 *   round 19 → the count was corrected while its LIST was left at four
 *   round 21 → six became thirteen (a reviewer constructed the state the
 *              invariant called impossible and found seven more)
 *   round 22 → I fixed a stale "six" at a citation site, wrote "do not restate
 *              the number here, cite the invariant" — and then, forty minutes
 *              later, ADDED a fourteenth entry and made four other sentences
 *              stale, including that one.
 *
 * Every previous repair fixed the instance. The pattern this branch keeps
 * producing is "fix the instance, leave the check unbuilt", and a count repeated
 * in five sentences is a count that drifts in four. So the rule is now
 * structural rather than remembered: **the list IS the count.** Prose cites the
 * invariant; anything needing a number counts the items.
 *
 * SCOPE, stated honestly. This checks the LIVE claim forms — a number-word
 * immediately qualifying "surfaces" — and deliberately does NOT touch the
 * historical narrative ("the list was six and the true number is thirteen"),
 * which is accurate as history and worth keeping. So it cannot catch every
 * conceivable restatement, only the shapes that have actually recurred. That is
 * the honest bound, not a claim of completeness.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SPEC = path.resolve(__dirname, '../../docs/specs/grok-build-framework-integration.md');
const spec = fs.readFileSync(SPEC, 'utf-8');

const NUMBER_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|\\d+)';

/**
 * The live claim shapes, all of which have appeared in this document:
 *   "THIRTEEN surfaces change for every agent"
 *   "names the THIRTEEN surfaces that DO change"
 *   "None of the thirteen registers an adapter"
 *   "One of the thirteen (entry 11) CAN spend"
 */
const LIVE_COUNT_CLAIMS = new RegExp(
  `(?:${NUMBER_WORD}\\s+surfaces\\s+(?:that\\s+)?(?:DO\\s+)?change`
    + `|(?:None|One|Each|Any)\\s+of\\s+the\\s+${NUMBER_WORD}\\b)`,
  'gi',
);

/** Lines that are explicitly quoting or narrating a PAST state. */
function isHistoricalNarration(line: string): boolean {
  return /It read:|previously (?:read|said)|the list was|used to say|once said|became|corrected round|CORRECTED ROUND|drifted/i.test(line);
}

/*
 * KNOWN OVER-BREADTH, left deliberately (2026-08-15). This matcher cannot tell
 * WHICH count a prose number restates. It fired on "one of the two
 * `buildHeadlessLaunch` call sites" — a sentence about the headless-entrypoint
 * census, nothing to do with the surface list. The prose was reworded rather than
 * the matcher narrowed: it has caught five real drifts, its false positive cost
 * one rewording and was reported instantly and unambiguously. An over-broad guard
 * with immediate, legible feedback is a good trade; narrowing it to chase a
 * harmless false positive would trade a caught defect for tidiness.
 */
describe('dark-ship surface list — the count lives in the list, not in prose', () => {
  it('CONTROL: the detector fires on every shape that actually shipped', () => {
    // The four real stale sentences from this document's history, verbatim.
    const shipped = [
      'round-18, CORRECTED ROUND-21): THIRTEEN surfaces change',
      'precisely and names the THIRTEEN surfaces that DO change for every agent',
      'None of the thirteen registers an adapter, spawns grok, or spends anything',
      '- **One of the thirteen (entry 11) CAN spend**, on a framework',
    ];
    for (const line of shipped) {
      expect([...line.matchAll(LIVE_COUNT_CLAIMS)].length, line).toBeGreaterThan(0);
    }
  });

  it('CONTROL: the detector spares historical narration and number-free prose', () => {
    const allowed = [
      'the surfaces enumerated below change for every agent regardless of opt-in',
      'names the surfaces that DO change for every agent',
      '**None of them registers the grok adapter**',
    ];
    for (const line of allowed) {
      expect([...line.matchAll(LIVE_COUNT_CLAIMS)].length, line).toBe(0);
    }
    // And history is exempted by the narration guard rather than by the regex.
    expect(isHistoricalNarration('ROUND-21: the list was six and the true number is thirteen.')).toBe(true);
  });

  it('the spec restates no live count for the surface list', () => {
    const offenders: string[] = [];
    spec.split('\n').forEach((line, i) => {
      if (isHistoricalNarration(line)) return;
      for (const m of line.matchAll(LIVE_COUNT_CLAIMS)) {
        offenders.push(`line ${i + 1}: …${m[0]}…`);
      }
    });
    expect(
      offenders,
      `The surface list's count is restated in prose. It has drifted five times this way — `
        + `cite invariant 5 instead of naming a number:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
