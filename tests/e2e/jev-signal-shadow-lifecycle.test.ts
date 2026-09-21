/**
 * Jev signal shadow — E2E lifecycle tier.
 * Spec: docs/specs/jev-signal-layer-shadow.md (Tests §3).
 *
 * Mirrors the production path: the update migrator writes the DARK default
 * block into a real config.json, the shadow is constructed with the same
 * production factory server.ts calls (live config read, vault-key lookup,
 * log location), and it is attached to a real
 * MessagingToneGate. The shipped state must make zero network calls and
 * write zero rows; flipping the config (no restart) must bring it alive.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import { buildJevSignalShadow, SHADOW_QUESTIONS } from '../../src/core/JevSignalShadow.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const PATHY = 'The failure is in /Users/someone/project/src/core/SessionManager.ts around line 400.';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-shadow-e2e-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projectName: 'e2e', port: 4042 }, null, 2));
  const logPath = path.join(stateDir, '..', 'logs', 'jev-signal-shadow.jsonl');
  const migrate = () => {
    const m = new PostUpdateMigrator({ port: 4042, stateDir, projectDir: root, hasTelegram: false, projectName: 'e2e' } as never);
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (m as unknown as { migrateConfig(r: typeof result): void }).migrateConfig(result);
    return result;
  };
  // Same shape as server.ts: re-read the live config on every candidate.
  const readBlock = () => (JSON.parse(fs.readFileSync(configPath, 'utf8')).intelligence ?? {}).jevSignalShadow;
  const rows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const readIntel = () => JSON.parse(fs.readFileSync(configPath, 'utf8')).intelligence;
  const build = (fetchImpl: unknown) => buildJevSignalShadow({
    readLiveIntelligence: readIntel,
    readSecret: (name) => (name === 'typesafe_api_key' ? 'k' : null),
    stateDir,
    fetchImpl: fetchImpl as never,
  });
  return { configPath, logPath, migrate, readBlock, rows, build };
}

const provider = { evaluate: vi.fn(async () => JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' })) } as unknown as IntelligenceProvider;

describe('Jev signal shadow — production lifecycle', () => {
  it('the update path installs the DARK default, idempotently', () => {
    const e = setup();
    const first = e.migrate();
    expect(first.errors).toEqual([]);
    expect(e.readBlock()).toEqual({ enabled: false, sampleRate: 1, model: 'jev-1.13.0', timeoutMs: 1500, soakEndsAt: null });
    const second = e.migrate();
    expect(second.skipped.some((s) => s.includes('jevSignalShadow already present'))).toBe(true);
    expect(e.readBlock().enabled).toBe(false);
  });

  it('shipped state: a real gate with the shadow wired makes no call and writes no row', async () => {
    const e = setup();
    e.migrate();
    const fetchImpl = vi.fn();
    const shadow = e.build(fetchImpl);
    const gate = new MessagingToneGate(provider, {});
    gate.setSignalShadow(shadow);
    const verdict = await gate.review(PATHY, { channel: 'telegram', messageKind: 'reply' } as never);
    await shadow.lastDispatch;
    expect(verdict.pass).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(e.rows()).toHaveLength(0);
  });

  it('flipping the config on (no restart) brings it alive and writes a compared row', async () => {
    const e = setup();
    e.migrate();
    const answers = Object.fromEntries(SHADOW_QUESTIONS.map((q) => [q.rule, { noul: q.rule === 'raw_path' ? 0.95 : 0.03 }]));
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 90 }, answers }) }));
    const shadow = e.build(fetchImpl);
    const gate = new MessagingToneGate(provider, {});
    gate.setSignalShadow(shadow);

    const cfg = JSON.parse(fs.readFileSync(e.configPath, 'utf8'));
    cfg.intelligence.jevSignalShadow.enabled = true;
    cfg.intelligence.jevSignalShadow.soakEndsAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
    fs.writeFileSync(e.configPath, JSON.stringify(cfg));

    await gate.review(PATHY, { channel: 'telegram', messageKind: 'reply' } as never);
    await shadow.lastDispatch;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [row] = e.rows();
    expect(row.kind).toBe('compared');
    expect(row.disagree).toEqual([]);
    expect(JSON.stringify(row)).not.toContain('SessionManager');
  });
});
