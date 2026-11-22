/**
 * Asking again after a no when a real problem shows up (docs/specs/recommended-services.md, "Re-offering after a
 * no" reason 1 and "Real-problem events"): re-offer rows in the signed ledger, the deterministic floor (choice,
 * freshness, cool-offs, the daily cap, spent on delivery, released reservations), the fixed words, and the
 * voice-unreadable source in the shared transcription wrapper.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { RecommendedServicesLedger, foldChoice, validateRow } from '../../src/recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, type CatalogRow } from '../../src/recommended/catalog.js';
import {
  EVENT_FRESH_MS, PROBLEM_KINDS, REOFFER_DAILY_WINDOW_MS, REOFFER_PENDING_TTL_MS, cooloffMs, eventBlock, isDuplicateEvent,
  nextReoffer, renderReoffer, type ReofferFacts,
} from '../../src/recommended/reoffers.js';
import {
  TranscriptionUnavailableError, registerVoiceUnreadableListener, reportVoiceUnreadable, transcribeAudioFileDetailed,
} from '../../src/core/VoiceTranscription.js';

const DAY = 24 * 60 * 60_000;
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signerFor = (machine: string): MachineSigner => ({
  machineId: () => machine, signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: machine, signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
});
const lookup: MachineKeyLookup = () => ({ status: 'ok', publicKeyPem: pem }) as ReturnType<MachineKeyLookup>;
const VOICE = 'voice-transcription';

describe('re-offers after a real problem', () => {
  let dir: string;
  let clock: number;
  let l: RecommendedServicesLedger;
  const make = (machine = 'm_a') => new RecommendedServicesLedger({ stateDir: dir, signer: signerFor(machine), keyLookup: lookup, now: () => new Date(clock) });
  const facts = (): ReofferFacts => ({
    choice: (s) => l.effective(s),
    offer: (s) => l.offerState(s, '42', clock),
    offeredAt: (s) => {
      const ats = l.offerRows('42').filter((r) => r.service === s && r.state === 'offered').map((r) => Date.parse(r.at));
      return ats.length ? Math.max(...ats) : null;
    },
  });
  const decide = (catalog: readonly CatalogRow[] = RECOMMENDED_SERVICE_CATALOG) => nextReoffer(l.reofferRows('42'), catalog, facts(), clock);
  const event = () => l.recordReofferEvent({ service: VOICE, owner: '42', kind: 'voice-unreadable', evidenceRef: 'telegram' });
  const deliver = () => {
    const d = decide();
    if (d.action !== 'send') throw new Error(`expected send, got ${JSON.stringify(d)}`);
    l.recordReofferDelivered(l.recordReofferPending(d.event), 900);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-reoffers-'));
    clock = Date.parse('2026-11-20T00:00:00Z');
    l = make();
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/recommended-services-reoffers.test.ts' }));

  it('re-offer rows validate exactly, replicate to a peer, and never touch the choice fold', () => {
    l.recordNo({ service: VOICE, shutdown: 'none', reason: 'cost', origin: 'first-offer' });
    clock += 1000;
    const e = event();
    expect(e).toMatchObject({ type: 'reoffer', state: 'event', kind: 'voice-unreadable', evidenceRef: 'telegram' });
    expect(e.eventRef).toBeUndefined();
    const p = l.recordReofferPending(e);
    const o = l.recordReofferDelivered(p, 55);
    expect(p.eventRef).toBe(e.eventId);
    expect(o).toMatchObject({ state: 'offered', eventRef: e.eventId, messageId: '55' });
    expect(foldChoice(VOICE, l.all()).choice).toBe('no');
    const peer = new RecommendedServicesLedger({ stateDir: fs.mkdtempSync(path.join(dir, 'peer-')), signer: signerFor('m_b'), keyLookup: lookup });
    for (const row of l.all()) expect(peer.ingestReplicated(row)).toBe('added');
    expect(peer.reofferRows('42')).toHaveLength(3);
    // Exact shapes: free text, an event naming another event, a pending row without one, an offered row without a message id.
    const { sig: _s, ...base } = e;
    expect(validateRow({ ...e, evidenceRef: 'Error: ENOENT /tmp/x' })).toBeNull();
    expect(validateRow({ ...e, eventRef: e.eventId })).toBeNull();
    expect(validateRow({ ...p, eventRef: undefined })).toBeNull();
    expect(validateRow({ ...o, messageId: undefined })).toBeNull();
    expect(validateRow({ ...p, messageId: '3' })).toBeNull();
    expect(validateRow({ ...base, sig: 'x', state: 'sent' })).toBeNull();
  });

  it('a problem after a no re-offers once; one before the no, or with no no at all, does not', () => {
    event();
    expect(decide()).toEqual({ action: 'none', why: 'nothing-waiting' });
    clock += 1000;
    l.recordNo({ service: VOICE, shutdown: 'none', reason: 'cost', origin: 'first-offer' });
    expect(decide().action).toBe('none');
    clock += 1000;
    const after = event();
    const d = decide();
    expect(d).toEqual({ action: 'send', event: after });
  });

  it('a delivered offer the person never answered counts like a no; a yes or an unoffered row never re-offers', () => {
    clock += 1000;
    event();
    expect(eventBlock(l.reofferRows('42')[0]!, l.reofferRows('42'), RECOMMENDED_SERVICE_CATALOG, facts(), clock)).toBe('not-refused');
    l.recordOfferDelivered({ service: VOICE, owner: '42', listId: 'a'.repeat(32), messageId: 1 });
    clock += DAY + 1000;
    const e = event();
    expect(decide()).toEqual({ action: 'send', event: e });
    l.recordYes({ service: VOICE, origin: 'person-asked', offerTextHash: 'x', grantMachine: 'm_a', principal: '42' });
    expect(decide().action).toBe('none');
  });

  it('spent on delivery: the same problem never asks twice, and the next one waits out 90, 180, then 360 days', () => {
    expect([cooloffMs(0), cooloffMs(1), cooloffMs(2), cooloffMs(3), cooloffMs(9)]).toEqual([0, 90 * DAY, 180 * DAY, 360 * DAY, 360 * DAY]);
    l.recordNo({ service: VOICE, shutdown: 'none', reason: 'cost', origin: 'first-offer' });
    for (const wait of [90, 180, 360, 360]) {
      clock += 1000;
      event();
      deliver();
      expect(decide().action).toBe('none');
      clock += (wait - 1) * DAY;
      event();
      expect(decide()).toEqual({ action: 'none', why: 'nothing-waiting' });
      clock += DAY;
    }
    expect(l.reofferRows('42').filter((r) => r.state === 'offered')).toHaveLength(4);
  });

  it('at most one a day across services, and a capped problem waits rather than being dropped', () => {
    l.recordNo({ service: VOICE, shutdown: 'none', reason: 'cost', origin: 'first-offer' });
    clock += 1000;
    // A delivered re-offer for another kind and service an hour ago fills today's allowance.
    const other = l.recordReofferEvent({ service: 'tailscale', owner: '42', kind: 'address-repeatedly-down', evidenceRef: 'tunnel' });
    l.recordReofferDelivered(l.recordReofferPending(other), 1);
    clock += 60 * 60_000;
    const e = event();
    expect(decide()).toEqual({ action: 'none', why: 'daily-cap' });
    clock += REOFFER_DAILY_WINDOW_MS;
    expect(decide()).toEqual({ action: 'send', event: e });
  });

  it('a reservation in flight is resumed, not doubled, and released after a week so the problem can ask again', () => {
    l.recordNo({ service: VOICE, shutdown: 'none', reason: 'cost', origin: 'first-offer' });
    clock += 1000;
    const e = event();
    const p = l.recordReofferPending(e);
    expect(decide()).toEqual({ action: 'resume', pending: p });
    clock += REOFFER_PENDING_TTL_MS;
    expect(decide()).toEqual({ action: 'send', event: e });
  });

  it('an old problem never surfaces when the switch is turned on later, and an unavailable service never re-offers', () => {
    l.recordNo({ service: VOICE, shutdown: 'none', reason: 'cost', origin: 'first-offer' });
    clock += 1000;
    event();
    const dark = RECOMMENDED_SERVICE_CATALOG.map((r) => (r.id === VOICE ? { ...r, setupRecipe: null } : r));
    expect(decide(dark).action).toBe('none');
    clock += EVENT_FRESH_MS;
    expect(decide().action).toBe('none');
  });

  it('a burst of sightings is one event a day', () => {
    event();
    expect(isDuplicateEvent(l.reofferRows('42'), 'voice-unreadable', clock + DAY - 1)).toBe(true);
    expect(isDuplicateEvent(l.reofferRows('42'), 'voice-unreadable', clock + DAY)).toBe(false);
    expect(isDuplicateEvent(l.reofferRows('42'), 'secret-lost', clock)).toBe(false);
  });

  it('the words are fixed per kind, say why now, carry the yes link, and promise the next cool-off', () => {
    const row = RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === VOICE)!;
    const text = renderReoffer('voice-unreadable', row, { linkBase: 'http://10.0.0.5:4042', choice: 'no', deliveredBefore: 0 });
    expect(text.startsWith(PROBLEM_KINDS['voice-unreadable']!.why)).toBe(true);
    expect(text).toContain(`You said no to ${row.name} earlier`);
    expect(text).toContain('http://10.0.0.5:4042/dashboard/service-yes?service=voice-transcription (your PIN)');
    expect(text).toContain('at least 90 days');
    const later = renderReoffer('voice-unreadable', row, { linkBase: null, choice: 'unset', deliveredBefore: 2 });
    expect(later).toContain('was on my list of services');
    expect(later).toContain('open my dashboard and say yes on the Services row');
    expect(later).toContain('at least 360 days');
    expect(() => renderReoffer('made-up', row, { linkBase: null, choice: 'no', deliveredBefore: 0 })).toThrow();
  });
});

describe('the voice-unreadable source', () => {
  afterEach(() => registerVoiceUnreadableListener(null));

  it('the shared wrapper signals with the channel token when nothing can transcribe, and rethrows unchanged', async () => {
    const seen: string[] = [];
    registerVoiceUnreadableListener((ref) => seen.push(ref));
    const err = await transcribeAudioFileDetailed('/nonexistent.ogg', { localEnabled: false, env: {}, channel: 'telegram' } as never).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionUnavailableError);
    await transcribeAudioFileDetailed('/nonexistent.ogg', { localEnabled: false, env: {} } as never).catch(() => undefined);
    expect(seen).toEqual(['telegram', 'voice-note']);
  });

  it('a throwing listener never changes what the channel sees', () => {
    registerVoiceUnreadableListener(() => { throw new Error('boom'); });
    expect(() => reportVoiceUnreadable('whatsapp')).not.toThrow();
  });
});
