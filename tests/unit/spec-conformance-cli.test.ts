/**
 * Unit test for `instar spec conformance` (scg-cli) — the thin client over
 * POST /spec/conformance-check. Verifies it reads the spec, posts the markdown,
 * and renders the report; fetch is stubbed (no live server).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { runSpecConformance } from '../../src/commands/spec.js';

let tempDir: string;
let specFile: string;
let logs: string[];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-cli-'));
  specFile = path.join(tempDir, 'draft.md');
  fs.writeFileSync(specFile, '# Draft\nThe user must remember to run sync.');
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/spec-conformance-cli.test.ts' }); } catch { /* best */ }
});

function stubFetch(body: unknown, ok = true, status = 200) {
  const captured: { url?: string; init?: RequestInit } = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    captured.url = url; captured.init = init;
    return { ok, status, statusText: 'OK', json: async () => body } as unknown as Response;
  });
  return captured;
}

describe('runSpecConformance (CLI)', () => {
  it('posts the spec markdown to /spec/conformance-check and prints flagged findings', async () => {
    const captured = stubFetch({
      report: {
        findings: [{ standard: 'No Manual Work (user *or* agent)', family: 'Interaction', status: 'possible-violation', reason: 'requires the user to remember to run sync' }],
        standardsChecked: 21, degraded: false,
      },
      registryCanary: { ok: true, articleCount: 22, failures: [] },
    });

    await runSpecConformance({ specPath: specFile, dir: tempDir });

    expect(captured.url).toContain('/spec/conformance-check');
    expect(JSON.parse(String(captured.init!.body))).toMatchObject({ markdown: expect.stringContaining('must remember to run sync') });
    const out = logs.join('\n');
    expect(out).toContain('No Manual Work');
    expect(out).toMatch(/1 possible violation/);
  });

  it('prints a clean pass when no findings', async () => {
    stubFetch({
      report: { findings: [], standardsChecked: 21, degraded: false },
      registryCanary: { ok: true, articleCount: 22, failures: [] },
    });
    await runSpecConformance({ specPath: specFile, dir: tempDir });
    expect(logs.join('\n')).toMatch(/No possible standard-violations/);
  });

  it('surfaces a degraded report as advisory, not authoritative', async () => {
    stubFetch({
      report: { findings: [], standardsChecked: 21, degraded: true, degradeReason: 'no-intelligence' },
      registryCanary: { ok: true, articleCount: 22, failures: [] },
    });
    await runSpecConformance({ specPath: specFile, dir: tempDir });
    expect(logs.join('\n')).toMatch(/degraded.*no-intelligence/);
  });

  it('--json emits the raw response', async () => {
    stubFetch({
      report: { findings: [], standardsChecked: 21, degraded: false },
      registryCanary: { ok: true, articleCount: 22, failures: [] },
    });
    await runSpecConformance({ specPath: specFile, dir: tempDir, json: true });
    const out = logs.join('\n');
    expect(out).toContain('"standardsChecked": 21');
  });

  it('exits non-zero when the spec file is missing', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => { throw new Error('exit'); }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runSpecConformance({ specPath: path.join(tempDir, 'nope.md'), dir: tempDir })).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
