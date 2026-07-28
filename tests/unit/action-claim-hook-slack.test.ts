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

  it('clamps the POST payload to 16KB', () => {
    expect(body).toContain('slice(0, 16384)');
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
