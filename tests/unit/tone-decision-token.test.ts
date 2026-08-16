import { describe, it, expect, beforeEach } from 'vitest';
import {
  mintToneDecisionToken,
  verifyToneDecisionToken,
  getToneContestationCounters,
  bumpToneTokenMinted,
  bumpToneGradedViaToken,
  bumpToneOverrideWithoutToken,
  bumpToneTokenRejected,
  _resetToneContestationCountersForTest,
  TONE_OVERRIDE_WRONG_RULE_ID,
  TONE_TOKEN_TTL_MS,
  KEY_ID,
} from '../../src/core/toneDecisionToken.js';
import { RULE_REGISTRY, DP_MESSAGING_TONE_GATE } from '../../src/data/provenanceCoverage.js';

/**
 * Unit tier for the tone-gate contestation token
 * (docs/specs/tone-gate-contestation-evidence.md).
 *
 * The token is the ONLY thing standing between a caller and annotating an
 * arbitrary decision `wrong`, so most of this file is adversarial: forged,
 * expired, replayed-under-another-rule, and truncated tokens must all fail
 * CLOSED — yielding no correlation id, therefore no grade, therefore an honest
 * `unknown` rather than a fabricated verdict.
 */

const RULE = 'B21_USER_TASK_SUBSTITUTION';
const CORR = 'd-abc123-4567';

beforeEach(() => { _resetToneContestationCountersForTest(); });

describe('mint / verify round trip', () => {
  it('a freshly minted token recovers exactly the correlation id it was minted for', () => {
    const t = mintToneDecisionToken(CORR, RULE)!;
    expect(t).toBeTruthy();
    expect(verifyToneDecisionToken(t, RULE)).toEqual({ correlationId: CORR, rejected: null });
  });

  it('returns null (field simply omitted) when the decision never reached the router', () => {
    expect(mintToneDecisionToken(undefined, RULE)).toBeNull();
    expect(mintToneDecisionToken('', RULE)).toBeNull();
    expect(mintToneDecisionToken(CORR, '')).toBeNull();
  });

  it('refuses to mint from ids containing the payload delimiter (no smuggling)', () => {
    expect(mintToneDecisionToken('d-abc.evil', RULE)).toBeNull();
    expect(mintToneDecisionToken(CORR, 'B21.evil')).toBeNull();
  });
});

describe('verification fails CLOSED — a rejected token never grades anything', () => {
  it('rejects a forged signature — and classifies it as forgery, not topology', () => {
    const t = mintToneDecisionToken(CORR, RULE)!;
    const [kid, enc] = t.split('.');
    const forged = `${kid}.${enc}.${'0'.repeat(64)}`;
    expect(verifyToneDecisionToken(forged, RULE)).toEqual({ correlationId: null, rejected: 'bad-signature' });
  });

  it('classifies a token from ANOTHER key as `foreign-key`, never `bad-signature`', () => {
    // r9 f3: ordinary multi-machine retry routing and restarts produce tokens this
    // process cannot verify. Counting those as forgery would bury a real attack
    // signal in routine topology noise.
    const t = mintToneDecisionToken(CORR, RULE)!;
    const [, enc, mac] = t.split('.');
    expect(verifyToneDecisionToken(`ffffffffffff.${enc}.${mac}`, RULE))
      .toEqual({ correlationId: null, rejected: 'foreign-key' });
  });

  it('the key id identifies the key without revealing it', () => {
    expect(KEY_ID).toMatch(/^[0-9a-f]{12}$/);
    const t = mintToneDecisionToken(CORR, RULE)!;
    expect(t.startsWith(`${KEY_ID}.`)).toBe(true);
  });

  it('uses the FULL HMAC, not a truncated one', () => {
    const mac = mintToneDecisionToken(CORR, RULE)!.split('.')[2];
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a token whose PAYLOAD was edited to point at another decision', () => {
    // The attack the signature exists to stop: swap the correlation id, keep the MAC.
    const t = mintToneDecisionToken(CORR, RULE)!;
    const mac = t.split('.')[2];
    const evil = Buffer.from(`d-someone-elses.${RULE}.${Date.now() + TONE_TOKEN_TTL_MS}`, 'utf8').toString('base64url');
    const v = verifyToneDecisionToken(`${KEY_ID}.${evil}.${mac}`, RULE);
    expect(v.correlationId).toBeNull();
    expect(v.rejected).toBe('bad-signature');
  });

  it('rejects an expired token', () => {
    const past = Date.now() - TONE_TOKEN_TTL_MS - 60_000;
    const t = mintToneDecisionToken(CORR, RULE, past)!;
    expect(verifyToneDecisionToken(t, RULE)).toEqual({ correlationId: null, rejected: 'expired' });
  });

  it('accepts right up to the expiry boundary and not past it', () => {
    const t0 = 1_000_000_000_000;
    const t = mintToneDecisionToken(CORR, RULE, t0)!;
    expect(verifyToneDecisionToken(t, RULE, t0 + TONE_TOKEN_TTL_MS).correlationId).toBe(CORR);
    expect(verifyToneDecisionToken(t, RULE, t0 + TONE_TOKEN_TTL_MS + 1).rejected).toBe('expired');
  });

  it('rejects a token REPLAYED under a different rule', () => {
    // Without the rule binding, a token minted for a trivial advisory hold could
    // be echoed against a different decision citing a different rule.
    const t = mintToneDecisionToken(CORR, RULE)!;
    expect(verifyToneDecisionToken(t, 'B17_FALSE_BLOCKER')).toEqual({ correlationId: null, rejected: 'rule-mismatch' });
  });

  it('rejects malformed input of every shape without throwing', () => {
    for (const bad of [undefined, null, 42, {}, '', 'nodot', '.', 'a.b', 'a.b.c.d', 'x'.repeat(600)]) {
      const v = verifyToneDecisionToken(bad as unknown, RULE);
      expect(v.correlationId).toBeNull();
      expect(v.rejected).not.toBeNull();
    }
  });

  it('rejects a truncated token (partial MAC never passes)', () => {
    const t = mintToneDecisionToken(CORR, RULE)!;
    expect(verifyToneDecisionToken(t.slice(0, t.length - 4), RULE).correlationId).toBeNull();
  });
});

