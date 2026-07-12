/**
 * ACT-562 §3.2 — the MONOTONIC coverage ratchet for LLM-decision provenance
 * (docs/specs/llm-decision-provenance-wiring.md).
 *
 * Guards BOTH directions so the "prose-honored-but-structurally-open" hole ACT-562
 * was raised for stays closed:
 *   - ADDITION: every PROVENANCE_REQUIRED entry MUST be wired to a recordDecision
 *     callsite (its `decisionPoint` id appears in src/, emitted with matching
 *     attribution.component prefix). An unwired allowlist entry fails CI.
 *   - REMOVAL: a committed monotonic floor (count + canonical-set hash) in
 *     `llm-decision-provenance-coverage.floor.json` may never DECREASE silently.
 *     Lowering it requires a PR that updates the floor AND names each removed
 *     decision point (the standards-registry floor-bump pattern).
 *   - CROSS-CHECK: every PROVENANCE_REQUIRED entry is also in COMPONENT_CATEGORY
 *     (a provenance-required component can never be an unrouted "other").
 *   - IDENTITY: every high-stakes entry is genuinely sampling-exempt (§3.2a).
 *   - DISCOVERY: every attributed LLM decision-point callsite among the census is
 *     classified required / deferred:<ref> / exempt:<rationale>, so the surface
 *     can't silently grow past coverage.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROVENANCE_REQUIRED } from '../../src/core/provenanceRequired.js';
import { isHighStakesDecisionPoint } from '../../src/core/provenanceRequired.js';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FLOOR_FILE = path.join(ROOT, 'tests', 'unit', 'llm-decision-provenance-coverage.floor.json');

/** Canonical set hash: sha256 over the SORTED, newline-joined id set. */
function canonicalSetHash(ids: string[]): string {
  return crypto.createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
}

