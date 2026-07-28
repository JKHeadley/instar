/**
 * Smoke tests for the Machines dashboard tab (Multi-Machine Session Pool §L2),
 * rebuilt on the shared glance component (Dashboard UX Standard F10/F11, topic 29836
 * Phase 3) with issue #1429 (nickname commit-on-input + focus-steal) folded in.
 * Inspects the HTML/JS at rest (no browser): tab wiring, panel, loader, endpoint
 * usage, the glance render path, #1429 commit-on-blur, and XSS-safe rendering.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');
const GLANCE = fs.readFileSync(path.resolve(__dirname, '../../dashboard/glance.js'), 'utf-8');

describe('dashboard: Machines tab', () => {
  it('has a Machines tab button wired to switchTab', () => {
    expect(HTML).toContain('data-tab="machines"');
    expect(HTML).toContain(`switchTab('machines')`);
  });

  it('has a machinesPanel container with a glance root', () => {
    expect(HTML).toContain('id="machinesPanel"');
    expect(HTML).toContain('id="machinesGlance"');
  });

  it('registers the machines tab in TAB_REGISTRY (panels: [machinesPanel])', () => {
    expect(HTML).toMatch(/id:\s*'machines'[\s\S]{0,200}panels:\s*\['machinesPanel'\]/);
  });

  it('activates via startMachines and stops the poll on deactivation', () => {
    expect(HTML).toContain(`startMachines === 'function'`);
    expect(HTML).toContain('stopMachines === ');
    expect(HTML).toContain('function startMachines()');
    expect(HTML).toContain('function stopMachines()');
  });

  it('defines the loader + uses the /pool endpoint', () => {
    expect(HTML).toContain('async function loadMachines()');
    expect(HTML).toContain(`apiFetch('/pool')`);
  });

  it('renders through the shared glance component (F10/F11), not bespoke innerHTML cards', () => {
    expect(HTML).toContain('glance.machinesGlanceSpec(document');
    expect(HTML).toContain('glance.renderGlance(document');
    // the old bespoke card renderer is gone
    expect(HTML).not.toContain('renderMachineCard');
  });

  it('enriches the Safety-checks tile with the named guards from /guards', () => {
    expect(HTML).toMatch(/apiFetch\('\/guards'\)/);
  });

  it('#1429: renames via PATCH /pool/machines/:id, committing only on Enter/blur', () => {
    expect(HTML).toContain('async function saveMachineNickname');
    expect(HTML).toContain(`'/pool/machines/'`);
    expect(HTML).toMatch(/method:\s*'PATCH'/);
    // The editable nickname lives in the glance record and commits on blur / Enter —
    // NOT on every input event (the #1429 defect).
    expect(GLANCE).toContain("input.addEventListener('blur', commit)");
    expect(GLANCE).toMatch(/keydown[\s\S]{0,80}Enter[\s\S]{0,40}blur\(\)/);
    expect(GLANCE).not.toMatch(/addEventListener\('input',\s*commit/);
  });

  it('renders machine values XSS-safely via the glance sanitizer (no innerHTML)', () => {
    // The glance component displays nicknames / free text through sanitizeForDisplay.
    expect(GLANCE).toMatch(/sanitizeForDisplay\(m\.nickname/);
    expect(GLANCE).toContain('export function machineRowText');
  });

  it('uses Dashboard-Standard plain-language copy (glance intro, no jargon)', () => {
    expect(HTML).toContain('Every computer this agent runs on, at a glance');
    expect(HTML).toContain('dispatcher'); // codename-mapped router role, described plainly
  });

  it('shows a calm clock-out-of-sync status (not an alarm) for a quarantined machine', () => {
    // The plain status word now lives in the shared component (glance.js).
    expect(GLANCE).toContain('Clock out of sync — paused for new conversations');
  });
});
