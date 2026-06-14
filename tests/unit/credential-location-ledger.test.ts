import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  CredentialLocationLedger,
  CredentialLedgerUnknownModeError,
  type IdentityOracle,
  type IdentityOracleResult,
  type LedgerPoolView,
  type LedgerPoolAccount,
  type CredentialLedgerAttentionInput,
} from '../../src/core/CredentialLocationLedger.js';

/** A deterministic, scriptable identity oracle. */
function oracleFrom(map: Record<string, IdentityOracleResult>, opts?: { throwOn?: string }): IdentityOracle {
  return {
    async resolveSlotTenant(slot: string): Promise<IdentityOracleResult> {
      if (opts?.throwOn === slot) throw new Error('boom');
      return map[slot] ?? { unavailable: true, reason: 'no script' };
    },
  };
}

function poolFrom(accounts: LedgerPoolAccount[]): LedgerPoolView {
  return { list: () => accounts.slice() };
}

let tmp: string;
let counter: number;
const seq = () => `2026-06-13T00:00:${String(counter++).padStart(2, '0')}.000Z`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'credledger-'));
  counter = 0;
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/credential-location-ledger.test.ts cleanup' });
});

function makeLedger(opts: {
  pool: LedgerPoolView;
  oracle?: IdentityOracle;
  attention?: CredentialLedgerAttentionInput[];
}): CredentialLocationLedger {
  return new CredentialLocationLedger({
    stateDir: tmp,
    pool: opts.pool,
    oracle: opts.oracle ?? oracleFrom({}),
    emitAttention: opts.attention ? (i) => void opts.attention!.push(i) : undefined,
    now: seq,
  });
}

describe('CredentialLocationLedger — never-seeded (missing file)', () => {
  it('is OK mode, reads return null, not seeded', () => {
    const led = makeLedger({ pool: poolFrom([]) });
    expect(led.isUnknownMode()).toBe(false);
    expect(led.isSeeded()).toBe(false);
    expect(led.slotOf('acct')).toBeNull();
    expect(led.tenantOf('~/.claude')).toBeNull();
    expect(fs.existsSync(path.join(tmp, 'credential-locations.json'))).toBe(false);
  });
});

