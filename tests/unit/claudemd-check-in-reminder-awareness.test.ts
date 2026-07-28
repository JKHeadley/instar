/**
 * Agent Awareness + Migration Parity for the dated check-in reminder (ACT-724).
 *
 * "An agent that doesn't know about a capability effectively doesn't have it."
 * The reminder shipped with routes, a job, and tests — and NOTHING in the agent
 * template, so no agent would ever set `checkInAt` and no dated promise would
 * ever produce a reminder. The feature would have been live and unreachable.
 *
 * Nothing enforces the Agent Awareness Standard structurally, which is exactly
 * why it was missed: it is a documented rule with no gate behind it. This file
 * is the gate for THIS capability.
 *
 * The migration half is the harder half and the reason it gets its own arm.
 * The existing Commitments migration is guarded by
 * `if (!content.includes('**Commitments & Follow-Through**'))`, so an agent that
 * already has that section never re-enters the branch. Appending the new
 * subsection there would reach fresh installs only — the precise Migration
 * Parity failure mode the standard names.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = path.join(ROOT, 'src/scaffold/templates.ts');
const MIGRATOR = path.join(ROOT, 'src/core/PostUpdateMigrator.ts');

const templateSrc = fs.readFileSync(TEMPLATE, 'utf-8');
const migratorSrc = fs.readFileSync(MIGRATOR, 'utf-8');

describe('a NEW agent learns about dated check-in reminders', () => {
  it('the template documents the capability at all', () => {
    expect(templateSrc).toContain('/commitments/check-in-reminder');
  });

  it('names the field an agent must actually set', () => {
    // Without `checkInAt` in the template, the reconciler has nothing to find:
    // the feature runs forever over an empty set and looks healthy doing it.
    expect(templateSrc).toContain('checkInAt');
  });

  it('carries a PROACTIVE trigger, not just an endpoint', () => {
    // Per the standard: an endpoint with no "when to use" is discoverable only
    // by someone already looking for it.
    const idx = templateSrc.indexOf('/commitments/check-in-reminder');
    const window = templateSrc.slice(Math.max(0, idx - 2000), idx + 2000);
    expect(window).toMatch(/I'll check in on this by Friday|when you say/i);
  });

  it('states the honest scope rather than implying the guarantee is complete', () => {
    // The feature ships dark and the creation-time gate is step 2. An agent
    // reading the template must not believe a dated promise is guaranteed a
    // reminder today.
    const idx = templateSrc.indexOf('/commitments/check-in-reminder');
    const window = templateSrc.slice(Math.max(0, idx - 2000), idx + 2500);
    expect(window).toMatch(/NOT true yet|nothing yet guarantees/i);
    expect(window).toMatch(/at-least-once/i);
  });

  it('tells the agent which field means a promise was MISSED', () => {
    const idx = templateSrc.indexOf('/commitments/check-in-reminder');
    const window = templateSrc.slice(Math.max(0, idx - 1000), idx + 2500);
    expect(window).toContain('undelivered');
  });
});

describe('an EXISTING agent gets it too — the Migration Parity half', () => {
  it('the migrator has an arm for the dated reminder', () => {
    expect(migratorSrc).toContain('/commitments/check-in-reminder');
  });

  it('that arm is SEPARATE from the Commitments-section arm', () => {
    // The load-bearing assertion. The Commitments arm only fires when the whole
    // section is ABSENT, so an agent that already has it would never receive an
    // addition made inside that branch. The new arm must be reachable when the
    // section is PRESENT but the subsection is not.
    expect(migratorSrc).toContain(
      "content.includes('**Commitments & Follow-Through**') &&",
    );
    expect(migratorSrc).toContain("!content.includes('/commitments/check-in-reminder')");
  });

  it('is idempotent — a second run reports skipped, never a duplicate', () => {
    expect(migratorSrc).toContain('dated check-in reminder already present');
  });

  it('records what it did, so an update is auditable', () => {
    expect(migratorSrc).toContain('added dated check-in reminder to Commitments section');
  });

  it('degrades to appending rather than skipping when the wording has drifted', () => {
    // An agent whose CLAUDE.md drifted from the shipped text must still gain the
    // capability. Silently skipping would leave exactly the agents with
    // customized files permanently unaware.
    const idx = migratorSrc.indexOf('added dated check-in reminder to Commitments section');
    const window = migratorSrc.slice(Math.max(0, idx - 1800), idx);
    expect(window).toMatch(/Append rather than skip|missing capability is worse/i);
  });
});
