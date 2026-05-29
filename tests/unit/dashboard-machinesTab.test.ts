/**
 * Smoke tests for the Machines dashboard tab (Multi-Machine Session Pool §L2).
 * Inspects the HTML/JS at rest (no browser): tab wiring, panel, loader, endpoint
 * usage, XSS-safe rendering, and Dashboard-Standard copy (plain-language intro).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');

describe('dashboard: Machines tab', () => {
  it('has a Machines tab button wired to switchTab', () => {
    expect(HTML).toContain('data-tab="machines"');
    expect(HTML).toContain(`switchTab('machines')`);
  });

  it('has a machinesPanel container', () => {
    expect(HTML).toContain('id="machinesPanel"');
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

  it('renames via PATCH /pool/machines/:id', () => {
    expect(HTML).toContain('async function saveMachineNickname');
    expect(HTML).toContain(`'/pool/machines/'`);
    expect(HTML).toMatch(/method:\s*'PATCH'/);
  });

  it('renders machine values XSS-safely (escapeHtml on dynamic fields)', () => {
    // The render function must escape the nickname + machineId it injects.
    expect(HTML).toMatch(/escapeHtml\(nick\)/);
    expect(HTML).toMatch(/escapeHtml\(m\.machineId\)/);
  });

  it('uses Dashboard-Standard plain-language copy (grounding intro, no jargon)', () => {
    // The intro must explain in plain terms; the dispatcher/nickname are described
    // without raw machineId-speak. (Dashboard Standard: ELI16, grounding intro.)
    expect(HTML).toContain('Every computer this agent is set up on');
    expect(HTML).toContain('move this conversation to the mini');
    expect(HTML).toContain('dispatcher'); // codename-mapped router role
  });

  it('shows a calm clock-out-of-sync status (not an alarm) for a quarantined machine', () => {
    expect(HTML).toContain('clock out of sync — paused for new conversations');
  });
});