describe('CredentialLocationLedger — seedFromOracle', () => {
  it('assigns a slot whose probed email maps to exactly one claude-code account', async () => {
    const pool = poolFrom([
      { id: 'justin-gmail', email: 'justin@gmail.com', configHome: '/h/justin' },
      { id: 'adriana', email: 'adriana@x.com', configHome: '/h/adriana' },
    ]);
    const oracle = oracleFrom({
      '/h/justin': { email: 'justin@gmail.com' },
      '/h/adriana': { email: 'adriana@x.com' },
    });
    const led = makeLedger({ pool, oracle });
    const outcomes = await led.seedFromOracle();

    expect(outcomes.every((o) => o.result === 'assigned')).toBe(true);
    expect(led.isSeeded()).toBe(true);
    expect(led.tenantOf('/h/justin')).toBe('justin-gmail');
    expect(led.slotOf('adriana')).toBe('/h/adriana');
    const a = led.getAssignment('/h/justin')!;
    expect(a.quarantined).toBe(false);
    expect(a.lastVerifiedAt).not.toBeNull();
  });

  it('quarantines (never guesses) when the oracle is unavailable for a slot', async () => {
    const pool = poolFrom([{ id: 'a', email: 'a@x.com', configHome: '/h/a' }]);
    const oracle = oracleFrom({ '/h/a': { unavailable: true, reason: 'timeout' } });
    const led = makeLedger({ pool, oracle });
    const [o] = await led.seedFromOracle();
    expect(o.result).toBe('unavailable');
    expect(led.tenantOf('/h/a')).toBeNull(); // no confirmed tenant
    expect(led.getAssignment('/h/a')!.quarantined).toBe(true);
  });

  it('treats an oracle that THROWS as unavailable (never a mismatch)', async () => {
    const pool = poolFrom([{ id: 'a', email: 'a@x.com', configHome: '/h/a' }]);
    const oracle = oracleFrom({ '/h/a': { email: 'a@x.com' } }, { throwOn: '/h/a' });
    const led = makeLedger({ pool, oracle });
    const [o] = await led.seedFromOracle();
    expect(o.result).toBe('unavailable');
    expect(led.getAssignment('/h/a')!.quarantined).toBe(true);
  });

  it('REFUSES + raises attention on an ambiguous email (two accounts share it)', async () => {
    const attention: CredentialLedgerAttentionInput[] = [];
    const pool = poolFrom([
      { id: 'a1', email: 'shared@org.com', configHome: '/h/shared' },
      { id: 'a2', email: 'shared@org.com', configHome: '/h/other' },
    ]);
    const oracle = oracleFrom({
      '/h/shared': { email: 'shared@org.com' },
      '/h/other': { email: 'shared@org.com' },
    });
    const led = makeLedger({ pool, oracle, attention });
    const outcomes = await led.seedFromOracle();
    expect(outcomes.every((o) => o.result === 'ambiguous')).toBe(true);
    expect(led.tenantOf('/h/shared')).toBeNull();
    expect(attention.length).toBeGreaterThanOrEqual(1);
    expect(attention[0].priority).toBe('HIGH');
    expect(attention[0].id).toContain('ambiguous');
  });

  it('REFUSES + raises attention on an unknown email (no pool account)', async () => {
    const attention: CredentialLedgerAttentionInput[] = [];
    const pool = poolFrom([{ id: 'a', email: 'a@x.com', configHome: '/h/a' }]);
    const oracle = oracleFrom({ '/h/a': { email: 'stranger@nowhere.com' } });
    const led = makeLedger({ pool, oracle, attention });
    const [o] = await led.seedFromOracle();
    expect(o.result).toBe('unknown-email');
    expect(led.getAssignment('/h/a')!.quarantined).toBe(true);
    expect(attention.some((x) => x.id.includes('unknown-email'))).toBe(true);
  });

  it('excludes non-claude-code accounts from seeding', async () => {
    const pool = poolFrom([
      { id: 'claude', email: 'c@x.com', configHome: '/h/claude' },
      { id: 'codex', email: 'cx@x.com', configHome: '/h/codex', framework: 'codex-cli' },
    ]);
    const oracle = oracleFrom({ '/h/claude': { email: 'c@x.com' }, '/h/codex': { email: 'cx@x.com' } });
    const led = makeLedger({ pool, oracle });
    const outcomes = await led.seedFromOracle();
    expect(outcomes.map((o) => o.slot)).toEqual(['/h/claude']);
    expect(led.tenantOf('/h/codex')).toBeNull();
  });
});

describe('CredentialLocationLedger — UNKNOWN mode (corrupt on disk)', () => {
  function writeCorrupt() {
    fs.writeFileSync(path.join(tmp, 'credential-locations.json'), '{ this is not json');
  }
  function writeWrongShape() {
    fs.writeFileSync(path.join(tmp, 'credential-locations.json'), JSON.stringify({ version: 1, nope: true }));
  }

  it('enters UNKNOWN mode on unparseable state and raises ONE HIGH attention item', () => {
    writeCorrupt();
    const attention: CredentialLedgerAttentionInput[] = [];
    const led = makeLedger({ pool: poolFrom([]), attention });
    expect(led.isUnknownMode()).toBe(true);
    expect(attention.filter((a) => a.id === 'credential-ledger-unknown-mode')).toHaveLength(1);
    expect(attention[0].priority).toBe('HIGH');
  });

  it('enters UNKNOWN mode on a wrong-shape file', () => {
    writeWrongShape();
    const led = makeLedger({ pool: poolFrom([]) });
    expect(led.isUnknownMode()).toBe(true);
  });

  it('reads return null in UNKNOWN mode (fail-open-loud)', async () => {
    writeCorrupt();
    const led = makeLedger({ pool: poolFrom([]) });
    expect(led.slotOf('anything')).toBeNull();
    expect(led.tenantOf('anything')).toBeNull();
  });

  it('mutations REFUSE in UNKNOWN mode (fail-closed for moves)', () => {
    writeCorrupt();
    const led = makeLedger({ pool: poolFrom([]) });
    expect(() => led.recordAssignment('/h/a', 'a')).toThrow(CredentialLedgerUnknownModeError);
    expect(() => led.quarantineSlot('/h/a', 'x')).toThrow(CredentialLedgerUnknownModeError);
  });

  it('seedFromOracle clears UNKNOWN mode (the recovery path)', async () => {
    writeCorrupt();
    const pool = poolFrom([{ id: 'a', email: 'a@x.com', configHome: '/h/a' }]);
    const oracle = oracleFrom({ '/h/a': { email: 'a@x.com' } });
    const led = makeLedger({ pool, oracle });
    expect(led.isUnknownMode()).toBe(true);
    await led.seedFromOracle();
    expect(led.isUnknownMode()).toBe(false);
    expect(led.tenantOf('/h/a')).toBe('a');
  });
});

