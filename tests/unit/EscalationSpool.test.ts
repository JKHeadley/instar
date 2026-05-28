/**
 * Unit tests for EscalationSpool — the machine-level outage-page queue with
 * one-shot-per-episode dedup. Spec: macos26-launchd-tcc-runtime-relocation.md (C).
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  spoolPath,
  appendEscalation,
  readEscalations,
  markDelivered,
  firstDetectedDown,
  clearEpisode,
  episodeKey,
  type EscalationEntry,
} from '../../src/core/EscalationSpool.js';

const homes: string[] = [];
function fakeHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-spool-'));
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) {
    try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function entry(over: Partial<EscalationEntry> = {}): EscalationEntry {
  return {
    label: 'ai.instar.b2lead',
    projectDir: '/Users/x/Documents/Projects/b2lead',
    cause: 'tcc-spawn-blocked',
    firstDetectedDown: 1000,
    remediation: 'run instar relocate or grant FDA',
    ts: new Date().toISOString(),
    ...over,
  };
}

describe('EscalationSpool', () => {
  it('appends an entry and reads it back', () => {
    const home = fakeHome();
    expect(appendEscalation(entry(), home)).toBe(true);
    const all = readEscalations(home);
    expect(all).toHaveLength(1);
    expect(all[0].label).toBe('ai.instar.b2lead');
    expect(all[0].cause).toBe('tcc-spawn-blocked');
  });

  it('dedups one-shot per episode (same label + firstDetectedDown)', () => {
    const home = fakeHome();
    expect(appendEscalation(entry({ firstDetectedDown: 1000 }), home)).toBe(true);
    // Same episode (same firstDetectedDown), later tick → must NOT re-append.
    expect(appendEscalation(entry({ firstDetectedDown: 1000, ts: 'later' }), home)).toBe(false);
    expect(readEscalations(home)).toHaveLength(1);
  });

  it('treats a NEW outage (different firstDetectedDown) as a new episode → pages again', () => {
    const home = fakeHome();
    appendEscalation(entry({ firstDetectedDown: 1000 }), home);
    expect(appendEscalation(entry({ firstDetectedDown: 5000 }), home)).toBe(true);
    expect(readEscalations(home)).toHaveLength(2);
  });

  it('spool lives in ~/.instar (outside any TCC folder)', () => {
    const home = fakeHome();
    appendEscalation(entry(), home);
    expect(spoolPath(home)).toBe(path.join(home, '.instar', 'watchdog-escalations.jsonl'));
    expect(fs.existsSync(spoolPath(home))).toBe(true);
  });

  it('writes the spool file mode 0600', () => {
    const home = fakeHome();
    appendEscalation(entry(), home);
    const mode = fs.statSync(spoolPath(home)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('firstDetectedDown persists the stable anchor across ticks', () => {
    const home = fakeHome();
    const t1 = firstDetectedDown('ai.instar.b2lead', 1000, home);
    const t2 = firstDetectedDown('ai.instar.b2lead', 9999, home); // later tick
    expect(t1).toBe(1000);
    expect(t2).toBe(1000); // stable — NOT the new tick's time
  });

  it('clearEpisode resets so the next outage is a fresh episode', () => {
    const home = fakeHome();
    firstDetectedDown('ai.instar.b2lead', 1000, home);
    clearEpisode('ai.instar.b2lead', home);
    const t = firstDetectedDown('ai.instar.b2lead', 7000, home);
    expect(t).toBe(7000); // new episode after recovery
  });

  it('markDelivered flips the delivered flag idempotently', () => {
    const home = fakeHome();
    appendEscalation(entry({ firstDetectedDown: 1000 }), home);
    markDelivered('ai.instar.b2lead', 1000, home);
    expect(readEscalations(home)[0].delivered).toBe(true);
    // Idempotent — second call doesn't throw or duplicate.
    markDelivered('ai.instar.b2lead', 1000, home);
    expect(readEscalations(home).filter((e) => e.label === 'ai.instar.b2lead')).toHaveLength(1);
  });

  it('readEscalations skips malformed lines', () => {
    const home = fakeHome();
    appendEscalation(entry(), home);
    fs.appendFileSync(spoolPath(home), '{ not json\n');
    fs.appendFileSync(spoolPath(home), '\n');
    expect(readEscalations(home)).toHaveLength(1);
  });

  it('episodeKey is stable + label-scoped', () => {
    expect(episodeKey('a', 1)).toBe('a@1');
    expect(episodeKey('a', 1)).not.toBe(episodeKey('b', 1));
  });
});
