/**
 * Unit — the grok agent-awareness paragraph must AGREE with the code it describes.
 *
 * THE DEFECT THIS PINS (2026-08-16). The grok headless lane was opened, and the
 * awareness paragraph shipped to every agent was left saying the opposite:
 *
 *     "headless job spawns do NOT run on grok yet: a job resolved to grok runs on
 *      another ENABLED framework … so read the session's framework label, not the
 *      pin, when asking whose quota ran a job."
 *
 * Every test passed. Typecheck passed. The whole suite was green while the text
 * that IS an agent's knowledge of this feature said the feature does not exist —
 * and worse, gave agents a rule ("a grok job never runs on grok") that would make
 * them answer "whose quota ran this job?" exactly backwards.
 *
 * That is the Agent Awareness Standard failing in the precise way it exists to
 * prevent: the template is the agent's awareness, so a behaviour change without a
 * template change ships a feature no agent knows it has, or — here — a documented
 * guarantee the code no longer honours.
 *
 * A test asserting "the paragraph mentions grok" would not have caught this: the
 * paragraph mentioned grok at length and was still wrong. So these assertions are
 * COUPLED to the runtime predicate instead. Whichever side someone changes next,
 * the other side is forced.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { headlessLaneIsClosed } from '../../src/core/frameworkSessionLaunch.js';

const ROOT = path.resolve(__dirname, '../..');
const TEMPLATE = path.join(ROOT, 'src/scaffold/templates.ts');
const MIGRATOR = path.join(ROOT, 'src/core/PostUpdateMigrator.ts');

/** The awareness paragraph, as it appears in a source file. */
function grokParagraph(file: string): string {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('**Grok Build framework');
  expect(start, `${path.basename(file)} must carry the grok awareness paragraph`).toBeGreaterThan(-1);
  // The paragraph ends at its spec citation, which every awareness block carries.
  const end = src.indexOf('grok-build-framework-integration.md', start);
  expect(end, `${path.basename(file)}: grok paragraph must cite its spec`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('grok agent-awareness text agrees with grok behaviour', () => {
  it('does not claim headless jobs are unavailable while the lane is OPEN', () => {
    // The coupling. `headlessLaneIsClosed` is the runtime authority; the text may
    // not contradict it. Deliberately keyed on the CLAIM, not on a fixed sentence,
    // so a reworded version of the same false claim still fails.
    const laneClosed = headlessLaneIsClosed('grok-build');
    for (const file of [TEMPLATE, MIGRATOR]) {
      const para = grokParagraph(file);
      const claimsUnavailable = /headless job spawns do NOT run on grok|jobs? (?:do|does) not run on grok|no headless (?:lane|jobs?) (?:for|on) grok/i.test(para);
      expect(
        claimsUnavailable,
        `${path.basename(file)}: text says grok headless jobs do not run, but headlessLaneIsClosed('grok-build') === ${laneClosed}`,
      ).toBe(laneClosed);
    }
  });

  it('names the bound that replaced the blanket refusal', () => {
    // Opening a lane and saying nothing about its remaining bound is the other
    // half of the same failure: an agent that does not know about
    // `grok-headless-source-tree` cannot explain the refusal when it fires, and
    // will report a working feature as broken.
    for (const file of [TEMPLATE, MIGRATOR]) {
      expect(grokParagraph(file)).toMatch(/grok-headless-source-tree/);
    }
  });

  // Migration Parity between the two shipped copies is already asserted by
  // grok-build-awareness-parity.test.ts (it compares the rendered note from
  // generateClaudeMd against the migrator's output on a real temp project, which
  // is the stronger check). Not duplicated here.

  it('CONTROL: the assertions read a real paragraph, not an empty string', () => {
    // Without this, a change to the marker string would make grokParagraph return
    // something tiny and every claim-absence assertion above would pass vacuously
    // — a green suite proving nothing, which is the shape of failure this whole
    // file exists to catch.
    for (const file of [TEMPLATE, MIGRATOR]) {
      const para = grokParagraph(file);
      expect(para.length).toBeGreaterThan(500);
      expect(para).toMatch(/enabledFrameworks/);
    }
  });
});
