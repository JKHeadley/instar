import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  probeBetterSqlite,
  formatBanner,
  runHealthCheck,
  type NativeProbeResult,
} from '../setup/nativeModuleHealth.globalSetup.js';

/**
 * A full local suite reported 225 failing files. 108 were downstream of ONE fact:
 * better-sqlite3 had no native binary in that checkout. instar diagnosed it
 * correctly and printed the remedy 189 times — and that did not help, because 189
 * lines inside a 21MB log is volume, not a signal.
 *
 * These tests pin the two properties that make the banner useful rather than
 * another line in the pile: it is SILENT on a healthy box, and when it does speak
 * it carries the remedy.
 */

describe('THE INCIDENT SHAPE — a module that loads but cannot open a database', () => {
  it('is reported BROKEN, not healthy', () => {
    // The load-bearing case. The real signature was "failed to open an in-memory
    // DB", so a require-only probe would have reported healthy for the entire
    // outage. This is why the probe constructs, not just imports.
    class OpensNothing {
      constructor() { throw new Error('SQLITE_CANTOPEN: unable to open database file'); }
      close(): void { /* unreachable */ }
    }
    const r = probeBetterSqlite(() => OpensNothing);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('SQLITE_CANTOPEN');
  });

  it('reports a failure to LOAD as broken too', () => {
    const r = probeBetterSqlite(() => { throw new Error('Could not locate the bindings file. Tried:\n  …'); });
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('Could not locate the bindings file. Tried:');
  });

  it('keeps only the first line of a multi-line failure', () => {
    const r = probeBetterSqlite(() => { throw new Error('first\nsecond\nthird'); });
    expect(r.detail).toBe('first');
  });

  it('survives a non-Error throw', () => {
    const r = probeBetterSqlite(() => { throw 'a bare string'; });
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('a bare string');
  });
});

describe('CONTROLS — the healthy path, which is every run on every machine', () => {
  class Works {
    constructor(_p: string) { /* fine */ }
    close(): void { /* fine */ }
  }

  it('a working module is reported healthy with no detail', () => {
    expect(probeBetterSqlite(() => Works)).toEqual({ ok: true, detail: '' });
  });

  it('SAYS NOTHING when healthy — no setup line, no teardown', () => {
    // The over-block control. This runs at the start of every suite; a banner on a
    // healthy box would be noise added to the exact problem it exists to solve.
    const written: string[] = [];
    const teardown = runHealthCheck(() => ({ ok: true, detail: '' }), (s) => { written.push(s); });
    expect(written).toEqual([]);
    expect(teardown).toBeUndefined();
  });

  it('CANNOT throw — not even if the probe itself explodes', () => {
    // It is a notice, not a gate, and it runs before every suite. If it threw it
    // would take the whole run down — strictly worse than the degraded state it
    // exists to describe. So a throwing probe is reported, not propagated.
    const written: string[] = [];
    let teardown: (() => void) | void;
    expect(() => {
      teardown = runHealthCheck(() => { throw new Error('probe exploded'); }, (s) => { written.push(s); });
    }).not.toThrow();
    (teardown as () => void)();
    expect(written.join('')).toContain('health probe itself failed: probe exploded');
  });

  it('the real default path does not throw on this machine either', () => {
    expect(() => runHealthCheck(undefined, () => {})).not.toThrow();
  });
});

describe('when it does speak, it carries the remedy', () => {
  const broken: NativeProbeResult = { ok: false, detail: 'Could not locate the bindings file.' };

  it('warns once at setup and returns a teardown that prints the banner', () => {
    const written: string[] = [];
    const teardown = runHealthCheck(() => broken, (s) => { written.push(s); });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('better-sqlite3 unavailable');
    expect(typeof teardown).toBe('function');

    (teardown as () => void)();
    expect(written).toHaveLength(2);
    const banner = written[1]!;
    expect(banner).toContain('Could not locate the bindings file.');
    expect(banner).toContain('npm rebuild better-sqlite3');
    expect(banner).toContain('--ignore-scripts');
    expect(banner).toContain('DOWNSTREAM');
    expect(banner).toContain('not a gate');
  });

  it('never prints an empty reason', () => {
    expect(formatBanner('')).toContain('(no detail reported)');
  });
});

describe('wiring — the setup is actually registered, not merely written', () => {
  const ROOT = path.resolve(__dirname, '..', '..');

  it('vitest.config.ts lists it in globalSetup', () => {
    // "enabled ≠ running": a setup file that exists but is not in the config would
    // be a guard that never runs, which is this window's own recurring defect.
    const cfg = fs.readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf-8');
    expect(cfg).toContain('tests/setup/nativeModuleHealth.globalSetup.ts');
    // CONTROL: the pre-existing entry is still there, so the wiring was added
    // rather than substituted.
    expect(cfg).toContain('tests/setup/build-dist.globalSetup.ts');
  });
});
