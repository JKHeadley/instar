/**
 * Unit (Tier 1) — the generalized Action-Claim Stop hook body
 * (slack-followthrough-generalization §4.4 change 2). Semantic regressions:
 * keys ONLY on INSTAR_CONVERSATION_ID (no INSTAR_TELEGRAM_TOPIC fallback), sends
 * the bind-token header, drops the ≥20-char floor, clamps the payload, always
 * exit(0). Complements generated-hooks-parse.test.ts (which proves it PARSES).
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

function hookBody(): string {
  const m = new PostUpdateMigrator({
    projectDir: os.tmpdir(),
    stateDir: path.join(os.tmpdir(), '.instar'),
    port: 4042,
    hasTelegram: true,
    projectName: 'test',
  });
  return (m as unknown as Record<string, () => string>).getActionClaimFollowthroughHook();
}

describe('getActionClaimFollowthroughHook — Slack generalization', () => {
  const body = hookBody();

  it('keys the conversation from INSTAR_CONVERSATION_ID', () => {
    expect(body).toContain('process.env.INSTAR_CONVERSATION_ID');
  });

  it('does NOT READ INSTAR_TELEGRAM_TOPIC (R2-EXT-C1 — the fallback re-opens the lifeline mis-delivery)', () => {
    // The comment may name the env for documentation; the regression is that it is never READ.
    expect(body).not.toContain('process.env.INSTAR_TELEGRAM_TOPIC');
  });

  it('sends the X-Instar-Bind-Token header from INSTAR_BIND_TOKEN', () => {
    expect(body).toContain('INSTAR_BIND_TOKEN');
    expect(body).toContain('X-Instar-Bind-Token');
  });

  it('drops the ≥20-char length floor (the classifiers are the filter)', () => {
    expect(body).not.toMatch(/length\s*<\s*20/);
  });

  it('clamps the POST payload keeping the 16KB dedup prefix AND the tail, and discloses the cut', () => {
    // Run the emitted clamp itself (not a text match): the promise that closes
    // a long reply must survive, the cut must say it is a cut, and the first
    // 16384 characters must be byte-identical to the raw reply, because the
    // route dedups against the completion-claim path by fingerprinting exactly
    // that prefix (CompletionClaimVerifier messageFingerprint).
    const head = /const ACTION_CLAIM_HEAD_CHARS = (\d+);/.exec(body);
    const tail = /const ACTION_CLAIM_TAIL_CHARS = (\d+);/.exec(body);
    const decl = /const message = (rawMessage\.length[^\n]*);/.exec(body);
    expect(head && tail && decl).toBeTruthy();
    const clamp = new Function(
      'rawMessage',
      `const ACTION_CLAIM_HEAD_CHARS = ${head![1]}; const ACTION_CLAIM_TAIL_CHARS = ${tail![1]}; return ${decl![1]};`,
    ) as (m: string) => string;

    const short = 'I will fix it.';
    expect(clamp(short)).toBe(short);
    const justOver16k = 'b'.repeat(16_500);
    expect(clamp(justOver16k)).toBe(justOver16k); // used to be cut at 16384; now whole

    const long = Array.from({ length: 4000 }, (_, i) => `line ${i} of the work log`).join('\n') + "\nI'll follow up in an hour with the result.";
    const out = clamp(long);
    expect(out.slice(0, 16_384)).toBe(long.slice(0, 16_384)); // dedup fingerprint prefix unchanged
    expect(out.endsWith("I'll follow up in an hour with the result.")).toBe(true);
    expect(out).toMatch(/\n\[BOUNDED INPUT: \d+ characters removed from the MIDDLE/);
    expect(out.length).toBeLessThan(16_384 + 8_000 + 400);
  });

  it('still ALWAYS exit(0) (signal-only, never blocks a turn)', () => {
    expect(body).toContain('process.exit(0)');
  });

  it('still gates on the master actionClaim.enabled', () => {
    expect(body).toContain('actionClaim');
    expect(body).toContain('enabled');
  });

  it('resolves config from TOP-LEVEL actionClaim, array-messaging-safe (actionclaim-config-shape-fix)', () => {
    // On a real install `messaging` is an ARRAY, so `cfg.messaging.actionClaim` is
    // unreachable. The hook must read the top-level `cfg.actionClaim` and guard the
    // legacy `messaging.actionClaim` fallback with Array.isArray so it never indexes
    // an array.
    expect(body).toContain('cfg.actionClaim');
    expect(body).toContain('Array.isArray(cfg.messaging)');
  });
});
