// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * FoldHoldStore (context-budget-layered-summaries §10, §14 "Probe/handoff
 * suppression"): held ⇒ refused; release only by the named fold; stale hold
 * sticky while its record is open; scoped fail direction under store faults.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FoldHoldStore, foldHoldCarrier, foldKeyForConversation, MALFORMED_HOLD_FOLD } from '../../src/monitoring/FoldHoldStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/FoldHoldStore.test.ts';
const T = '141133';

describe('FoldHoldStore', () => {
  let stateDir: string;
  let now: number;
  let open: Record<string, boolean | null>;
  let audits: string[];
  const make = () => new FoldHoldStore({
    stateDir, ttlCeilingMs: 30 * 60_000, now: () => now,
    recordOpen: (_t, f) => (f in open ? open[f] : null),
    onAudit: (e) => audits.push(`${e.type}:${e.topicKey}`),
  });
  const file = () => path.join(stateDir, 'state', 'context-layers', T, 'fold-hold.json');

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-hold-'));
    now = Date.parse('2026-11-10T09:00:00Z'); open = {}; audits = [];
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  it('no hold ⇒ allowed, nothing audited', () => {
    expect(make().check(T)).toEqual({ held: false });
    expect(audits).toEqual([]);
  });

  it('a written hold refuses, file 0600 in a 0700 dir', () => {
    const s = make();
    expect(s.write(T, 'f1', now + 60_000)).toBe(true);
    expect(s.check(T)).toEqual({ held: true, foldId: 'f1', basis: 'record' });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file())).mode & 0o777).toBe(0o700);
    expect(audits).toContain(`fold-hold-refused:${T}`);
  });

  it('a hold on one topic never refuses another', () => {
    const s = make();
    s.write(T, 'f1', now + 60_000);
    expect(s.check('999')).toEqual({ held: false });
  });

  it('release only by the named fold', () => {
    const s = make();
    s.write(T, 'f1', now + 60_000);
    s.release(T, 'f2');
    expect(s.check(T).held).toBe(true);
    s.release(T, 'f1');
    expect(s.check(T)).toEqual({ held: false });
  });

  it('past its expiry the hold is sticky while the record is open or unknown, released once terminal', () => {
    const s = make();
    s.write(T, 'f1', now + 60_000);
    now += 120_000;
    open.f1 = true; expect(s.check(T).held).toBe(true);
    delete open.f1; expect(s.check(T).held).toBe(true); // unknown record state ⇒ containment wins
    open.f1 = false; expect(s.check(T)).toEqual({ held: false });
  });

  it('store unreadable with no last-known hold ⇒ allow and audit fold-hold-unreadable', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{torn');
    expect(make().check(T)).toEqual({ held: false, audit: 'fold-hold-unreadable' });
    expect(audits).toEqual([`fold-hold-unreadable:${T}`]);
  });

  it('store unreadable after a held read ⇒ refuse while the record is open, else bounded by the TTL ceiling', () => {
    const s = make();
    s.write(T, 'f1', now + 60_000);
    expect(s.check(T).held).toBe(true);
    fs.writeFileSync(file(), '{torn');
    open.f1 = true;
    expect(s.check(T)).toMatchObject({ held: true, basis: 'last-known' });
    delete open.f1; // record state unknown: bounded by the ceiling from the first unreadable read
    now += 29 * 60_000; expect(s.check(T).held).toBe(true);
    now += 2 * 60_000; expect(s.check(T)).toEqual({ held: false, audit: 'fold-hold-unreadable' });
  });

  it('a known terminal record ends a last-known hold at once', () => {
    const s = make();
    s.write(T, 'f1', now + 60_000);
    s.check(T);
    fs.writeFileSync(file(), '{torn');
    open.f1 = false;
    expect(s.check(T)).toEqual({ held: false, audit: 'fold-hold-unreadable' });
  });

  it('rebuild() restores the known-holds set at boot', () => {
    make().write(T, 'f1', now + 60_000);
    const s = make();
    expect(s.rebuild()).toBe(1);
    fs.writeFileSync(file(), '{torn');
    open.f1 = true;
    expect(s.check(T)).toMatchObject({ held: true, basis: 'last-known' });
  });

  it('refuses unsafe ids and a hold file naming another topic', () => {
    const s = make();
    expect(s.write('../x', 'f1', now + 1)).toBe(false);
    expect(s.write(T, 'bad id', now + 1)).toBe(false);
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ schema: 'fold-hold/1', topicKey: '999', foldId: 'f1', writtenAt: now, expiresAt: now + 1 }));
    expect(s.check(T)).toEqual({ held: false, audit: 'fold-hold-unreadable' });
  });

  it('an expired hold with no readable record keeps refusing but is reported (never silent)', () => {
    const st = make();
    st.write(T, 'f1', now + 60_000);
    now += 120_000;
    expect(st.check(T).held).toBe(true); // record unknown: containment wins
    expect(audits).toContain(`fold-hold-stale-unresolved:${T}`);
  });

  it('a malformed hold file is offered to the boot sweep and the carrier releases it', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{torn');
    const c = foldHoldCarrier(make());
    expect(c.list()).toEqual([{ topicKey: T, foldId: MALFORMED_HOLD_FOLD }]);
    c.release(T, MALFORMED_HOLD_FOLD);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('as a carrier: listed by fold and released by the terminal transition', () => {
    const s = make();
    s.write(T, 'f1', now + 60_000);
    const c = foldHoldCarrier(s);
    expect(c.list()).toEqual([{ topicKey: T, foldId: 'f1' }]);
    c.release(T, 'f1');
    expect(c.list()).toEqual([]);
    expect(s.check(T)).toEqual({ held: false });
  });

  describe('foldKeyForConversation', () => {
    it('a Telegram topic is its numeric id (negative chat ids made path-safe)', () => {
      expect(foldKeyForConversation('telegram', 141133)).toBe('141133');
      expect(foldKeyForConversation('telegram', '141133')).toBe('141133');
      expect(foldKeyForConversation('telegram', '-1001')).toBe('n1001');
      expect(foldKeyForConversation('telegram', 'abc')).toBeNull();
    });
    it('other channels hash to a safe, stable, channel-scoped key', () => {
      const a = foldKeyForConversation('slack', 'C0FOLD');
      expect(a).toMatch(/^slack-[0-9a-f]{32}$/);
      expect(foldKeyForConversation('slack', 'C0FOLD')).toBe(a);
      expect(foldKeyForConversation('app', 'C0FOLD')).not.toBe(a);
      expect(foldKeyForConversation('slack', '141133')).not.toBe('141133'); // never collides with a Telegram topic
      expect(foldKeyForConversation('app', 'conv:with/odd chars')).toMatch(/^app-[0-9a-f]{32}$/);
    });
    it('aliases of one conversation give one key (WhatsApp phone vs JID, iMessage spellings)', () => {
      expect(foldKeyForConversation('whatsapp', '15551234567')).toBe(foldKeyForConversation('whatsapp', '15551234567@s.whatsapp.net'));
      expect(foldKeyForConversation('imessage', '+1 (555) 123-4567')).toBe(foldKeyForConversation('imessage', '5551234567'));
    });
    it('never throws on an id the channel normaliser rejects (runs inside the outbound funnel)', () => {
      expect(() => foldKeyForConversation('whatsapp', 'abc')).not.toThrow();
      expect(() => foldKeyForConversation('whatsapp', '12')).not.toThrow();
      expect(foldKeyForConversation('whatsapp', 'abc')).toMatch(/^whatsapp-[0-9a-f]{32}$/);
    });
    it('a WhatsApp device-suffixed JID is the same chat', () => {
      expect(foldKeyForConversation('whatsapp', '14155552671:3@s.whatsapp.net')).toBe(foldKeyForConversation('whatsapp', '14155552671@s.whatsapp.net'));
    });
    it('the Telegram key is exactly the coordinator topic key (String(topicId))', () => {
      expect(foldKeyForConversation('telegram', 141133)).toBe(String(141133));
    });
    it('refuses empty conversations and unsafe channel names', () => {
      expect(foldKeyForConversation('slack', '')).toBeNull();
      expect(foldKeyForConversation('../x', 'C1')).toBeNull();
    });
  });
});

describe('buildFoldHolds (boot wiring)', () => {
  it('reports an expired hold with no readable record once per fold, not once per refused send', async () => {
    const { buildFoldHolds } = await import('../../src/monitoring/foldCoordinatorBoot.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-hold-boot-'));
    try {
      const reports: string[] = [];
      const holds = buildFoldHolds({ stateDir: dir, onStaleUnresolved: (e) => reports.push(`${e.topicKey}/${e.foldId}`) });
      expect(holds.write('141133', 'f1', Date.now() - 1000)).toBe(true); // already expired, no record
      for (let i = 0; i < 5; i++) expect(holds.check('141133').held).toBe(true);
      expect(reports).toEqual(['141133/f1']);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
    }
  });
});
