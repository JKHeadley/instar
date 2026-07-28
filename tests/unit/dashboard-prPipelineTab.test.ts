/**
 * Dashboard PR Pipeline tab — structural smoke tests (Phase A commit 7).
 *
 * Tests that dashboard/index.html contains:
 *   - The tab button with data-tab="pr-pipeline"
 *   - The corresponding tab panel with id="prPipelinePanel"
 *   - A TAB_REGISTRY entry that wires onActivate to loadPrPipeline
 *   - The loadPrPipeline function
 *   - Read-only invariants: no form submissions to /pr-gate/*, no
 *     innerHTML assignments inside the loadPrPipeline function body.
 *
 * Can't run a real browser here; this is a file-inspection test that
 * catches accidental regression of the structural invariants.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.resolve(__dirname, '..', '..', 'dashboard', 'index.html');

describe('dashboard PR Pipeline tab', () => {
  const html = fs.readFileSync(DASHBOARD_PATH, 'utf-8');

  it('registers a tab button with data-tab="pr-pipeline"', () => {
    expect(html).toMatch(/<button[^>]+data-tab="pr-pipeline"[^>]*>PR Pipeline<\/button>/);
  });

  it('defines a prPipelinePanel that renders through the shared glance component (Phase 4)', () => {
    expect(html).toMatch(/id="prPipelinePanel"/);
    // Phase 4: the bespoke phase-notice/list/empty markup was replaced by a glance-root.
    expect(html).toMatch(/id="prPipelineGlance"[^>]*class="glance-root"/);
  });

  it('adds a TAB_REGISTRY entry calling loadPrPipeline on activate', () => {
    // The entry is a small object literal with panels: ['prPipelinePanel']
    // and onActivate that calls loadPrPipeline.
    const registryChunk = html.match(/id:\s*'pr-pipeline',[\s\S]{0,400}/);
    expect(registryChunk).toBeTruthy();
    expect(registryChunk![0]).toContain("panels: ['prPipelinePanel']");
    expect(registryChunk![0]).toContain('loadPrPipeline');
  });

  it('defines the loadPrPipeline function', () => {
    expect(html).toMatch(/async function loadPrPipeline\s*\(\s*\)/);
  });

  it('loadPrPipeline handles HTTP 404 with a phase=off placeholder', () => {
    // Extract the function body for targeted assertions.
    const start = html.indexOf('async function loadPrPipeline');
    expect(start).toBeGreaterThan(-1);
    // Find the next function declaration to bound the body.
    const afterStart = html.slice(start);
    const nextFn = afterStart.slice(20).search(/\n    (async function|function|let |const |\/\/ ──)/);
    const body = afterStart.slice(0, nextFn > 0 ? nextFn + 20 : 8000);

    expect(body).toContain('/pr-gate/metrics');
    expect(body).toContain('httpStatus === 404'); // 404 = phase=off still handled
    // Phase 4: renders through the glance component; the honest dark note replaced
    // the old "Gate disabled" placeholder.
    expect(body).toContain('prPipelineGlanceSpec');
    expect(body).toMatch(/glance-empty|isn.t turned on/);

    // Read-only rule: no eligibility mutations originating from the tab.
    expect(body).not.toContain('/pr-gate/authorize');
    expect(body).not.toContain('/pr-gate/eligible');
    expect(body).not.toContain('method: \'POST\'');
    expect(body).not.toContain('method: "POST"');

    // XSS defense: no innerHTML inside the loader (the glance component uses textContent).
    expect(body).not.toContain('.innerHTML');
  });
});
