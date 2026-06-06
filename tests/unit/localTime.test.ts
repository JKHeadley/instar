/**
 * Tier-1 tests for src/utils/localTime.ts — local-timezone timestamp rendering
 * for agent-facing context blocks.
 *
 * Why this exists (2026-06-05 time-incoherency incident): thread-history
 * surfaces rendered timestamps as unlabeled UTC. An agent read "[21:23:10]"
 * as local wall-clock and told the user "you heard nothing between 9:23pm and
 * now" about a 2:23pm-local event. These tests pin the contract: rendered
 * timestamps are LOCAL (match the host's Date getters) and carry an explicit
 * timezone label.
 *
 * TZ-portability: assertions compare against the same instant's local Date
 * getters rather than hard-coding a zone, so the suite is green in any CI
 * timezone while still proving "local, not UTC".
 */
import { describe, it, expect } from 'vitest';
import { formatLocalTimestamp, localTzAbbreviation } from '../../src/utils/localTime.js';

const pad = (n: number) => String(n).padStart(2, '0');

describe('formatLocalTimestamp', () => {
  it('renders the HOST-local wall-clock for a UTC instant (the incident case)', () => {
    // The actual instant from the 2026-06-05 incident: 21:23:10Z was 14:23 PDT,
    // but the unlabeled-UTC render led the agent to say "9:23pm".
    const iso = '2026-06-05T21:23:10.000Z';
    const d = new Date(iso);
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const out = formatLocalTimestamp(iso);
    expect(out.startsWith(expected)).toBe(true);
    // Unless the host runs in UTC, the local render MUST differ from the UTC slice.
    if (d.getTimezoneOffset() !== 0) {
      expect(out.startsWith('2026-06-05 21:23')).toBe(false);
    }
  });

  it('always carries a timezone label when Intl can resolve one', () => {
    const label = localTzAbbreviation(new Date('2026-06-05T21:23:10Z'));
    const out = formatLocalTimestamp('2026-06-05T21:23:10Z');
    if (label) {
      expect(out.endsWith(` ${label}`)).toBe(true);
    }
    // Shape: YYYY-MM-DD HH:MM [label]
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}( \S+)?$/);
  });

  it('includes the date by default so histories spanning midnight stay unambiguous', () => {
    const out = formatLocalTimestamp('2026-06-06T00:25:35Z');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it('supports date:false and seconds:true options', () => {
    const iso = '2026-06-05T21:23:10Z';
    const d = new Date(iso);
    const noDate = formatLocalTimestamp(iso, { date: false });
    expect(noDate).toMatch(/^\d{2}:\d{2}( \S+)?$/);
    const withSecs = formatLocalTimestamp(iso, { date: false, seconds: true });
    expect(withSecs.startsWith(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`)).toBe(true);
  });

  it('accepts epoch-ms numbers and Date objects', () => {
    const ms = Date.parse('2026-06-05T21:23:10Z');
    expect(formatLocalTimestamp(ms)).toBe(formatLocalTimestamp(new Date(ms)));
  });

  it("renders the '??:??' sentinel for missing / invalid input", () => {
    expect(formatLocalTimestamp(undefined)).toBe('??:??');
    expect(formatLocalTimestamp(null)).toBe('??:??');
    expect(formatLocalTimestamp('')).toBe('??:??');
    expect(formatLocalTimestamp('not-a-date')).toBe('??:??');
  });
});

describe('localTzAbbreviation', () => {
  it('returns a non-empty short label on a normal host (or empty, never throws)', () => {
    const label = localTzAbbreviation();
    expect(typeof label).toBe('string');
  });
});
