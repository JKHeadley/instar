/**
 * correction-meaning-grouping — E2E lifecycle tier. Spec:
 * docs/specs/correction-meaning-grouping.md.
 *
 * Mirrors the production path: the update migrator runs over a real agent
 * home; the grouper is built with the same factory server.ts calls (reading
 * config.json live) and installed the same way; the routes are the real
 * createRoutes on a real port with a real CorrectionLedger. On a development
 * agent the feature is alive (analyze reports mode 'meaning' and forms the
 * group; /corrections/groups is 200); on the fleet it is dark (no vendor
 * call, mode 'words'); an explicit false in config.json stops it live.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { createRoutes } from '../../src/server/routes.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { buildJevCorrectionGrouper, installJevCorrectionGrouper, GROUPING_MODEL } from '../../src/core/JevCorrectionGrouping.js';
import { generateClaudeMd, CORRECTION_GROUPING_CARD_HEADING } from '../../src/scaffold/templates.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

const ledgers: CorrectionLedger[] = [];
afterEach(() => {
  installJevCorrectionGrouper(null);
  for (const l of ledgers.splice(0)) l.close();
});

function setup(initial: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmg-e2e-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projectName: 'e2e', port: 4042, monitoring: { correctionLearning: { enabled: true } }, ...initial }, null, 2));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md — e2e\n');
  const migrator = new PostUpdateMigrator({ port: 4042, stateDir, projectDir: root, hasTelegram: true, projectName: 'e2e' } as never) as unknown as {
    migrateConfig(r: unknown): void; migrateClaudeMd(r: unknown): void;
  };
  const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { root, stateDir, configPath, migrator, result, readConfig };
}

describe('correction-meaning-grouping — migration parity and awareness', () => {
  it('existing agents get the awareness card once; new agents get it from the template', () => {
    const e = setup({});
    const r = e.result();
    e.migrator.migrateClaudeMd(r);
    expect(r.upgraded).toContain('CLAUDE.md: added correction meaning-grouping awareness card');
    e.migrator.migrateClaudeMd(e.result());
    const md = fs.readFileSync(path.join(e.root, 'CLAUDE.md'), 'utf8');
    expect(md.split(CORRECTION_GROUPING_CARD_HEADING).length - 1).toBe(1);
    expect(md).toContain('http://localhost:4042/corrections/groups');
    const fresh = generateClaudeMd('p', 'a', 4040, false);
    expect(fresh.split(CORRECTION_GROUPING_CARD_HEADING).length - 1).toBe(1);
    expect(fresh).toContain('http://localhost:4040/corrections/groups');
  });

  it('the update path writes no `enabled` (the dev gate decides) and keeps an operator override', () => {
    const e = setup({});
    e.migrator.migrateConfig(e.result());
    expect(e.readConfig().monitoring?.correctionLearning?.meaningGrouping?.enabled).toBeUndefined();
    const op = setup({ monitoring: { correctionLearning: { enabled: true, meaningGrouping: { enabled: false } } } });
    op.migrator.migrateConfig(op.result());
    expect(op.readConfig().monitoring.correctionLearning.meaningGrouping.enabled).toBe(false);
  });

  it('is registered as a dev-gated feature and installed in server.ts with its own referee', () => {
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'monitoring.correctionLearning.meaningGrouping.enabled')).toHaveLength(1);
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
    expect(src).toMatch(/installJevCorrectionGrouper\(buildJevCorrectionGrouper\(\{/);
    expect(src).toMatch(/referee: groupingReferee,/);
    const routes = fs.readFileSync(path.join(__dirname, '../../src/server/routes.ts'), 'utf8');
    expect(routes).toMatch(/getJevCorrectionGrouper\(\)\);\s*\/\/ Meaning grouping/);
    expect(routes).toMatch(/const grouping = await analyzer\.refreshMeaningGrouping\(\);/);
  });
});

describe('correction-meaning-grouping — alive on a development agent, dark on the fleet', () => {
  async function run(developmentAgent: boolean, mutate?: (e: ReturnType<typeof setup>) => void) {
    const e = setup({ developmentAgent });
    e.migrator.migrateConfig(e.result());
    mutate?.(e);
    const fetchImpl = vi.fn(async () => {
      const a = { choice: 'same', probabilities: { same: 0.97, related: 0.03, different: 0, cannot_tell: 0 } };
      return { ok: true, status: 200, json: async () => ({ model: GROUPING_MODEL, usage: { input_tokens: 620 }, answers: { same: a, same_rev: a } }) } as unknown as Response;
    });
    const config = e.readConfig();
    // Same wiring as server.ts (live config read, dev gate, vault key, no referee needed here).
    installJevCorrectionGrouper(buildJevCorrectionGrouper({
      readLiveConfig: () => e.readConfig().monitoring?.correctionLearning?.meaningGrouping,
      developmentAgent: config.developmentAgent === true,
      readSecret: (n) => (n === 'typesafe_api_key' ? 'k' : null),
      stateDir: e.stateDir,
      fetchImpl: fetchImpl as never,
    }));
    const ledger = new CorrectionLedger({ dbPath: path.join(e.stateDir, 'correction-ledger.db'), machineId: 'e2e' });
    ledgers.push(ledger);
    ['Require approval only for constitution changes.', 'Only ask me to approve changes to the constitution.'].forEach((learning, i) =>
      ledger.record({ kind: 'user-preference', learning, scrubbedSummary: `s${i}`, deterministicWeight: 3, topicId: 1, sessionId: `s${i}`, detectedAt: `2026-05-0${i + 1}T10:00:00Z` }));

    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 'test', stateDir: e.stateDir, port: 0, projectName: 'e2e', monitoring: config.monitoring }, correctionLedger: ledger } as never));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const analyze = await fetch(`${url}/corrections/analyze`, { method: 'POST' });
    const analyzed = await analyze.json() as { grouping: { mode: string }; analysis: { groups: number } };
    const groupsRes = await fetch(`${url}/corrections/groups`);
    const groups = await groupsRes.json() as { mode: string; groupCount: number };
    await new Promise<void>((r) => server.close(() => r()));
    return { e, fetchImpl, analyzeStatus: analyze.status, analyzed, groupsStatus: groupsRes.status, groups };
  }

  it('development agent: analyze runs meaning grouping and forms the group; /corrections/groups is alive', async () => {
    const x = await run(true);
    expect(x.analyzeStatus).toBe(200);
    expect(x.groupsStatus).toBe(200);
    expect(x.fetchImpl).toHaveBeenCalledTimes(1);
    expect(x.analyzed.grouping.mode).toBe('meaning');
    expect(x.analyzed.analysis.groups).toBe(1);
    expect(x.groups).toMatchObject({ mode: 'meaning', groupCount: 1 });
    const rows = fs.readFileSync(path.join(x.e.root, 'logs', 'correction-meaning-grouping.jsonl'), 'utf8');
    expect(rows).toContain('"kind":"run"');
    expect(fs.existsSync(path.join(x.e.stateDir, 'state', 'correction-pair-verdicts.json'))).toBe(true);
  });

  it('fleet agent: dark — no vendor call, word overlap only', async () => {
    const x = await run(false);
    expect(x.fetchImpl).not.toHaveBeenCalled();
    expect(x.analyzed.grouping.mode).toBe('words');
    expect(x.groups).toMatchObject({ mode: 'words', groupCount: 0 });
  });

  it('development agent with an explicit false in config.json: stopped live', async () => {
    const x = await run(true, (e) => {
      const c = e.readConfig();
      c.monitoring.correctionLearning.meaningGrouping = { enabled: false };
      fs.writeFileSync(e.configPath, JSON.stringify(c));
    });
    expect(x.fetchImpl).not.toHaveBeenCalled();
    expect(x.analyzed.grouping.mode).toBe('words');
  });
});
