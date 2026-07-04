import { describe, it, expect } from 'vitest';
import { parseProcTable } from '../../src/monitoring/ExternalHogProcTable.js';
import { parseProcTimeToSeconds } from '../../src/core/SessionManager.js';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';

/**
 * ExternalHogProcTable — the load-bearing `ps` whole-table parser (CMT-1901, §1/§Testing).
 * REGISTERED in SCRAPE_PARSERS with a captured realness fixture: it must survive the real
 * structural bytes (day-prefix time, embedded-space lstart + comm, <defunct>, malformed short).
 */

describe('parseProcTable (registered parser — captured fixture)', () => {
  it('parses the REAL captured ps process table byte-for-byte', () => {
    const RAW = loadCapturedFixture('ps-proc-table', 'table');
    const rows = parseProcTable(RAW);
    // 8 lines, the last (2-token, permission-denied/malformed) is SKIPPED → 7 rows.
    expect(rows).toHaveLength(7);

    const byPid = new Map(rows.map((r) => [r.pid, r]));

    // A normal row: numeric fields, opaque lstart identity token, comm.
    const zsh = byPid.get(830)!;
    expect(zsh).toMatchObject({ pid: 830, ppid: 818, uid: 501, comm: '-zsh' });
    expect(zsh.startTime).toBe('Thu Jul 2 15:09:11 2026'); // space-padded day collapsed
    expect(zsh.cputimeSeconds).toBeCloseTo(0.1, 5);

    // The ~24h anchor: a `[dd-]hh:mm:ss` day-prefix time + a comm WITH SPACES.
    const anchor = byPid.get(5335)!;
    expect(anchor).toMatchObject({ pid: 5335, ppid: 1, uid: 501, comm: 'Code Helper (Plugin)' });
    // 1-05:42:00 = 1 day + 5h42m = 86400 + 20520 = 106920 s.
    expect(anchor.cputimeSeconds).toBe(106_920);

    // comm with embedded spaces + a URL is preserved.
    expect(byPid.get(2678)!.comm).toBe('npm exec mcp-remote@latest https://xxx.xxxxxx.xx/xxx');
    expect(byPid.get(2633)!.comm).toBe('npm exec @playwright/mcp@latest');

    // A <defunct>/zombie row parses (comm '<defunct>', 0 cputime).
    const defunct = byPid.get(6000)!;
    expect(defunct.comm).toBe('<defunct>');
    expect(defunct.cputimeSeconds).toBe(0);

    // The malformed short row (pid 7000, 2 tokens) was SKIPPED (fail-closed).
    expect(byPid.has(7000)).toBe(false);
  });

  it('parses the REAL captured ps time= values (incl the dd- day-prefix anchor)', () => {
    // parseProcTimeToSeconds is the load-bearing time parser parseProcTable consumes; assert it
    // directly against the fixture's real time= values, especially the dd- day-prefix.
    const rows = parseProcTable(loadCapturedFixture('ps-proc-table', 'table'));
    const anchor = rows.find((r) => r.pid === 5335)!;
    // Re-derive via the raw time token to prove parseProcTimeToSeconds itself handles dd-.
    expect(parseProcTimeToSeconds('1-05:42:00')).toBe(106_920);
    expect(parseProcTimeToSeconds('7:26.57')).toBeCloseTo(446.57, 2); // 7*60 + 26.57
    expect(parseProcTimeToSeconds('0:00.10')).toBeCloseTo(0.1, 5);
    // The parsed row agrees with the direct parse.
    expect(anchor.cputimeSeconds).toBe(parseProcTimeToSeconds('1-05:42:00'));
  });
});

describe('parseProcTable — fail-closed on malformed input', () => {
  it('a row with a MALFORMED time= keeps the row but sets cputimeSeconds undefined (→ CPU-delta UNKNOWN)', () => {
    const line = '  900   800   501 Thu Jul  2 15:09:11 2026   not-a-time some-proc';
    const rows = parseProcTable(line);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cputimeSeconds).toBeUndefined();
  });
  it('a row with a non-numeric pid/ppid/uid is SKIPPED (unidentifiable)', () => {
    expect(parseProcTable('  abc  800  501 Thu Jul  2 15:09:11 2026  0:00.10 x')).toHaveLength(0);
  });
  it('short rows and blank lines are skipped; a non-string input yields []', () => {
    expect(parseProcTable('  7000  6999\n\n   ')).toHaveLength(0);
    expect(parseProcTable(undefined as unknown as string)).toHaveLength(0);
  });
});
