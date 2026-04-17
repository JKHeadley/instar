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

  it('defines a prPipelinePanel section with the expected content hooks', () => {
    expect(html).toMatch(/id="prPipelinePanel"/);
    expect(html).toMatch(/id="prPipelinePhaseNotice"/);
    expect(html).toMatch(/id="prPipelineList"/);
    expect(html).toMatch(/id="prPipelineEmpty"/);
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
    expect(body).toContain('httpStatus === 404');
    expect(body).toContain('Gate disabled');

    // Read-only rule: no eligibility mutations originating from the tab.
    expect(body).not.toContain('/pr-gate/authorize');
    expect(body).not.toContain('/pr-gate/eligible');
    expect(body).not.toContain('method: \'POST\'');
    expect(body).not.toContain('method: "POST"');

    // XSS defense: no innerHTML inside the loader.
    expect(body).not.toContain('.innerHTML');
  });
});
