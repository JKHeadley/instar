// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Unit — FeatureRegistry additions for spec feature-transition-applies-action:
 * the honest-state table (§2.3), recorded apply results (§2.2), the operator
 * switch (§2.4), the boot snapshot, and the tunnel definition fix (§2.7).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeatureRegistry, deriveEffectiveState } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { FeatureApplyResult } from '../../src/core/FeatureActionApplier.js';

const refused: FeatureApplyResult = { direction: 'enable', outcome: 'refused', httpStatus: 409, detail: 'write refused on standby', at: '2026-10-26T00:00:00.000Z' };

describe('deriveEffectiveState — both sides of every boundary', () => {
  it.each([
    [true, true, true, 'on'],
    [true, true, false, 'on-after-restart'],
    [true, false, false, 'recorded-only'],
    [true, false, true, 'recorded-only'],
    [false, false, false, 'off'],
    [false, false, true, 'off-after-restart'],
    [false, true, true, 'not-recorded'],
    [false, true, false, 'not-recorded'],
  ] as const)('recorded=%s configured=%s atBoot=%s → %s', (rec, conf, boot, status) => {
    expect(deriveEffectiveState(rec, conf, boot, null).status).toBe(status);
  });

  it('never claims a just-saved change is running, never claims "on" is verified, and keeps the last failed attempt in every state', () => {
    expect(deriveEffectiveState(true, true, false, null).summary).not.toMatch(/running\b(?! is not)/i);
    expect(deriveEffectiveState(true, true, true, null).summary).toContain('not separately verified');
    expect(deriveEffectiveState(true, false, false, refused).summary).toContain('write refused on standby');
    // After a restart reset the switch, the failed attempt is still told (review r1 §6).
    const off = deriveEffectiveState(false, false, false, refused);
    expect(off.status).toBe('off');
    expect(off.summary).toContain('write refused on standby');
    expect(off.lastAttempt).toEqual(refused);
    expect(deriveEffectiveState(true, false, false, { ...refused, outcome: 'applied', detail: null }).summary).toBe('Switched on, but the setting is still off.');
    // No boot snapshot → say so, never invent boot evidence.
    const unknown = deriveEffectiveState(true, true, null, null);
    expect(unknown.status).toBe('on');
    expect(unknown.summary).toContain('not known');
    expect(deriveEffectiveState(false, false, false, null, 'A note.').summary).toMatch(/^Off \(the setting was off when the agent started.*\)\. A note\.$/);
    expect(deriveEffectiveState(false, false, false, null).summary).not.toMatch(/\brunning\b(?! is not)/i);
    expect(deriveEffectiveState(false, false, false, null, 'A note.').detail).toBe('A note.');
    expect(deriveEffectiveState(false, false, false, null).detail).toBeNull();
    expect(off.detail).toContain('write refused on standby');
  });
});