describe('counters — the miss is countable, not merely disclaimed', () => {
  it('starts at zero and tracks each outcome class independently', () => {
    expect(getToneContestationCounters()).toEqual({
      minted: 0, gradedViaToken: 0, overridesWithoutToken: 0,
      rejected: { malformed: 0, 'bad-signature': 0, expired: 0, 'rule-mismatch': 0, 'foreign-key': 0 },
    });
    bumpToneTokenMinted();
    bumpToneGradedViaToken();
    bumpToneOverrideWithoutToken();
    bumpToneTokenRejected('expired');
    const c = getToneContestationCounters();
    expect(c).toMatchObject({ minted: 1, gradedViaToken: 1, overridesWithoutToken: 1 });
    expect(c.rejected.expired).toBe(1);
    expect(c.rejected['bad-signature']).toBe(0);
  });

  it('the returned snapshot is a COPY — a caller cannot mutate the live counters', () => {
    const snap = getToneContestationCounters() as { minted: number; rejected: Record<string, number> };
    snap.minted = 999;
    snap.rejected.expired = 999;
    expect(getToneContestationCounters().minted).toBe(0);
    expect(getToneContestationCounters().rejected.expired).toBe(0);
  });
});

describe('rule registry agreement', () => {
  it('the rule registers at SELF-REPORT strength, never as proof', () => {
    const r = RULE_REGISTRY[TONE_OVERRIDE_WRONG_RULE_ID];
    expect(r).toBeDefined();
    expect(r.decisionPoint).toBe(DP_MESSAGING_TONE_GATE);
    // An override proves the sender CHOSE TO BYPASS the hold — not that the gate
    // was objectively wrong. Precedence must let any independent grader outrank it.
    expect(r.rung).toBe('self-report');
    expect(r.evidenceStrength).toBe('self-report');
    expect(r.owningComponent).toBe('MessagingToneGate');
  });

  it('NO right-producing rule is registered for this decision point', () => {
    // Silence is never a grade, and no authorship-bearing signal exists yet
    // (ACT-933), so the point can emit `wrong` and `unknown` only.
    const ids = Object.values(RULE_REGISTRY)
      .filter((r) => r.decisionPoint === DP_MESSAGING_TONE_GATE)
      .map((r) => r.ruleId)
      .sort();
    expect(ids).toEqual([TONE_OVERRIDE_WRONG_RULE_ID, 'tone-window-unknown-v1'].sort());
  });
});
