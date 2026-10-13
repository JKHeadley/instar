/**
 * LifelineIngressGuard (docs/specs/telegram-internal-route-lifeline-secret.md):
 * both sides of every decision boundary — mode resolution, arm-on-proof,
 * sender trust, taps, the observe exit rule (quiet window + deadline),
 * persistence across a restart, the restart-signal budget, and what happens
 * when OUR secret is unavailable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LifelineIngressGuard,
  EXIT_QUIET_MS,
  EXIT_MIN_VERIFIED,
  EXIT_DEADLINE_MS,
  SIGNAL_GAP_ARMED_MS,
  SIGNAL_GAP_UNARMED_MS,
  UNARMED_REPORT_AFTER_MS,
  PRE_ARM_TRUST_MS,
  MISMATCH_REPORT_AFTER,
  PERSIST_BURST,
  PERSIST_COALESCE_MS,
  LIFELINE_INGRESS_STATE_RELPATH,
} from '../../src/server/LifelineIngressGuard.js';
import {
  ensureLifelineIngressSecret,
  lifelineIngressSecretPath,
  SECRET_LOAD_BACKOFF_MS,
  LIFELINE_SECRET_HEADER,
  LIFELINE_INGRESS_CALLER_HEADER,
  LIFELINE_INGRESS_CALLER_SERVER_SELF,
} from '../../src/core/LifelineIngressSecret.js';
import { isNeverServed } from '../../src/server/fileRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-10-12T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('LifelineIngressGuard', () => {
  let stateDir: string;
  let now: number;
  let signals: Array<{ previousVersion: string }>;
  let degradations: Array<{ kind: string; reason: string }>;
  let explicit: boolean | undefined;
  let lifelineIsIngress: boolean;
  let signalWriterDeclines: boolean;
  let bypass: boolean;
  let attention: Array<{ id: string; summary: string }>;
  let attentionResult: boolean | Promise<boolean> | undefined;
  const guards: LifelineIngressGuard[] = [];

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-guard-'));
    now = T0;
    signals = [];
    degradations = [];
    explicit = undefined;
    lifelineIsIngress = true;
    signalWriterDeclines = false;
    bypass = false;
    attention = [];
    attentionResult = undefined;
  });
  afterEach(() => {
    for (const g of guards.splice(0)) g.flush();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/lifeline-ingress-guard.test.ts' });
  });

  const make = (developmentAgent = false) => {
    const g = new LifelineIngressGuard({
      stateDir,
      explicitEnforce: () => explicit,
      bypass: () => bypass,
      raiseAttention: (item) => { attention.push({ id: item.id, summary: item.summary }); return attentionResult; },
      config: { developmentAgent },
      lifelineIsIngress: () => lifelineIsIngress,
      writeRestartSignal: (i) => { if (signalWriterDeclines) return false; signals.push(i); return true; },
      reportDegradation: (i) => { degradations.push({ kind: i.kind, reason: i.reason }); },
      now: () => now,
      log: () => {},
      bootNudgeDelayMs: null,
    });
    guards.push(g);
    return g;
  };
  /** Simulate a server restart: flush the old instance, build a new one. */
  const restart = (g: LifelineIngressGuard, developmentAgent = false) => { g.flush(); return make(developmentAgent); };
  const secret = () => ensureLifelineIngressSecret(stateDir);
  const good = () => ({ [LIFELINE_SECRET_HEADER]: secret() });
  const wrong = () => ({ [LIFELINE_SECRET_HEADER]: 'b'.repeat(64) });
  const selfCall = () => ({ ...good(), [LIFELINE_INGRESS_CALLER_HEADER]: LIFELINE_INGRESS_CALLER_SERVER_SELF });
  const h = (g: LifelineIngressGuard) => g.health() as Record<string, any>;
  const kinds = () => degradations.map((d) => d.kind);

  describe('mode resolution', () => {
    it('fleet default is observe; development agent default is enforce', () => {
      expect(make(false).mode()).toBe('observe');
      expect(make(true).mode()).toBe('enforce');
    });
    it('an explicit setting wins on both agent classes', () => {
      explicit = true;
      expect(make(false).mode()).toBe('enforce');
      explicit = false;
      expect(make(true).mode()).toBe('observe');
    });
    it('the explicit setting is read live, including its removal', () => {
      const g = make(false);
      expect(g.mode()).toBe('observe');
      explicit = true;
      expect(g.mode()).toBe('enforce');
      explicit = undefined;
      expect(g.mode()).toBe('observe');
    });
  });

  describe('observe (messages)', () => {
    it('accepts a message with no secret and counts it as would-refuse: missing', () => {
      const g = make(false);
      const d = g.evaluate({}, 'telegram-forward', { lifelineVersion: '1.3.100' });
      expect(d).toMatchObject({ action: 'accept', verified: false, mode: 'observe', reason: 'missing' });
      expect(h(g)).toMatchObject({ wouldRefuse: 1, refused: 0 });
      expect(h(g).byReason.missing).toBe(1);
      expect(h(g).byRoute['telegram-forward'].wouldRefuse).toBe(1);
    });
    it('accepts a message with a wrong secret, counts mismatch, and hints the caller', () => {
      const g = make(false);
      const d = g.evaluate(wrong(), 'telegram-forward');
      expect(d).toMatchObject({ action: 'accept', reason: 'mismatch', staleSecretHint: true });
      expect(h(g).byReason.mismatch).toBe(1);
    });
    it('still accepts a MESSAGE after the lifeline has proven itself', () => {
      const g = make(false);
      g.evaluate(good(), 'telegram-forward');
      expect(g.evaluate({}, 'telegram-forward').action).toBe('accept');
    });
  });

  describe('sender trust', () => {
    it('a verified request is trusted', () => {
      expect(make(false).evaluate(good(), 'telegram-forward').senderTrusted).toBe(true);
    });
    it('before arming, an unproven message is still trusted (the pre-change lifeline)', () => {
      expect(make(false).evaluate({}, 'telegram-forward').senderTrusted).toBe(true);
    });
    it('losing the guard state does not buy a fresh allowance: the secret file dates the feature', () => {
      // This machine has had the secret for two days…
      ensureLifelineIngressSecret(stateDir);
      const twoDaysAgo = new Date(T0 - 2 * PRE_ARM_TRUST_MS);
      fs.utimesSync(lifelineIngressSecretPath(stateDir), twoDaysAgo, twoDaysAgo);
      // …and its guard state is gone (or was corrupt): a brand-new observingSince.
      const g = make(true);
      expect(h(g).observingSince).toBe(new Date(T0).toISOString());
      expect(g.evaluate({}, 'telegram-forward')).toMatchObject({ action: 'accept', senderTrusted: false });
      expect(g.evaluate({}, 'telegram-callback').action).toBe('refuse');
    });
    it('in ENFORCE that allowance is bounded: 24 hours unarmed and the message is delivered WITHOUT trust', () => {
      const g = make(true);
      now = T0 + PRE_ARM_TRUST_MS - 1;
      expect(g.evaluate({}, 'telegram-forward')).toMatchObject({ action: 'accept', senderTrusted: true });
      now = T0 + PRE_ARM_TRUST_MS;
      // Still never REFUSED before arming — even in enforce — only untrusted.
      expect(g.evaluate({}, 'telegram-forward')).toMatchObject({ action: 'accept', senderTrusted: false });
      expect(h(g).armed).toBe(false);
    });
    it('after arming, an unproven message is delivered but NOT trusted — in observe too', () => {
      const g = make(false);
      g.evaluate(good(), 'lifeline-proof');
      expect(g.evaluate({}, 'telegram-forward')).toMatchObject({ action: 'accept', senderTrusted: false });
      expect(g.evaluate(wrong(), 'telegram-forward')).toMatchObject({ action: 'accept', senderTrusted: false });
    });
  });

  describe('button taps', () => {
    it('before arming, an unproven tap is accepted (the pre-change lifeline)', () => {
      expect(make(false).evaluate({}, 'telegram-callback').action).toBe('accept');
      expect(make(true).evaluate({}, 'telegram-callback').action).toBe('accept');
    });
    it('in OBSERVE an unarmed guard never degrades real traffic, however long it stays unarmed', () => {
      const g = make(false);
      now = T0 + PRE_ARM_TRUST_MS * 30;
      expect(g.evaluate({}, 'telegram-forward')).toMatchObject({ action: 'accept', senderTrusted: true });
      expect(g.evaluate({}, 'telegram-callback')).toMatchObject({ action: 'accept', senderTrusted: true });
      expect(h(g)).toMatchObject({ armed: false, refusingTaps: false, preArmTrustEndsAt: null });
      // …but the operator is told (report + attention item), and the posture row reads off.
      expect(kinds()).toEqual(['unarmed']);
      expect(attention.map((a) => a.id)).toEqual([`telegram-ingress:unarmed:${new Date(now).toISOString().slice(0, 10)}`]);
      expect(attention[0].summary).toContain('is not active yet');
      expect(g.guardStatus().enabled).toBe(false);
    });
    it('in ENFORCE that allowance is bounded: 24 hours unarmed and an unproven tap is refused', () => {
      const g = make(true);
      now = T0 + PRE_ARM_TRUST_MS - 1;
      expect(g.evaluate({}, 'telegram-callback').action).toBe('accept');
      expect(h(g).refusingTaps).toBe(false);
      now = T0 + PRE_ARM_TRUST_MS;
      expect(g.evaluate({}, 'telegram-callback')).toMatchObject({ action: 'refuse', reason: 'missing' });
      expect(h(g)).toMatchObject({ armed: false, refusingTaps: true, refusing: false });
    });
    it('/health says taps are refused in observe once armed, even though messages are not', () => {
      const g = make(false);
      g.evaluate(good(), 'lifeline-proof');
      expect(h(g)).toMatchObject({ mode: 'observe', refusing: false, refusingTaps: true });
    });
    it('after arming, an unproven tap is REFUSED in observe as well as enforce', () => {
      const observe = make(false);
      observe.evaluate(good(), 'lifeline-proof');
      expect(observe.mode()).toBe('observe');
      expect(observe.evaluate({}, 'telegram-callback')).toMatchObject({ action: 'refuse', reason: 'missing' });
      expect(h(observe).byRoute['telegram-callback'].refused).toBe(1);
    });
    it('a proven tap is accepted', () => {
      const g = make(true);
      expect(g.evaluate(good(), 'telegram-callback')).toMatchObject({ action: 'accept', verified: true });
    });
  });

  describe('enforce is armed only by proof', () => {
    it('does NOT refuse before the lifeline has ever sent the valid secret', () => {
      const g = make(true);
      const d = g.evaluate({}, 'telegram-forward', { lifelineVersion: '1.3.100' });
      expect(d).toMatchObject({ action: 'accept', verified: false, mode: 'enforce', reason: 'missing' });
      expect(h(g)).toMatchObject({ armed: false, refusing: false, wouldRefuse: 1 });
    });
    it('refuses a secretless message once the lifeline has proven itself', () => {
      const g = make(true);
      expect(g.evaluate(good(), 'telegram-forward')).toMatchObject({ action: 'accept', verified: true });
      expect(g.evaluate({}, 'telegram-forward')).toMatchObject({ action: 'refuse', verified: false, reason: 'missing' });
      expect(h(g)).toMatchObject({ refused: 1, armedBy: 'lifeline-proof', refusing: true });
    });
    it('the startup proof alone arms it (no Telegram message needed)', () => {
      const g = make(true);
      g.evaluate(good(), 'lifeline-proof');
      expect(h(g).armed).toBe(true);
      expect(g.evaluate({}, 'telegram-forward').action).toBe('refuse');
    });
    it('refuses a wrong secret once armed, with no stale hint (the 401 is the hint)', () => {
      const g = make(true);
      g.evaluate(good(), 'telegram-callback');
      expect(g.evaluate({ [LIFELINE_SECRET_HEADER]: 'c'.repeat(64) }, 'telegram-forward'))
        .toMatchObject({ action: 'refuse', reason: 'mismatch', staleSecretHint: false });
    });
    it('the server\'s own valid call is accepted but does NOT arm', () => {
      const g = make(true);
      expect(g.evaluate(selfCall(), 'telegram-forward')).toMatchObject({ action: 'accept', verified: true });
      expect(h(g)).toMatchObject({ armed: false, verifiedServerSelf: 1 });
      expect(g.evaluate({}, 'telegram-forward').action).toBe('accept');
    });
    it('the server-self label without the secret gains nothing', () => {
      const g = make(true);
      g.evaluate(good(), 'lifeline-proof');
      const d = g.evaluate({ [LIFELINE_INGRESS_CALLER_HEADER]: LIFELINE_INGRESS_CALLER_SERVER_SELF }, 'telegram-forward');
      expect(d.action).toBe('refuse');
    });
    it('arming survives a server restart', () => {
      const first = make(true);
      first.evaluate(good(), 'telegram-forward');
      const restarted = restart(first, true);
      expect(h(restarted).armed).toBe(true);
      expect(restarted.evaluate({}, 'telegram-forward').action).toBe('refuse');
    });
    it('a valid request is still accepted while refusing others', () => {
      const g = make(true);
      g.evaluate(good(), 'telegram-forward');
      g.evaluate({}, 'telegram-forward');
      expect(g.evaluate(good(), 'telegram-forward')).toMatchObject({ action: 'accept', verified: true });
    });
  });

  describe('a machine where the lifeline is not the Telegram ingress', () => {
    it('arms at once: there is no lifeline to wait for', () => {
      lifelineIsIngress = false;
      const g = make(true);
      expect(g.evaluate({}, 'telegram-forward')).toMatchObject({ action: 'refuse', senderTrusted: false });
      expect(h(g)).toMatchObject({ armed: true, armedBy: 'no-lifeline-ingress' });
    });
    it('there is nothing to observe either: a fleet agent enforces at once', () => {
      lifelineIsIngress = false;
      const g = make(false);
      expect(g.evaluate({}, 'telegram-forward')).toMatchObject({ action: 'refuse', mode: 'enforce' });
    });
    it('explicit enforce:false still holds observe there (delivered, untrusted)', () => {
      lifelineIsIngress = false;
      explicit = false;
      expect(make(false).evaluate({}, 'telegram-forward')).toMatchObject({ action: 'accept', senderTrusted: false });
    });
    it('reading /health or the posture row arms it without any request, and /health says why it enforces', () => {
      lifelineIsIngress = false;
      expect(h(make(false))).toMatchObject({
        armed: true, armedBy: 'no-lifeline-ingress', mode: 'enforce', modeSource: 'no-lifeline-ingress',
      });
    });
    it('where the lifeline IS the ingress, the same request does not arm', () => {
      const g = make(true);
      g.evaluate({}, 'telegram-forward');
      expect(h(g).armed).toBe(false);
    });
  });

  describe('bypass (the full rollback)', () => {
    it('restores the pre-change handling for every request, armed or not, in enforce too', () => {
      explicit = true;
      const g = make(true);
      g.evaluate(good(), 'lifeline-proof');
      expect(g.evaluate({}, 'telegram-forward').action).toBe('refuse');
      bypass = true;
      expect(g.evaluate({}, 'telegram-forward')).toMatchObject({ action: 'accept', verified: false, senderTrusted: true });
      expect(g.evaluate({}, 'telegram-callback')).toMatchObject({ action: 'accept', senderTrusted: true });
      expect(g.evaluate(wrong(), 'telegram-forward')).toMatchObject({ action: 'accept', staleSecretHint: false });
    });
    it('is counted, reported, and visible on /health and the guard-posture row', () => {
      const g = make(true);
      g.evaluate(good(), 'lifeline-proof');
      bypass = true;
      g.evaluate({}, 'telegram-forward');
      expect(kinds()).toEqual(['bypassed']);
      expect(h(g)).toMatchObject({ bypassedByConfig: true, refusing: false, refusingTaps: false, wouldRefuse: 1 });
      expect(g.guardStatus()).toEqual({ enabled: false, dryRun: false });
    });
    it('is read live: removing it restores the guard at once', () => {
      const g = make(true);
      g.evaluate(good(), 'lifeline-proof');
      bypass = true;
      g.evaluate({}, 'telegram-forward');
      bypass = false;
      expect(g.evaluate({}, 'telegram-forward').action).toBe('refuse');
    });
    it('is total: it also overrides the no-secret refusal of taps', () => {
      fs.mkdirSync(lifelineIngressSecretPath(stateDir), { recursive: true }); // secret can be neither read nor created
      bypass = true;
      const g = make(true);
      expect(g.evaluate({}, 'telegram-callback')).toMatchObject({ action: 'accept', senderTrusted: true });
      expect(g.evaluate({}, 'telegram-forward')).toMatchObject({ action: 'accept', senderTrusted: true });
    });
    it('a verified request is unaffected by it', () => {
      bypass = true;
      expect(make(true).evaluate(good(), 'telegram-forward')).toMatchObject({ action: 'accept', verified: true });
    });
  });

  describe('guard-posture row', () => {
    it('unarmed with a lifeline expected: not enabled (off while expected on)', () => {
      expect(make(true).guardStatus()).toEqual({ enabled: false, dryRun: false });
      expect(make(false).guardStatus()).toEqual({ enabled: false, dryRun: false });
    });
    it('armed: enabled — default observe is NOT reported as a dry run (it already protects and ends by itself)', () => {
      const g = make(false);
      g.evaluate(good(), 'lifeline-proof');
      expect(g.mode()).toBe('observe');
      expect(g.guardStatus()).toEqual({ enabled: true, dryRun: false });
    });
    it('observe HELD by config is reported as a dry run', () => {
      explicit = false;
      const g = make(true);
      g.evaluate(good(), 'lifeline-proof');
      expect(g.guardStatus()).toEqual({ enabled: true, dryRun: true });
    });
    it('no lifeline to wait for: enabled without any request, on either agent class', () => {
      lifelineIsIngress = false;
      expect(make(true).guardStatus()).toEqual({ enabled: true, dryRun: false });
      expect(make(false).guardStatus()).toEqual({ enabled: true, dryRun: false });
    });
  });

  describe('boot nudge (a quiet machine is not left waiting for its first message)', () => {
    it('unarmed with a lifeline expected: writes ONE budgeted restart signal and pins the state on disk', () => {
      const g = make(false);
      g.bootNudge();
      expect(signals).toEqual([{ previousVersion: 'unknown' }]);
      const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, LIFELINE_INGRESS_STATE_RELPATH), 'utf-8'));
      expect(onDisk.observingSince).toBe(new Date(T0).toISOString());
      expect(fs.existsSync(lifelineIngressSecretPath(stateDir))).toBe(true);
      // The first unverified request afterwards is inside the same budget.
      g.evaluate({}, 'telegram-forward');
      expect(signals.length).toBe(1);
    });
    it('already armed: no signal', () => {
      const first = make(true);
      first.evaluate(good(), 'lifeline-proof');
      const restarted = restart(first, true);
      restarted.bootNudge();
      expect(signals).toEqual([]);
    });
    it('no lifeline to wait for: arms instead of signalling', () => {
      lifelineIsIngress = false;
      const g = make(true);
      g.bootNudge();
      expect(signals).toEqual([]);
      expect(h(g).armedBy).toBe('no-lifeline-ingress');
    });
    it('a declined write (server version unknown) leaves the budget unspent', () => {
      signalWriterDeclines = true;
      const g = make(false);
      g.bootNudge();
      expect(h(g).lastSignalAt).toBeNull();
    });
    it('bypassed: does nothing', () => {
      bypass = true;
      const g = make(false);
      g.bootNudge();
      expect(signals).toEqual([]);
    });
    it('a removed state dir (torn-down agent) is left alone', () => {
      const g = make(false);
      SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/lifeline-ingress-guard.test.ts' });
      g.bootNudge();
      expect(fs.existsSync(stateDir)).toBe(false);
      expect(signals).toEqual([]);
      fs.mkdirSync(stateDir, { recursive: true });
    });
  });

  describe('a replaced secret file', () => {
    it('is picked up by re-reading on mismatch, so the new value verifies', () => {
      const g = make(true);
      g.evaluate(good(), 'telegram-forward');
      const replacement = 'd'.repeat(64);
      fs.writeFileSync(lifelineIngressSecretPath(stateDir), replacement);
      now += 10_000;
      expect(g.evaluate({ [LIFELINE_SECRET_HEADER]: replacement }, 'telegram-forward'))
        .toMatchObject({ action: 'accept', verified: true });
    });
    it('a re-read that FAILS keeps the last good secret — it never fails open', () => {
      const g = make(true);
      g.evaluate(good(), 'telegram-forward');
      const real = secret();
      // The file becomes unreadable-as-a-file; a wrong header triggers a re-read.
      SafeFsExecutor.safeRmSync(lifelineIngressSecretPath(stateDir), { force: true, operation: 'tests/unit/lifeline-ingress-guard.test.ts' });
      fs.mkdirSync(lifelineIngressSecretPath(stateDir));
      now += 10_000;
      expect(g.evaluate(wrong(), 'telegram-forward')).toMatchObject({ action: 'refuse', reason: 'mismatch' });
      expect(g.evaluate({}, 'telegram-forward').action).toBe('refuse');
      expect(g.evaluate({ [LIFELINE_SECRET_HEADER]: real }, 'telegram-forward')).toMatchObject({ action: 'accept', verified: true });
    });
  });

  describe('our own secret unavailable (never held in this process)', () => {
    const breakSecret = () => fs.writeFileSync(path.join(stateDir, 'state'), 'a file where the directory should be');

    it('a message is delivered with no sender trust, even in enforce', () => {
      breakSecret();
      explicit = true;
      const g = make(true);
      expect(g.evaluate({}, 'telegram-forward'))
        .toMatchObject({ action: 'accept', verified: false, reason: 'secret-unavailable', senderTrusted: false });
      expect(h(g)).toMatchObject({ secretAvailable: false, refusing: false, secretUnavailable: 1 });
    });
    it('a tap is refused: nobody can be verified', () => {
      breakSecret();
      expect(make(false).evaluate({}, 'telegram-callback')).toMatchObject({ action: 'refuse', reason: 'secret-unavailable' });
    });
    it('heals first, reports second: no report until a retried load has failed too', () => {
      breakSecret();
      const g = make(false);
      g.evaluate({}, 'telegram-forward');
      expect(kinds()).toEqual([]);
      now += SECRET_LOAD_BACKOFF_MS;
      g.evaluate({}, 'telegram-forward');
      expect(kinds()).toEqual(['secret-unavailable']);
    });
    it('recovers by itself once the file can be created', () => {
      breakSecret();
      const g = make(true);
      g.evaluate({}, 'telegram-forward');
      SafeFsExecutor.safeRmSync(path.join(stateDir, 'state'), { force: true, operation: 'tests/unit/lifeline-ingress-guard.test.ts' });
      now += SECRET_LOAD_BACKOFF_MS;
      expect(g.evaluate(good(), 'telegram-forward')).toMatchObject({ action: 'accept', verified: true });
    });
  });

  describe('restart signal', () => {
    it('before arming: written on the first would-refuse, carrying the lifeline version it saw', () => {
      const g = make(false);
      g.evaluate({}, 'telegram-forward', { lifelineVersion: '1.3.900' });
      expect(signals).toEqual([{ previousVersion: '1.3.900' }]);
    });
    it('before arming: at most one per 12 hours', () => {
      const g = make(false);
      g.evaluate({}, 'telegram-forward');
      now += SIGNAL_GAP_UNARMED_MS - 1;
      g.evaluate({}, 'telegram-forward');
      expect(signals.length).toBe(1);
      now += 1;
      g.evaluate({}, 'telegram-forward');
      expect(signals.length).toBe(2);
    });
    it('after arming: a refusal writes it, at most once per 24 hours', () => {
      const g = make(true);
      g.evaluate(good(), 'telegram-forward');
      g.evaluate({}, 'telegram-forward', { lifelineVersion: '1.3.900' });
      expect(signals).toEqual([{ previousVersion: '1.3.900' }]);
      now += SIGNAL_GAP_ARMED_MS - 1;
      g.evaluate({}, 'telegram-forward');
      expect(signals.length).toBe(1);
      now += 1;
      g.evaluate({}, 'telegram-forward');
      expect(signals.length).toBe(2);
    });
    it('the budget survives a server restart', () => {
      const first = make(true);
      first.evaluate(good(), 'telegram-forward');
      first.evaluate({}, 'telegram-forward');
      const restarted = restart(first, true);
      restarted.evaluate({}, 'telegram-forward');
      expect(signals.length).toBe(1);
    });
    it('a declined write (server version unknown) does not spend the budget', () => {
      signalWriterDeclines = true;
      const g = make(false);
      g.evaluate({}, 'telegram-forward');
      expect(h(g).lastSignalAt).toBeNull();
      signalWriterDeclines = false;
      g.evaluate({}, 'telegram-forward');
      expect(signals.length).toBe(1);
    });
    it('another writer acting on an unverified request shares the same budget', () => {
      const g = make(true);
      expect(g.spendSignalBudget()).toBe(true);
      expect(g.spendSignalBudget()).toBe(false);
      g.evaluate({}, 'telegram-forward'); // the guard's own write is now inside the gap too
      expect(signals.length).toBe(0);
      now += SIGNAL_GAP_UNARMED_MS;
      expect(g.spendSignalBudget()).toBe(true);
    });
    it('a throwing signal writer never turns an accept into an error', () => {
      const g = new LifelineIngressGuard({
        stateDir, explicitEnforce: () => undefined, config: {},
        writeRestartSignal: () => { throw new Error('disk full'); }, now: () => now, log: () => {}, bootNudgeDelayMs: null,
      });
      guards.push(g);
      expect(g.evaluate({}, 'telegram-forward').action).toBe('accept');
    });
  });

  describe('reports', () => {
    it('a secretless request after arming is reported at once, then at most hourly', () => {
      const g = make(false);
      g.evaluate(good(), 'telegram-forward');
      g.evaluate({}, 'telegram-forward');
      g.evaluate({}, 'telegram-forward');
      expect(kinds()).toEqual(['unproven-after-arming']);
      now += HOUR + 1;
      g.evaluate({}, 'telegram-forward');
      expect(kinds()).toEqual(['unproven-after-arming', 'unproven-after-arming']);
    });
    it('a WRONG secret after arming is the same security report — it cannot be used to stay quiet', () => {
      const g = make(false);
      g.evaluate(good(), 'telegram-forward');
      g.evaluate(wrong(), 'telegram-forward');
      expect(kinds()).toEqual(['unproven-after-arming']);
    });
    it('the security report also reaches the operator: one attention item a day at most', () => {
      const g = make(true);
      g.evaluate(good(), 'telegram-forward');
      g.evaluate({}, 'telegram-forward');
      g.evaluate({}, 'telegram-callback');
      expect(attention.map((a) => a.id)).toEqual(['telegram-ingress:unproven-after-arming:2026-10-12']);
      expect(attention[0].summary).toContain('It was refused.');
      now += 24 * HOUR;
      g.evaluate({}, 'telegram-forward');
      // A later episode is a NEW item (dated id), so a resolved earlier one cannot hide it.
      expect(attention.map((a) => a.id)).toEqual([
        'telegram-ingress:unproven-after-arming:2026-10-12',
        'telegram-ingress:unproven-after-arming:2026-10-13',
      ]);
    });
    it('the attention throttle survives a server restart', () => {
      const first = make(true);
      first.evaluate(good(), 'telegram-forward');
      first.evaluate({}, 'telegram-forward');
      const restarted = restart(first, true);
      restarted.evaluate({}, 'telegram-forward');
      expect(attention.length).toBe(1);
    });
    it('if nothing reached the operator, the daily throttle is released and the next occurrence tries again', async () => {
      const g = make(true);
      g.evaluate(good(), 'telegram-forward');
      attentionResult = false;                 // e.g. no Telegram adapter
      g.evaluate({}, 'telegram-forward');
      g.evaluate({}, 'telegram-forward');
      expect(attention.length).toBe(2);        // not throttled: the first did not land
      attentionResult = Promise.resolve(false); // async failure
      g.evaluate({}, 'telegram-forward');
      await Promise.resolve(); await Promise.resolve();
      attentionResult = true;
      g.evaluate({}, 'telegram-forward');
      g.evaluate({}, 'telegram-forward');
      expect(attention.length).toBe(4);        // the fourth landed; the fifth is throttled
    });
    it('the pre-arm allowance running out with the lifeline still not updated reaches the operator (enforce: and says traffic is now degraded)', () => {
      const g = make(true);
      now = T0 + PRE_ARM_TRUST_MS;
      g.evaluate({}, 'telegram-forward');
      expect(kinds()).toEqual(['unarmed']);
      expect(attention.map((a) => a.id)).toEqual(['telegram-ingress:unarmed:2026-10-13']);
      expect(attention[0].summary).toContain('without a verified sender');
    });
    it('a request accepted because of bypass reaches the operator too', () => {
      const g = make(true);
      bypass = true;
      g.evaluate({}, 'telegram-callback');
      expect(attention.map((a) => a.id)).toEqual(['telegram-ingress:bypassed:2026-10-12']);
    });
    it('a recoverable notice cannot use up the slot a security notice needs (throttle is per kind)', () => {
      const g = make(false);
      now = T0 + PRE_ARM_TRUST_MS;
      g.evaluate({}, 'telegram-forward');                 // "the lifeline has not updated"
      expect(attention.map((a) => a.id)).toEqual(['telegram-ingress:unarmed:2026-10-13']);
      g.evaluate(good(), 'lifeline-proof');               // the lifeline is restarted and proves itself
      g.evaluate({}, 'telegram-forward');                 // …and a session forges a request the same day
      expect(attention.map((a) => a.id)).toEqual([
        'telegram-ingress:unarmed:2026-10-13',
        'telegram-ingress:unproven-after-arming:2026-10-13',
      ]);
    });
    it('a persistently WRONG secret does not hide that the guard is unarmed, or that a day has passed', () => {
      const g = make(true);
      now = T0 + PRE_ARM_TRUST_MS;
      for (let i = 0; i < MISMATCH_REPORT_AFTER + 2; i++) { now += 6_000; g.evaluate(wrong(), 'telegram-forward'); }
      expect(kinds()).toEqual(expect.arrayContaining(['secret-mismatch', 'unarmed']));
      expect(attention.map((a) => a.id)).toEqual(['telegram-ingress:unarmed:2026-10-13']);
    });
    it('no attention item before arming (an old lifeline is expected, not suspicious)', () => {
      const g = make(true);
      g.evaluate({}, 'telegram-forward');
      now += 2 * HOUR;
      g.evaluate({}, 'telegram-forward');
      expect(attention).toEqual([]);
    });
    it('before arming, a secretless request is not reported in the first hour (an old lifeline is expected)', () => {
      const g = make(false);
      g.evaluate({}, 'telegram-forward');
      now += UNARMED_REPORT_AFTER_MS - 1;
      g.evaluate({}, 'telegram-forward');
      expect(kinds()).toEqual([]);
    });
    it('still unarmed after an hour: reported, because nothing is being guarded', () => {
      const g = make(false);
      now += UNARMED_REPORT_AFTER_MS;
      g.evaluate({}, 'telegram-forward');
      expect(kinds()).toEqual(['unarmed']);
    });
    it('a wrong secret is reported only once it persists', () => {
      const g = make(false);
      for (let i = 0; i < MISMATCH_REPORT_AFTER - 1; i++) { now += 6_000; g.evaluate(wrong(), 'telegram-forward'); }
      expect(kinds()).toEqual([]);
      now += 6_000;
      g.evaluate(wrong(), 'telegram-forward');
      expect(kinds()).toEqual(['secret-mismatch']);
    });
    it('a verified request in between resets the wrong-secret streak', () => {
      const g = make(false);
      for (let i = 0; i < MISMATCH_REPORT_AFTER - 1; i++) { now += 6_000; g.evaluate(wrong(), 'telegram-forward'); }
      g.evaluate(good(), 'telegram-forward');
      now += 6_000;
      g.evaluate(wrong(), 'telegram-forward');
      expect(kinds()).not.toContain('secret-mismatch');
    });
  });

  describe('observe exit rule', () => {
    const verify = (g: LifelineIngressGuard, n: number) => {
      for (let i = 0; i < n; i++) g.evaluate(good(), 'telegram-forward');
    };

    it('graduates to enforce after the quiet window with enough verified requests', () => {
      const g = make(false);
      verify(g, EXIT_MIN_VERIFIED);
      expect(g.mode()).toBe('observe');
      now += EXIT_QUIET_MS;
      verify(g, 1);
      expect(g.mode()).toBe('enforce');
      expect(g.modeSource()).toBe('observe-exit-rule');
      expect(h(g).observeExit.graduatedBy).toBe('quiet-window');
      expect(g.evaluate({}, 'telegram-forward').action).toBe('refuse');
    });
    it('does not graduate one millisecond before the window ends', () => {
      const g = make(false);
      verify(g, EXIT_MIN_VERIFIED);
      now += EXIT_QUIET_MS - 1;
      verify(g, 1);
      expect(g.mode()).toBe('observe');
    });
    it('does not graduate with one verified request too few (before the deadline)', () => {
      const g = make(false);
      verify(g, EXIT_MIN_VERIFIED - 1);
      now += EXIT_QUIET_MS * 2;
      expect(h(g).mode).toBe('observe');
    });
    it('graduates on a /health read once the rule is met (no further traffic needed)', () => {
      const g = make(false);
      verify(g, EXIT_MIN_VERIFIED);
      now += EXIT_QUIET_MS;
      expect(h(g).mode).toBe('enforce');
    });
    it('a would-refuse restarts the window and the verified count', () => {
      const g = make(false);
      verify(g, EXIT_MIN_VERIFIED);
      now += EXIT_QUIET_MS - 1000;
      g.evaluate({}, 'telegram-forward');
      now += 2000;
      verify(g, 1);
      expect(g.mode()).toBe('observe');
      expect(h(g).observeExit.verifiedSinceLastWouldRefuse).toBe(1);
    });
    it('startup proofs and server-self calls do not count as traffic', () => {
      const g = make(false);
      for (let i = 0; i < EXIT_MIN_VERIFIED * 2; i++) {
        g.evaluate(selfCall(), 'telegram-forward');
        g.evaluate(good(), 'lifeline-proof');
      }
      now += EXIT_QUIET_MS * 2;
      expect(h(g).mode).toBe('observe');
      expect(h(g).observeExit.verifiedSinceLastWouldRefuse).toBe(0);
    });

    describe('the deadline', () => {
      it('a caller with only the Bearer token cannot hold observe open past it', () => {
        const g = make(false);
        g.evaluate(good(), 'lifeline-proof'); // armed at T0
        // One secretless request every 6 hours keeps the quiet window from ever closing…
        for (let t = 6 * HOUR; t < EXIT_DEADLINE_MS; t += 6 * HOUR) {
          now = T0 + t;
          expect(g.evaluate({}, 'telegram-forward').action).toBe('accept');
        }
        expect(g.mode()).toBe('observe');
        // …and at the deadline the next one is refused.
        now = T0 + EXIT_DEADLINE_MS;
        expect(g.evaluate({}, 'telegram-forward').action).toBe('refuse');
        expect(h(g).observeExit).toMatchObject({ graduatedBy: 'deadline' });
        expect(g.modeSource()).toBe('observe-exit-rule');
      });
      it('does not fire one millisecond early', () => {
        const g = make(false);
        g.evaluate(good(), 'lifeline-proof');
        now = T0 + EXIT_DEADLINE_MS - 1;
        expect(h(g).mode).toBe('observe');
      });
      it('does not run at all before the guard has armed', () => {
        const g = make(false);
        now = T0 + EXIT_DEADLINE_MS * 3;
        expect(g.evaluate({}, 'telegram-forward').action).toBe('accept');
        expect(h(g).observeExit.deadlineAt).toBeNull();
      });
      it('is recorded at arming and survives a restart', () => {
        const first = make(false);
        first.evaluate(good(), 'lifeline-proof');
        const restarted = restart(first);
        expect(h(restarted).observeExit.deadlineAt).toBe(new Date(T0 + EXIT_DEADLINE_MS).toISOString());
        now = T0 + EXIT_DEADLINE_MS;
        expect(h(restarted).mode).toBe('enforce');
      });
    });

    it('the evidence survives a restart: counts and the window carry over', () => {
      const first = make(false);
      verify(first, EXIT_MIN_VERIFIED - 1);
      first.evaluate({}, 'telegram-forward');
      verify(first, EXIT_MIN_VERIFIED - 1);
      now += EXIT_QUIET_MS / 2;

      const restarted = restart(first);
      expect(h(restarted)).toMatchObject({ verified: (EXIT_MIN_VERIFIED - 1) * 2, wouldRefuse: 1 });
      expect(h(restarted).byRoute['telegram-forward'].wouldRefuse).toBe(1);
      expect(h(restarted).observeExit.verifiedSinceLastWouldRefuse).toBe(EXIT_MIN_VERIFIED - 1);
      expect(h(restarted).observingSince).toBe(new Date(T0).toISOString());

      verify(restarted, 1);
      now += EXIT_QUIET_MS / 2;
      verify(restarted, 1);
      expect(restarted.mode()).toBe('enforce');
      // …and graduation itself survives the next restart.
      expect(restart(restarted).mode()).toBe('enforce');
    });
    it('explicit enforce:false holds observe even after the rule is met, and says so', () => {
      explicit = false;
      const g = make(false);
      verify(g, EXIT_MIN_VERIFIED);
      now += EXIT_DEADLINE_MS * 2;
      verify(g, 1);
      expect(g.mode()).toBe('observe');
      expect(h(g).observeExit.pinnedObserveByConfig).toBe(true);
      expect(g.evaluate({}, 'telegram-forward').action).toBe('accept');
    });
  });

  describe('persistence', () => {
    it('an ABSENT state file is a quiet fresh start', () => {
      const g = make(true);
      expect(h(g)).toMatchObject({ armed: false, stateCorruptAtLoad: false });
      expect(kinds()).toEqual([]);
    });
    it('a CORRUPT state file resets to unarmed, refuses nothing, and is reported', () => {
      fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, LIFELINE_INGRESS_STATE_RELPATH), '{not json');
      const g = make(true);
      expect(h(g)).toMatchObject({ armed: false, stateCorruptAtLoad: true });
      expect(kinds()).toEqual(['state-corrupt']);
      expect(g.evaluate({}, 'telegram-forward').action).toBe('accept');
    });
    it('the state file cannot be read or edited through the file routes', () => {
      expect(isNeverServed('.instar/' + LIFELINE_INGRESS_STATE_RELPATH.split(path.sep).join('/'))).toBe(true);
      expect(isNeverServed('.instar/state/telegram-callback-seen.json')).toBe(true);
      expect(isNeverServed('.instar/state/lifeline-ingress-secret')).toBe(true);
    });
    it('a flood of unverified requests is coalesced into a bounded number of writes', () => {
      const g = make(false);
      const file = path.join(stateDir, LIFELINE_INGRESS_STATE_RELPATH);
      for (let i = 0; i < PERSIST_BURST; i++) g.evaluate({}, 'telegram-forward');
      const onDiskAfterBurst = JSON.parse(fs.readFileSync(file, 'utf-8')).wouldRefuse;
      expect(onDiskAfterBurst).toBe(PERSIST_BURST);
      for (let i = 0; i < 500; i++) g.evaluate({}, 'telegram-forward');
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).wouldRefuse).toBe(PERSIST_BURST); // coalesced
      expect(h(g).wouldRefuse).toBe(PERSIST_BURST + 500); // counted in memory
      g.flush();
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).wouldRefuse).toBe(PERSIST_BURST + 500);
      now += PERSIST_COALESCE_MS;
      g.evaluate({}, 'telegram-forward'); // a new window writes through again
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).wouldRefuse).toBe(PERSIST_BURST + 501);
    });
    it('the health block and the state file never contain the secret', () => {
      const g = make(true);
      g.evaluate(good(), 'telegram-forward');
      g.evaluate({}, 'telegram-forward');
      g.flush();
      const s = secret();
      expect(JSON.stringify(g.health())).not.toContain(s);
      expect(fs.readFileSync(path.join(stateDir, LIFELINE_INGRESS_STATE_RELPATH), 'utf-8')).not.toContain(s);
    });
    it('secretAvailable reads the FILE: it turns false when the file is deleted, and reading health does not recreate it', () => {
      const g = make(true);
      g.evaluate(good(), 'telegram-forward');
      expect(h(g)).toMatchObject({ secretAvailable: true, refusing: true });
      SafeFsExecutor.safeRmSync(lifelineIngressSecretPath(stateDir), { force: true, operation: 'tests/unit/lifeline-ingress-guard.test.ts' });
      // The file is gone, but this process still holds the value and still refuses.
      expect(h(g)).toMatchObject({ secretAvailable: false, refusing: true });
      expect(fs.existsSync(lifelineIngressSecretPath(stateDir))).toBe(false);
      expect(g.evaluate({}, 'telegram-forward').action).toBe('refuse');
    });
  });
});
