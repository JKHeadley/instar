/**
 * Unit tests for docs/specs/mobile-pairing-introducer.md: the derived introducer key, introduction
 * signing and verification, approvalPath (fb-cceb7986-efa), the wait-screen order and page-open
 * stamp, the creator's CLI, the join carry, and the CLAUDE.md awareness migration.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateIdentityKeyPair, sign } from '@sagemindai/threadline-core';
import {
  deriveIntroducerKey, introducerKeyId, ownerIntroducers, signIntroduction, verifyIntroduction, IntroductionNonces,
  introduceLine, introducePresenceMessage, INTRODUCTION_VERSION,
} from '../../src/server/mobilePairingIntroducer.js';
import { MobilePairingService, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { addIntroducer, removeIntroducer } from '../../src/commands/mobileIntroducer.js';
import { ownerIntroducersForJoin } from '../../src/server/machineRoutes.js';
import { PostUpdateMigrator, MOBILE_PAIRING_CLAUDEMD_SECTION, PAIRING_APPROVE_BULLET, PAIRING_INTRODUCER_BULLET } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-pairing-introducer.test.ts' });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-unit-')); dirs.push(d); return d; };

const id = generateIdentityKeyPair();
const key = deriveIntroducerKey(id);
const entry = { name: 'Echo', publicKey: key.publicKey.toString('base64url') };
const cfg = (introducers: unknown) => ({ mobilePairing: { enabled: true, ownerIntroducers: introducers } }) as unknown as InstarConfig;
const DEV = '00000000-0000-4000-8000-0000000000aa';
const FP = 'ABCD-EF01-2345-6789';
const T0 = 1_800_000_000_000;
const payload = (over: Record<string, unknown> = {}) => ({
  introducerKey: entry.publicKey, introducerName: 'Echo', aud: 'pairtest.example.dev', deviceId: DEV, fingerprint: FP,
  iat: T0, exp: T0 + 120_000, nonce: 'nonce-nonce-nonce-0001', ...over,
});

describe('the introducer key', () => {
  it('is derived, deterministic, and never the identity key', () => {
    expect(deriveIntroducerKey(id).publicKey.equals(key.publicKey)).toBe(true);
    expect(key.publicKey.equals(id.publicKey)).toBe(false);
    expect(deriveIntroducerKey(generateIdentityKeyPair()).publicKey.equals(key.publicKey)).toBe(false);
    expect(introducerKeyId(key.publicKey)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  });
});

describe('the config list', () => {
  it('reads valid entries, skips malformed ones and reports once, caps at 8, dedupes', () => {
    const report = vi.fn();
    const c = cfg([entry, { name: '', publicKey: entry.publicKey }, { name: 'Bad', publicKey: 'xyz' }, { ...entry, name: 'Dup' }]);
    const l = ownerIntroducers(c, report);
    expect(l.map((i) => i.name)).toEqual(['Echo']);
    ownerIntroducers(c, report);
    expect(report).toHaveBeenCalledTimes(1);
    const many = Array.from({ length: 10 }, () => ({ name: 'X', publicKey: deriveIntroducerKey(generateIdentityKeyPair()).publicKey.toString('base64url') }));
    expect(ownerIntroducers(cfg(many)).length).toBe(8);
    expect(ownerIntroducers(cfg(undefined))).toEqual([]);
  });
});

describe('introductions', () => {
  const list = ownerIntroducers(cfg([entry]));
  it('a good one verifies inside its window', () => {
    const s = signIntroduction(payload(), key.privateKey);
    const v = verifyIntroduction(s.introduction, s.signature, list, T0 + 1000);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.payload).toMatchObject({ v: 1, aud: 'pairtest.example.dev', deviceId: DEV, fingerprint: FP });
  });
  it('refuses: wrong key, identity-key signature, flipped byte, unknown introducer, malformed, out of window', () => {
    const s = signIntroduction(payload(), key.privateKey);
    // Signed by the identity key (what a relay could get) under the introducer key's name.
    const byIdentity = signIntroduction(payload(), id.privateKey);
    expect(verifyIntroduction(byIdentity.introduction, byIdentity.signature, list, T0)).toEqual({ ok: false, error: 'introduction-invalid' });
    // Raw identity-key signature over the domain-prefixed bytes: still not the introducer key.
    const raw = Buffer.from(s.introduction, 'base64url');
    const relaySig = sign(id.privateKey, Buffer.concat([Buffer.from(`${INTRODUCTION_VERSION}\n`), raw])).toString('base64url');
    expect(verifyIntroduction(s.introduction, relaySig, list, T0).ok).toBe(false);
    const flipped = Buffer.from(raw.toString().replace(FP, 'ABCD-EF01-2345-6788')).toString('base64url');
    expect(verifyIntroduction(flipped, s.signature, list, T0)).toEqual({ ok: false, error: 'introduction-invalid' });
    const other = deriveIntroducerKey(generateIdentityKeyPair());
    const o = signIntroduction(payload({ introducerKey: other.publicKey.toString('base64url') }), other.privateKey);
    expect(verifyIntroduction(o.introduction, o.signature, list, T0)).toEqual({ ok: false, error: 'introducer-unknown' });
    expect(verifyIntroduction('!!', s.signature, list, T0)).toEqual({ ok: false, error: 'bad-introduction' });
    expect(verifyIntroduction(Buffer.from('[1]').toString('base64url'), s.signature, list, T0)).toEqual({ ok: false, error: 'bad-introduction' });
    const badAud = signIntroduction(payload({ aud: 'Not A Host' }), key.privateKey);
    expect(verifyIntroduction(badAud.introduction, badAud.signature, list, T0)).toEqual({ ok: false, error: 'bad-introduction' });
    expect(verifyIntroduction(s.introduction, s.signature, list, T0 + 120_001)).toEqual({ ok: false, error: 'introduction-expired' });
    expect(verifyIntroduction(s.introduction, s.signature, list, T0 - 30_001)).toEqual({ ok: false, error: 'introduction-expired' });
    const wide = signIntroduction(payload({ exp: T0 + 300_001 }), key.privateKey);
    expect(verifyIntroduction(wide.introduction, wide.signature, list, T0)).toEqual({ ok: false, error: 'introduction-expired' });
  });
  it('nonces are single use and the cache fails closed when full', () => {
    let t = T0;
    const n = new IntroductionNonces(() => t);
    expect(n.take('a', T0 + 1000)).toBe(true);
    expect(n.take('a', T0 + 1000)).toBe(false);
    t = T0 + 70_000;
    expect(n.take('a', T0 + 1000)).toBe(true);
    for (let i = 0; i < 300; i++) n.take(`n${i}`, t + 100_000);
    expect(n.take('fresh', t + 100_000)).toBe(false);
  });
  it('the presence line and message are fixed bytes (the app signs the same)', () => {
    const line = introduceLine('pairtest.example.dev', DEV, FP);
    expect(line).toBe(`introduce pairtest.example.dev ${DEV} ${FP}`);
    expect(introducePresenceMessage('appr', 'Echo.Example.Dev', 'chal', line)).toBe(`instar-owner-introduction-v1\nappr\necho.example.dev\nchal\n${line}`);
  });
});

function service(opts: { telegramOwner?: boolean; native?: boolean; introducers?: unknown; now?: () => number }) {
  const dir = tmp();
  const config = { projectName: 'pairtest', stateDir: dir, port: 0, authToken: 't', mobilePairing: { enabled: true, multiRoute: { enabled: false }, ...(opts.introducers ? { ownerIntroducers: opts.introducers } : {}) } } as unknown as InstarConfig;
  const deps: MobilePairingDeps = { config, stateDir: dir, ownerDM: async () => 1, telegramOwnerPresent: () => opts.telegramOwner === true };
  const svc = new MobilePairingService(deps, opts.now);
  services.push(svc);
  svc.nativeOn = opts.native === true;
  return svc;
}

describe('approvalPath (fb-cceb7986-efa)', () => {
  it('Telegram only with a real owner; else the pairing page when native is on or an introducer exists; else null', () => {
    for (const native of [true, false]) {
      expect(service({ telegramOwner: true, native }).approvalPath()).toBe('telegram');
      expect(service({ native, introducers: [entry] }).approvalPath()).toBe('dashboard');
    }
    expect(service({ native: true }).approvalPath()).toBe('dashboard');
    expect(service({ native: false }).approvalPath()).toBeNull();
  });
});

describe('the pairing-page stamp', () => {
  it('counts as open for 25 s after an operator-session read, and not before or after', () => {
    let t = T0;
    const svc = service({ native: true, now: () => t });
    expect(svc.pairingPageOpen()).toBe(false);
    svc.notePairingPageSeen();
    t += 25_000;
    expect(svc.pairingPageOpen()).toBe(true);
    t += 1;
    expect(svc.pairingPageOpen()).toBe(false);
  });
});

describe('the creator CLI', () => {
  it('adds, dedupes and removes an entry with an atomic write that keeps the file mode', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.instar'));
    const file = path.join(dir, '.instar', 'config.json');
    fs.writeFileSync(file, JSON.stringify({ projectName: 'pairtest', mobilePairing: { enabled: true } }), { mode: 0o600 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    addIntroducer({ dir, name: 'Echo', key: entry.publicKey });
    addIntroducer({ dir, name: 'Echo again', key: entry.publicKey });
    let c = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(c.mobilePairing).toEqual({ enabled: true, ownerIntroducers: [{ name: 'Echo again', publicKey: entry.publicKey }] });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => addIntroducer({ dir, name: 'Bad', key: 'short' })).toThrow(/base64url/);
    removeIntroducer({ dir, key: entry.publicKey });
    c = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(c.mobilePairing.ownerIntroducers).toEqual([]);
    log.mockRestore();
  });
});

describe('the join carry', () => {
  it('the machine-pairing answer carries names and keys only, and nothing when absent', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ authToken: 'secret', mobilePairing: { ownerIntroducers: [{ ...entry, extra: 'x' }, { name: 'Bad', publicKey: 'nope' }] } }));
    expect(ownerIntroducersForJoin(dir)).toEqual({ ownerIntroducers: [entry] });
    const empty = tmp();
    fs.writeFileSync(path.join(empty, 'config.json'), JSON.stringify({ authToken: 'secret' }));
    expect(ownerIntroducersForJoin(empty)).toEqual({});
    expect(ownerIntroducersForJoin(undefined)).toEqual({});
  });
});

describe('CLAUDE.md awareness', () => {
  it('the template carries the line once and the migration adds it idempotently', () => {
    const section = MOBILE_PAIRING_CLAUDEMD_SECTION(4042);
    expect(section.split(PAIRING_INTRODUCER_BULLET).length - 1).toBe(1);
    expect(PAIRING_INTRODUCER_BULLET).toContain('instar mobile introducer show');
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const md = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(md, `# Agent\n${section.replace(`${PAIRING_INTRODUCER_BULLET}\n`, '')}`);
    expect(fs.readFileSync(md, 'utf8')).toContain(PAIRING_APPROVE_BULLET);
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'x' } as never);
    const run = () => (m as unknown as { migrateClaudeMd(r: { upgraded: string[]; errors: string[]; skipped: string[] }): void }).migrateClaudeMd({ upgraded: [], errors: [], skipped: [] });
    run(); run();
    const out = fs.readFileSync(md, 'utf8');
    expect(out.split(PAIRING_INTRODUCER_BULLET).length - 1).toBe(1);
  });
});