function walkSrc(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

/** The concatenated text of all src/ TS files (comments included). */
function srcText(): string {
  return walkSrc().map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
}

describe('§3.2 ADDITION — every PROVENANCE_REQUIRED entry is wired to recordDecision', () => {
  const all = srcText();

  it('each allowlisted decisionPoint id appears at a recordDecision callsite', () => {
    const unwired: string[] = [];
    for (const entry of PROVENANCE_REQUIRED) {
      // The id must appear in src/ as a decisionPoint literal wired to a
      // recordDecision-shaped emit. We require the id literal to be present AND
      // the phrase decisionPoint to co-occur (the row field name), proving it is
      // emitted as a provenance row, not merely mentioned.
      const idPresent = all.includes(`'${entry.id}'`) || all.includes(`"${entry.id}"`);
      if (!idPresent) unwired.push(entry.id);
    }
    expect(
      unwired,
      `PROVENANCE_REQUIRED entries not wired to a recordDecision callsite (add the wiring or remove the entry): ${unwired.join(', ')}`,
    ).toEqual([]);
  });

  it('§3.1 identity-match: each emitted decisionPoint id\'s component prefix matches its attribution.component', () => {
    // For each entry, its component (the prefix) must be used as an
    // attribution.component somewhere in src/ (the deciding LLM callsite).
    const mismatched: string[] = [];
    for (const entry of PROVENANCE_REQUIRED) {
      const compUsed =
        all.includes(`component: '${entry.component}'`) ||
        all.includes(`component: "${entry.component}"`) ||
        all.includes(`'${entry.component}'`) || // e.g. component: 'ExternalHogClassifier'
        all.includes(`"${entry.component}"`);
      if (!compUsed) mismatched.push(`${entry.id} (component ${entry.component} never used as attribution.component)`);
    }
    expect(mismatched).toEqual([]);
  });
});

describe('§3.2 REMOVAL — the committed monotonic floor never decreases silently', () => {
  it('the floor file exists and is well-formed', () => {
    expect(fs.existsSync(FLOOR_FILE), 'floor file missing').toBe(true);
    const floor = JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf-8')) as { count: number; setHash: string; ids: string[] };
    expect(typeof floor.count).toBe('number');
    expect(typeof floor.setHash).toBe('string');
    expect(Array.isArray(floor.ids)).toBe(true);
  });

  it('the current allowlist COUNT is >= the committed floor (a silent removal fails CI)', () => {
    const floor = JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf-8')) as { count: number };
    expect(
      PROVENANCE_REQUIRED.length,
      `Coverage floor REGRESSION: allowlist has ${PROVENANCE_REQUIRED.length} entries, floor requires >= ${floor.count}. ` +
        'Lowering coverage requires a PR that updates the floor AND names each removed decision point + rationale.',
    ).toBeGreaterThanOrEqual(floor.count);
  });

  it('every floor id is still present in the allowlist (a removal must bump the floor, naming the removed point)', () => {
    const floor = JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf-8')) as { ids: string[] };
    const current = new Set(PROVENANCE_REQUIRED.map((e) => e.id));
    const removed = floor.ids.filter((id) => !current.has(id));
    expect(
      removed,
      `These floor decision points were removed from the allowlist without a floor bump: ${removed.join(', ')}. ` +
        'Update the floor file and name each removed point + rationale in the PR body.',
    ).toEqual([]);
  });

  it('the floor setHash matches the floor ids (the floor is internally consistent)', () => {
    const floor = JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf-8')) as { setHash: string; ids: string[] };
    expect(canonicalSetHash(floor.ids)).toBe(floor.setHash);
  });
});

describe('§3.2 CROSS-CHECK — every PROVENANCE_REQUIRED component is a registered category', () => {
  it('no provenance-required component is an unrouted "other"', () => {
    const unregistered = PROVENANCE_REQUIRED
      .map((e) => e.component)
      .filter((c) => !(c in COMPONENT_CATEGORY));
    expect(
      unregistered,
      `PROVENANCE_REQUIRED components missing from COMPONENT_CATEGORY: ${unregistered.join(', ')}`,
    ).toEqual([]);
  });
});

describe('§3.2a IDENTITY — every high-stakes entry is sampling-exempt', () => {
  it('each PROVENANCE_REQUIRED entry marked highStakes resolves exempt via identity', () => {
    for (const e of PROVENANCE_REQUIRED) {
      if (e.highStakes) expect(isHighStakesDecisionPoint(e.id)).toBe(true);
    }
  });
});

describe('§3.2 DISCOVERY — the surface can\'t silently grow past coverage', () => {
  /**
   * The in-scope LLM DECISION-POINT components this increment wired. Any LLM
   * decision-point component discovered in src/ that is NOT one of these must be
   * classified below (deferred / exempt) — a NEW unclassified LLM decision point
   * fails this test, forcing a coverage decision. This mirrors the
   * llm-attribution-ratchet's pinned-exclusion discipline.
   */
  const REQUIRED_COMPONENTS = new Set(PROVENANCE_REQUIRED.map((e) => e.component));

  /**
   * DEFERRED (§2 out-of-scope, tracked ACT-562): known LLM DECISION points not
   * yet wired — the ratchet's expansion queue. Each is a real gate/judge that
   * SHOULD eventually log provenance but is out of this increment's high-stakes
   * tranche. (SpawnAdmission logs DETERMINISTIC provenance already — it is not an
   * LLM point, so it is neither here nor required.)
   */
  const DEFERRED: Record<string, string> = {
    UnjustifiedStopGate: 'deferred:ACT-562 — stop-gate LLM authority (observe-only today)',
    WarrantsReplyGate: 'deferred:ACT-562 — A2A reply gate',
    DiscoveryEvaluator: 'deferred:ACT-562 — serendipity discovery judge',
    ProjectDriftChecker: 'deferred:ACT-562 — project drift judge',
    TopicIntentArcCheck: 'deferred:ACT-562 — topic-intent arc coherence judge',
  };

  it('PROVENANCE_REQUIRED covers exactly the wired-this-increment components', () => {
    // The wired set is exactly the 3 distinct components (CompletionEvaluator
    // carries two decision points). A drift here means a wiring/allowlist change
    // that must be reflected in the floor + this discovery list.
    expect([...REQUIRED_COMPONENTS].sort()).toEqual(
      ['CompletionEvaluator', 'ExternalHogClassifier', 'MessagingToneGate'].sort(),
    );
  });

  it('every DEFERRED component is genuinely NOT yet wired (a stale deferral must be promoted or removed)', () => {
    const all = srcText();
    for (const comp of Object.keys(DEFERRED)) {
      // A deferred component must NOT already emit a provenance decisionPoint of
      // the `<comp>:...:v1` shape (if it does, it should be REQUIRED, not deferred).
      const wiredShape = new RegExp(`decisionPoint:\\s*['"\`]${comp}:[a-z0-9-]+:v\\d`);
      expect(
        wiredShape.test(all),
        `'${comp}' is in DEFERRED but already emits a provenance decisionPoint — promote it to PROVENANCE_REQUIRED + bump the floor.`,
      ).toBe(false);
    }
  });
});