describe('CredentialLocationLedger — recordAssignment (one home per credential)', () => {
  it('re-pointing a slot evicts the prior tenant of that slot AND any stale slot for the account', async () => {
    const pool = poolFrom([
      { id: 'a', email: 'a@x.com', configHome: '/h/a' },
      { id: 'b', email: 'b@x.com', configHome: '/h/b' },
    ]);
    const oracle = oracleFrom({ '/h/a': { email: 'a@x.com' }, '/h/b': { email: 'b@x.com' } });
    const led = makeLedger({ pool, oracle });
    await led.seedFromOracle();
    expect(led.tenantOf('/h/a')).toBe('a');
    expect(led.tenantOf('/h/b')).toBe('b');

    // Swap: move account 'a' into slot /h/b.
    led.recordAssignment('/h/b', 'a');
    expect(led.slotOf('a')).toBe('/h/b'); // a now lives in /h/b only
    expect(led.tenantOf('/h/b')).toBe('a'); // b's old tenant evicted
    // 'a' must not appear twice (one home per credential)
    const aAssignments = led.getAssignments().filter((x) => x.accountId === 'a');
    expect(aAssignments).toHaveLength(1);
  });

  it('bumps version on every mutation', () => {
    const led = makeLedger({ pool: poolFrom([]) });
    const v0 = led.version;
    led.recordAssignment('/h/a', 'a');
    expect(led.version).toBeGreaterThan(v0);
  });
});

describe('CredentialLocationLedger — journal', () => {
  it('keeps all in-flight entries + at most the last 50 completed', () => {
    const led = makeLedger({ pool: poolFrom([]) });
    // one in-flight (begin) entry that never terminates
    led.appendJournal({ op: 'swap', phase: 'begin', slots: ['/h/x'] });
    for (let i = 0; i < 60; i++) led.appendJournal({ op: 'swap', phase: 'done', slots: [`/h/${i}`] });
    const j = led.getJournal();
    const inFlight = j.filter((e) => e.phase === 'begin');
    const done = j.filter((e) => e.phase === 'done');
    expect(inFlight).toHaveLength(1);
    expect(done.length).toBeLessThanOrEqual(50);
    // journal stays sorted by seq
    const seqs = j.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe('CredentialLocationLedger — persistence', () => {
  it('round-trips assignments + journal across a reload', async () => {
    const pool = poolFrom([{ id: 'a', email: 'a@x.com', configHome: '/h/a' }]);
    const oracle = oracleFrom({ '/h/a': { email: 'a@x.com' } });
    const led1 = makeLedger({ pool, oracle });
    await led1.seedFromOracle();
    const v = led1.version;

    const led2 = makeLedger({ pool, oracle });
    expect(led2.isUnknownMode()).toBe(false);
    expect(led2.tenantOf('/h/a')).toBe('a');
    expect(led2.version).toBe(v);
  });

  it('quarantine + unquarantine persist and lift', () => {
    const led1 = makeLedger({ pool: poolFrom([]) });
    led1.recordAssignment('/h/a', 'a');
    led1.quarantineSlot('/h/a', 'oracle down');
    expect(led1.getAssignment('/h/a')!.quarantined).toBe(true);
    led1.unquarantineSlot('/h/a');
    expect(led1.getAssignment('/h/a')!.quarantined).toBe(false);
  });
});
