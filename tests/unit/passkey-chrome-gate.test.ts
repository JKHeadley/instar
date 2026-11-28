/**
 * The Chrome version gate (spec agent-held-google-passkey §2): recorded per Chrome major, re-run
 * only on a version change or a forced recheck, and never `passed` when the check cannot run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ensurePasskeyChromeGate, parseChromeMajor, PasskeyChromeGateStore, readChromeMajor, runChromeGateSelfTest,
  type ChromeGateBrowser } from '../../src/core/PasskeyChromeGate.js';

const dirs: string[] = [];
function store(): PasskeyChromeGateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-chrome-gate-'));
  dirs.push(dir);
  return new PasskeyChromeGateStore({ stateDir: dir });
}
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/passkey-chrome-gate.test.ts:cleanup' });
});

/** A fake authenticator shared by the "browsers" of one run, so export → inject → assert is modelled. */
function fakeBrowsers(opts: { exportCount?: number; assertId?: string; observe?: boolean; throwOn?: 'create' } = {}) {
  let closed = 0;
  const make = (): ChromeGateBrowser => {
    let held: { credentialId: string } | null = null;
    let asserted: string | null = null;
    return {
      async open() {},
      async runInPage<T>(expr: string): Promise<T> {
        if (expr.startsWith('window.__create')) {
          if (opts.throwOn === 'create') throw new Error('NotAllowedError: timed out');
          held = { credentialId: 'cred-1' };
          return 'cred-1' as T;
        }
        asserted = opts.assertId ?? held?.credentialId ?? null;
        return asserted as T;
      },
      async exportCredentials() { return held ? Array.from({ length: opts.exportCount ?? 1 }, () => ({ ...held! })) : []; },
      async addCredential(c) { held = c as { credentialId: string }; },
      observedAssertion(id) { return (opts.observe ?? true) && asserted === id; },
      async close() { closed += 1; },
    };
  };
  return { make, closed: () => closed };
}

describe('Chrome version parsing', () => {
  it('reads the major from common version lines and refuses garbage', () => {
    expect(parseChromeMajor('Google Chrome 131.0.6778.86')).toBe(131);
    expect(parseChromeMajor('Chromium 120.0.6099.109 snap')).toBe(120);
    expect(parseChromeMajor('no version here')).toBeNull();
    expect(readChromeMajor(null)).toBeNull();
    expect(readChromeMajor('/chrome', () => { throw new Error('ENOENT'); })).toBeNull();
    expect(readChromeMajor('/chrome', () => 'Google Chrome 132.0.1.2\n')).toBe(132);
  });
});

describe('runChromeGateSelfTest', () => {
  it('passes when a credential minted in one browser asserts in a second fresh one, and closes both', async () => {
    const f = fakeBrowsers();
    expect(await runChromeGateSelfTest({ newBrowser: f.make, holderOrigin: 'http://localhost:1' })).toEqual({ passed: true });
    expect(f.closed()).toBeGreaterThanOrEqual(2);
  });
  it('fails, by name, on every broken step', async () => {
    expect(await runChromeGateSelfTest({ newBrowser: fakeBrowsers({ exportCount: 2 }).make, holderOrigin: 'x' })).toEqual({ passed: false, reason: 'export-count-2' });
    expect(await runChromeGateSelfTest({ newBrowser: fakeBrowsers({ assertId: 'other' }).make, holderOrigin: 'x' })).toEqual({ passed: false, reason: 'assert-id-mismatch' });
    expect(await runChromeGateSelfTest({ newBrowser: fakeBrowsers({ observe: false }).make, holderOrigin: 'x' })).toEqual({ passed: false, reason: 'assertion-not-observed' });
    const thrown = await runChromeGateSelfTest({ newBrowser: fakeBrowsers({ throwOn: 'create' }).make, holderOrigin: 'x' });
    expect(thrown).toEqual({ passed: false, reason: 'self-test-error:NotAllowedError', transient: true });
  });
});

describe('ensurePasskeyChromeGate', () => {
  it('runs once per Chrome major, reuses the record, and re-runs on a version change or a forced recheck', async () => {
    const s = store();
    let runs = 0;
    const pass = async () => { runs += 1; return { passed: true } as const; };
    expect(await ensurePasskeyChromeGate({ store: s, currentMajor: 131, selfTest: pass })).toBe('passed');
    expect(await ensurePasskeyChromeGate({ store: s, currentMajor: 131, selfTest: pass })).toBe('passed');
    expect(runs).toBe(1);
    expect(s.gateFor(132)).toBe('unchecked');
    expect(await ensurePasskeyChromeGate({ store: s, currentMajor: 132, selfTest: async () => { runs += 1; return { passed: false, reason: 'assert-id-mismatch' }; } })).toBe('failed');
    expect(runs).toBe(2);
    expect(s.read()).toMatchObject({ chromeMajor: 132, result: 'failed', reason: 'assert-id-mismatch' });
    expect(await ensurePasskeyChromeGate({ store: s, currentMajor: 132, selfTest: pass, force: true })).toBe('passed');
    expect(runs).toBe(3);
  });
  it('a self-test that could not run is not recorded and reads unchecked', async () => {
    const s = store();
    expect(await ensurePasskeyChromeGate({ store: s, currentMajor: 131, selfTest: async () => ({ passed: false, reason: 'self-test-error:TimeoutError', transient: true }) })).toBe('unchecked');
    expect(s.read()).toBeNull();
  });
  it('an unreadable Chrome version never runs the test and reads unchecked', async () => {
    const s = store();
    let runs = 0;
    expect(await ensurePasskeyChromeGate({ store: s, currentMajor: null, selfTest: async () => { runs += 1; return { passed: true }; } })).toBe('unchecked');
    expect(runs).toBe(0);
  });
  it('a corrupt record reads as never checked', () => {
    const s = store();
    s.write({ chromeMajor: 131, result: 'passed', checkedAt: new Date().toISOString(), reason: null });
    fs.writeFileSync(path.join(dirs[0]!, 'state', 'passkey-chrome-gate.json'), '{not json');
    expect(s.gateFor(131)).toBe('unchecked');
  });
});
