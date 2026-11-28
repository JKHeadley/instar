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

  it('surfaces a degraded report as NOT CHECKED, with its reason, and exits 2', async () => {
    stubFetch({
      report: { findings: [], standardsChecked: 21, degraded: true, degradeReason: 'no-intelligence', notCheckedReason: 'not checked: no model provider is configured for the check on this machine' },
      registryCanary: { ok: true, articleCount: 22, failures: [] },
    });
    const prior = process.exitCode;
    try {
      await runSpecConformance({ specPath: specFile, dir: tempDir });
      expect(logs.join('\n')).toMatch(/NOT CHECKED: no model provider/);
      expect(logs.join('\n')).not.toMatch(/No possible standard-violations/);
      expect(process.exitCode).toBe(2);
    } finally { process.exitCode = prior; }
  });

  it('--json also exits 2 on a degraded report', async () => {
    stubFetch({
      report: { findings: [], standardsChecked: 21, degraded: true, degradeReason: 'too-long' },
      registryCanary: { ok: true, articleCount: 22, failures: [] },
    });
    const prior = process.exitCode;
    try {
      await runSpecConformance({ specPath: specFile, dir: tempDir, json: true });
      expect(process.exitCode).toBe(2);
    } finally { process.exitCode = prior; }
  });

  it('a fit judgment that did not run prints NOT CHECKED (fit) and exits 2', async () => {
    stubFetch({
      report: { findings: [], standardsChecked: 21, degraded: false, fit: { verdict: 'not-checked', reason: 'not checked: the model call failed or timed out', degraded: true } },
      registryCanary: { ok: true, articleCount: 22, failures: [] },
    });
    const prior = process.exitCode;
    try {
      await runSpecConformance({ specPath: specFile, dir: tempDir });
      expect(logs.join('\n')).toContain('NOT CHECKED (fit)');
      expect(process.exitCode).toBe(2);
    } finally { process.exitCode = prior; }
  });

  it('a client timeout or a 408 is NOT CHECKED with exit 2, never "server not running"', async () => {
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    const prior = process.exitCode;
    try {
      vi.stubGlobal('fetch', async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; });
      await runSpecConformance({ specPath: specFile, dir: tempDir });
      expect(errs.join('\n')).toContain('NOT CHECKED');
      expect(errs.join('\n')).not.toMatch(/Is the server running/);
      expect(process.exitCode).toBe(2);
      process.exitCode = prior;
      stubFetch({}, false, 408);
      await runSpecConformance({ specPath: specFile, dir: tempDir });
      expect(process.exitCode).toBe(2);
    } finally { process.exitCode = prior; }
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