describe('FeatureRegistry apply + operator switch', () => {
  let dir: string;
  let reg: FeatureRegistry;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-apply-unit-'));
    reg = new FeatureRegistry(dir);
    await reg.open();
    for (const d of BUILTIN_FEATURES) reg.register(d);
  });
  afterEach(() => {
    reg.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/feature-registry-apply-and-operator.test.ts' });
  });

  it('operatorSet enables an undiscovered network-tier feature and writes an explicit-written consent record', () => {
    expect(reg.getState('publishing-telegraph')!.discoveryState).toBe('undiscovered');
    // The agent path still refuses the same jump:
    expect(reg.transition('publishing-telegraph', 'default', 'enabled').success).toBe(false);
    const r = reg.operatorSet('publishing-telegraph', 'default', 'enabled');
    expect(r).toMatchObject({ success: true, previousState: 'undiscovered', newState: 'enabled' });
    const st = reg.getState('publishing-telegraph')!;
    expect(st.enabled).toBe(true);
    expect(st.consentRecordId).toBeTruthy();
    const recs = reg.getConsentRecordsForFeature('publishing-telegraph', 'default');
    expect(recs).toHaveLength(1);
    expect(recs[0].mechanism).toBe('explicit-written');
    expect(reg.getDiscoveryEvents({ featureId: 'publishing-telegraph' }).some((e) => e.trigger === 'operator-switch')).toBe(true);
  });

  it('operatorSet writes no consent record for a local-tier feature, and can disable from any state', () => {
    expect(reg.operatorSet('evolution-system', 'default', 'enabled').success).toBe(true);
    expect(reg.getConsentRecordsForFeature('evolution-system', 'default')).toHaveLength(0);
    expect(reg.operatorSet('threadline-relay', 'default', 'disabled')).toMatchObject({ success: true, previousState: 'undiscovered', newState: 'disabled' });
    expect(reg.operatorSet('threadline-relay', 'default', 'aware' as never).success).toBe(false);
    expect(reg.operatorSet('nope', 'default', 'enabled').error?.code).toBe('FEATURE_NOT_FOUND');
  });

  it('operatorSet satisfies the self-governing activation challenge (the PIN unlock is the human proof)', () => {
    expect(reg.operatorSet('autonomous-evolution', 'default', 'enabled').success).toBe(true);
    expect(reg.getState('autonomous-evolution')!.enabled).toBe(true);
  });

  it('recordApply persists across close/reopen and is logged beside the transition', async () => {
    reg.operatorSet('publishing-telegraph', 'default', 'enabled');
    reg.recordApply('publishing-telegraph', 'default', refused);
    reg.close();
    const again = new FeatureRegistry(dir);
    await again.open();
    for (const d of BUILTIN_FEATURES) again.register(d);
    expect(again.getState('publishing-telegraph')!.lastApply).toEqual(refused);
    expect(again.getDiscoveryEvents({ featureId: 'publishing-telegraph' }).some((e) => e.context?.startsWith('apply:refused'))).toBe(true);
    again.close();
    reg = new FeatureRegistry(dir); await reg.open(); // for afterEach
  });

  it('readMergedConfig lets disk win one level deep without wiping sibling runtime sub-keys', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dashboard: { fileViewer: { enabled: false } }, publishing: { enabled: true } }));
    const merged = reg.readMergedConfig({ dashboard: { port: 4042, fileViewer: { enabled: true } }, publishing: { enabled: false }, tunnel: { enabled: true } }) as Record<string, any>;
    expect(merged.dashboard.port).toBe(4042);               // runtime sibling kept
    expect(merged.dashboard.fileViewer).toEqual({ enabled: false }); // disk wins on the key it names
    expect(merged.publishing).toEqual({ enabled: true });
    expect(merged.tunnel).toEqual({ enabled: true });
  });

  it('effective state uses the boot snapshot and the config on disk', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ publishing: { enabled: false } }));
    reg.bootstrap({});
    reg.operatorSet('publishing-telegraph', 'default', 'enabled');
    const cfg = () => reg.readMergedConfig({});
    expect(reg.getEffectiveState('publishing-telegraph', 'default', cfg())!.status).toBe('recorded-only');
    // The setting change lands on disk → saved, starts after restart (booted off).
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ publishing: { enabled: true } }));
    expect(reg.getEffectiveState('publishing-telegraph', 'default', cfg())!.status).toBe('on-after-restart');
  });

  it('a restart after an applied "on" keeps the switch on instead of resetting it', async () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ publishing: { enabled: true } }));
    reg.operatorSet('publishing-telegraph', 'default', 'enabled');
    reg.close();
    const again = new FeatureRegistry(dir);
    await again.open();
    for (const d of BUILTIN_FEATURES) again.register(d);
    again.bootstrap({});
    expect(again.getState('publishing-telegraph')!.discoveryState).toBe('enabled');
    expect(again.getEffectiveState('publishing-telegraph', 'default', again.readMergedConfig({}))!.status).toBe('on');
    again.close();
    reg = new FeatureRegistry(dir); await reg.open();
  });
});

