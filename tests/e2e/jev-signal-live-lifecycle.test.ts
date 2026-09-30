/**
 * Jev live artefact signals — E2E lifecycle tier.
 * Spec: docs/specs/jev-signal-live.md (Tests).
 *
 * Mirrors the production path end to end: the update migrator writes the
 * default block into a real config.json (and the awareness card into a real
 * CLAUDE.md), the shadow is built with the same factory server.ts calls reading
 * that file live, and it is attached to a real MessagingToneGate whose config
 * getter uses the production resolver. On a development agent the feature is
 * ALIVE (Jev shapes the prompt); on the fleet it is dark.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { MessagingToneGate, resolveToneGateOperatorConfig, TONE_GATE_PROMPT_ID, TONE_GATE_PROMPT_ID_JEV } from '../../src/core/MessagingToneGate.js';
import { buildJevSignalShadow, SHADOW_QUESTIONS } from '../../src/core/JevSignalShadow.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { installDecisionQualityRecorder } from '../../src/core/DecisionQualityRecorderImpl.js';

// Live signals need decision-quality recording to be live (the route otherwise
// turns a migration advisory back into a hard block). Install a stub recorder
// through the production seam; individual tests flip it off.
let recordingLive = true;
beforeEach(() => { recordingLive = true; installDecisionQualityRecorder({ isRecordingLive: () => recordingLive } as never); });
afterEach(() => installDecisionQualityRecorder(null));

const TEXT = 'All set. It runs on the agreed schedule and reports back in the morning.';

function setup(initial: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-live-e2e-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projectName: 'e2e', port: 4042, ...initial }, null, 2));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md — e2e\n');
  const migrator = () => new PostUpdateMigrator({ port: 4042, stateDir, projectDir: root, hasTelegram: false, projectName: 'e2e' } as never) as unknown as {
    migrateConfig(r: unknown): void; migrateClaudeMd(r: unknown): void;
  };
  const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const claudeMd = () => fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  return { root, stateDir, configPath, migrator, result, readConfig, claudeMd };
}

describe('jev-signal-live — migration parity', () => {
  it('the update path adds the dev-gated block (no `enabled`), idempotently, never overwriting', () => {
    const e = setup({});
    const r1 = e.result();
    e.migrator().migrateConfig(r1);
    expect(r1.errors).toEqual([]);
    expect(e.readConfig().intelligence.jevSignalLive).toEqual({ timeoutMs: 1000 });
    e.migrator().migrateConfig(e.result());
    expect(e.readConfig().intelligence.jevSignalLive).toEqual({ timeoutMs: 1000 });

    const op = setup({ intelligence: { jevSignalLive: { enabled: false, timeoutMs: 700 } } });
    op.migrator().migrateConfig(op.result());
    expect(op.readConfig().intelligence.jevSignalLive).toEqual({ enabled: false, timeoutMs: 700 });
  });

  it('existing agents get the awareness card once; new agents get it from the template', () => {
    const e = setup({});
    const r1 = e.result();
    e.migrator().migrateClaudeMd(r1);
    expect(r1.upgraded).toContain('CLAUDE.md: added Jev live artefact-signal awareness card');
    e.migrator().migrateClaudeMd(e.result());
    expect(e.claudeMd().split('### Jev Artefact Signals').length - 1).toBe(1);
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain('### Jev Artefact Signals');
  });

  it('is registered as a dev-gated feature', () => {
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'intelligence.jevSignalLive.enabled')).toHaveLength(1);
  });
});

describe('jev-signal-live — the feature is alive on a development agent, dark on the fleet', () => {
  function run(developmentAgent: boolean) {
    const e = setup({ developmentAgent });
    e.migrator().migrateConfig(e.result());
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        model: 'jev-1.13.0', usage: { input_tokens: 5 },
        answers: Object.fromEntries(SHADOW_QUESTIONS.map((q) => [q.rule, { noul: q.rule === 'cron_or_slug' ? 0.91 : 0.03 }])),
      }),
    }) as unknown as Response);
    const config = e.readConfig();
    // Same wiring as server.ts: live intelligence read, boot blocks, developmentAgent.
    const shadow = buildJevSignalShadow({
      readLiveIntelligence: () => e.readConfig().intelligence,
      bootBlock: config.intelligence?.jevSignalShadow,
      bootLiveBlock: config.intelligence?.jevSignalLive,
      developmentAgent: config.developmentAgent === true,
      readSecret: (n) => (n === 'typesafe_api_key' ? 'k' : null),
      stateDir: e.stateDir,
      fetchImpl: fetchImpl as never,
    });
    const evaluate = vi.fn(async (_p: string, _o: unknown) => JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' }));
    const gate = new MessagingToneGate({ evaluate } as unknown as IntelligenceProvider, () => resolveToneGateOperatorConfig(e.readConfig()));
    gate.setSignalShadow(shadow);
    return { e, fetchImpl, evaluate, gate, shadow };
  }

  it('development agent: Jev is called, shapes the prompt, and the row says which source decided each signal', async () => {
    const x = run(true);
    const r = await x.gate.review(TEXT, { channel: 'telegram', messageKind: 'reply', liveArtefactSignals: true } as never);
    expect(r.pass).toBe(true);
    expect(x.fetchImpl).toHaveBeenCalledTimes(1);
    const opts = x.evaluate.mock.calls[0][1] as { provenance: { promptId: string } };
    expect(opts.provenance.promptId).toBe(TONE_GATE_PROMPT_ID_JEV);
    const logPath = path.join(x.e.stateDir, '..', 'logs', 'jev-signal-shadow.jsonl');
    const row = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\n')[0]);
    expect(row).toMatchObject({ kind: 'compared', live: true, liveSources: { cron_or_slug: 'jev' } });
  });

  it('fleet agent: no vendor call, prompt unchanged', async () => {
    const x = run(false);
    await x.gate.review(TEXT, { channel: 'telegram', messageKind: 'reply', liveArtefactSignals: true } as never);
    expect(x.fetchImpl).not.toHaveBeenCalled();
    const opts = x.evaluate.mock.calls[0][1] as { provenance: { promptId: string } };
    expect(opts.provenance.promptId).toBe(TONE_GATE_PROMPT_ID);
  });
});