describe('definition fixes (review r1: actions must change the key the runtime reads)', () => {
  const def = (id: string) => BUILTIN_FEATURES.find((d) => d.id === id)!;
  it('the tunnel enable body no longer carries a type (it would overwrite a named tunnel)', () => {
    expect(def('cloudflare-tunnel').enableAction.body).toEqual({ tunnel: { enabled: true } });
  });
  it('threadline switches threadline.relayEnabled (the key the relay bootstrap reads)', () => {
    expect(def('threadline-relay').configPath).toBe('threadline.relayEnabled');
    expect(def('threadline-relay').enableAction.body).toEqual({ threadline: { relayEnabled: true } });
  });
  it('autonomous evolution switches evolution.approvalMode (autoImplement had no consumer)', () => {
    const d = def('autonomous-evolution');
    expect(d.enableAction.body).toEqual({ evolution: { approvalMode: 'autonomous' } });
    expect(d.disableAction.body).toEqual({ evolution: { approvalMode: 'ai-assisted' } });
    expect(d.configEnabledValue).toBe('autonomous');
  });
  it('default-on features read an absent key as on, matching their consumers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-defaults-'));
    const reg = new FeatureRegistry(dir); await reg.open();
    for (const d of BUILTIN_FEATURES) reg.register(d);
    expect(reg.isConfigured('publishing-telegraph', {})).toBe(true);
    expect(reg.isConfigured('publishing-telegraph', { publishing: { enabled: false } })).toBe(false);
    expect(reg.isConfigured('threadline-relay', {})).toBe(false);
    expect(reg.isConfigured('threadline-relay', { threadline: { relayEnabled: true } })).toBe(true);
    expect(reg.isConfigured('threadline-relay', { threadline: { enabled: true } })).toBe(false);
    expect(reg.isConfigured('autonomous-evolution', { evolution: { approvalMode: 'autonomous' } })).toBe(true);
    expect(reg.isConfigured('autonomous-evolution', { evolution: { approvalMode: 'ai-assisted' } })).toBe(false);
    expect(reg.isConfigured('response-review', {})).toBe(false);
    // A section with other keys but no boolean `enabled` follows the consumer's default (review r2).
    expect(reg.isConfigured('feedback-system', { feedback: { webhookUrl: 'x' } })).toBe(false);
    expect(reg.isConfigured('publishing-telegraph', { publishing: { shortName: 'x' } })).toBe(true);
    expect(reg.isConfigured('feedback-system', { feedback: { enabled: 'yes' } })).toBe(false);
    // A section set to null follows the consumer's default too (`pubConfig?.enabled !== false` runs it).
    expect(reg.isConfigured('publishing-telegraph', { publishing: null })).toBe(true);
    expect(reg.isConfigured('response-review', { responseReview: null })).toBe(false);
    reg.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/feature-registry-apply-and-operator.test.ts' });
  });
  it('a consumer-specific resolver decides the key for bootstrap AND the shown state (autonomy-profile fallback)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-resolver-'));
    const reg = new FeatureRegistry(dir); await reg.open();
    for (const d of BUILTIN_FEATURES) reg.register(d);
    let profileDefault: 'autonomous' | 'ai-assisted' = 'autonomous';
    reg.setConfiguredResolver('autonomous-evolution', (cfg) => {
      const explicit = (cfg.evolution as { approvalMode?: unknown } | undefined)?.approvalMode;
      return (explicit === 'autonomous' || explicit === 'ai-assisted' ? explicit : profileDefault) === 'autonomous';
    });
    // No explicit key: the profile decides (review r2 — a footnote cannot fix the boolean).
    expect(reg.isConfigured('autonomous-evolution', {})).toBe(true);
    profileDefault = 'ai-assisted';
    expect(reg.isConfigured('autonomous-evolution', {})).toBe(false);
    // An explicit key wins over the profile, and evolution.enabled plays no part (the consumers ignore it).
    expect(reg.isConfigured('autonomous-evolution', { evolution: { enabled: false, approvalMode: 'autonomous' } })).toBe(true);
    reg.bootstrap({ evolution: { approvalMode: 'autonomous' } });
    expect(reg.getState('autonomous-evolution')!.discoveryState).toBe('enabled');
    expect(reg.getEffectiveState('autonomous-evolution', 'default', { evolution: { enabled: false, approvalMode: 'autonomous' } })!.status).toBe('on');
    reg.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/feature-registry-apply-and-operator.test.ts' });
  });

  it('a read-only switch (evolution-system) shows the key as it is, never a mismatch, with the honesty note', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-readonly-'));
    const reg = new FeatureRegistry(dir); await reg.open();
    for (const d of BUILTIN_FEATURES) reg.register(d);
    const d = BUILTIN_FEATURES.find((x) => x.id === 'evolution-system')!;
    expect(d.switchable).toBe(false);
    const e = reg.getEffectiveState('evolution-system', 'default', {})!;
    expect(e.status).toBe('on');
    expect(e.recorded).toBe(true); // the switch position follows the key for a read-only switch
    expect(e.summary).toContain('read-only');
    expect(reg.getEffectiveState('evolution-system', 'default', { evolution: { enabled: false } })!.status).toBe('off');
    reg.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/feature-registry-apply-and-operator.test.ts' });
  });
});
