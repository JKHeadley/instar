// safe-fs-allow: test helper — SafeFsExecutor used for tmpdir cleanup by its callers.
/**
 * A machine of the Gemini pay-per-use lane, booted the way AgentServer boots it
 * (docs/specs/gemini-payg-metered-lane.md §8): the enable surface ALWAYS; the money
 * layer only when `moneyLayerShouldConstruct` says so (the operator's PIN-committed
 * flag); the lane and the go-live on every machine; the pending intent applied before
 * serving. Real collaborators throughout — real caps store, ledger, price authority,
 * gate, provider and transport (against a fake Google), real routes. Only the vault
 * read and the mesh transport are in-memory stand-ins.
 *
 * Not a test file: imported by the integration and E2E suites.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { MeteredSpendLedger } from '../../src/core/MeteredSpendLedger.js';
import { RoutingSpendCapsStore } from '../../src/core/RoutingSpendCapsStore.js';
import { RoutingPriceAuthority } from '../../src/core/routingPriceAuthority.js';
import { MeteredSpendGate } from '../../src/core/MeteredSpendGate.js';
import { MoneyLayerEnableStore } from '../../src/core/MoneyLayerEnableStore.js';
import { MoneyLayerAuditLog } from '../../src/core/MoneyLayerAuditLog.js';
import { MoneyLayerEnableSurface } from '../../src/core/MoneyLayerEnableSurface.js';
import { knownMeteredKeyRefs } from '../../src/core/routingSpendView.js';
import { METERED_ROUTING_DOORS } from '../../src/data/llmBenchCoverage.js';
import { PROBE_DOOR, PROBE_KEY_REF } from '../../src/core/moneyLayerProbe.js';
import { RenderedPlanStore } from '../../src/core/RenderedPlanStore.js';
import { moneyLayerShouldConstruct } from '../../src/core/moneyLayerEnable.js';
import { buildGeminiPaygLane, type GeminiPaygLane } from '../../src/server/geminiPaygWiring.js';
import { buildGeminiPaygGoLive, type GeminiPaygGoLive } from '../../src/server/geminiPaygGoLiveWiring.js';

export const PIN = '246813';
export const KEY = 'AIzaSy-GO-LIVE-HARNESS-KEY-0123456789abcd';
export const KEY_FP = crypto.createHash('sha256').update(KEY, 'utf8').digest('hex');

/** A fake Google endpoint: countTokens and generateContent, counting the paid calls. */
export async function startFakeGoogle(): Promise<{ origin: string; generateCalls: () => number; close: () => Promise<void> }> {
  let generate = 0;
  const srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').includes(':countTokens')) { res.end(JSON.stringify({ totalTokens: 20 })); return; }
      generate++;
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ready' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 10 } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    origin: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    generateCalls: () => generate,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

/** The shipped price manifest's gemini-api door, with its two points marked verified (or not). */
export function seedManifest(projectDir: string, verified: boolean): void {
  const real = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts', 'routing-prices.manifest.json'), 'utf-8')) as { doors: Record<string, unknown>; points: Array<Record<string, unknown>> };
  const points = real.points
    .filter((p) => p.door === 'gemini-api' && (p.modelId === 'gemini-4-neon' || p.modelId === 'gemini-4-hydrogen'))
    .map((p) => ({ ...p, verified, maxInputTokens: 1_000_000, effectiveAt: '2026-11-15T00:00:00Z' }));
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'scripts', 'routing-prices.manifest.json'), JSON.stringify({ schemaVersion: 1, version: 1, doors: { 'gemini-api': real.doors['gemini-api'] }, points }));
}

export interface MachineOptions {
  self: string;
  name?: string;
  stateDir: string;
  projectDir: string;
  origin: string;
  /** The vault: name → value (only this machine's). */
  vault: Record<string, string>;
  peers?: () => string[];
  poolOn?: boolean;
  now?: () => number;
  failoverTimeoutMinutes?: number;
}

export interface Machine {
  app: express.Express;
  surface: MoneyLayerEnableSurface;
  audit: MoneyLayerAuditLog;
  enableStore: MoneyLayerEnableStore;
  capsStore: RoutingSpendCapsStore | null;
  ledger: MeteredSpendLedger | null;
  gate: MeteredSpendGate | null;
  lane: GeminiPaygLane;
  goLive: GeminiPaygGoLive;
  restarts: string[];
  self: string;
}

/** Boot one machine. `mesh` delivers a command to another machine's runtime (authenticated sender = this machine). */
export function bootMachine(o: MachineOptions, mesh?: (to: string, cmd: Record<string, unknown>) => Promise<unknown>): Machine {
  const now = o.now ?? (() => Date.now());
  const enableStore = new MoneyLayerEnableStore({ stateDir: o.stateDir });
  const constructs = moneyLayerShouldConstruct({ configEnabled: false, operatorEnabled: enableStore.operatorEnabled() });
  let ledger: MeteredSpendLedger | null = null;
  let capsStore: RoutingSpendCapsStore | null = null;
  let gate: MeteredSpendGate | null = null;
  let planStore: RenderedPlanStore | null = null;
  let lane: GeminiPaygLane | null = null;
  const prices = new RoutingPriceAuthority({ projectDir: o.projectDir, stateDir: o.stateDir });
  if (constructs) {
    ledger = new MeteredSpendLedger({ stateDir: o.stateDir, now, zoneForKey: (k) => { try { return capsStore?.read().caps[k]?.periodTimeZone; } catch { return undefined; } } });
    capsStore = new RoutingSpendCapsStore({
      stateDir: o.stateDir,
      knownKeyRefs: new Set([...knownMeteredKeyRefs(), PROBE_KEY_REF]),
      knownDoors: new Set([...METERED_ROUTING_DOORS, PROBE_DOOR] as string[]),
      now,
    });
    capsStore.ensureProbeDoor(o.self);
    gate = new MeteredSpendGate({ ledger, prices, capsStore, machineId: o.self, now, leaseConfirmedAgoMs: () => (o.poolOn ? (lane?.runtime.leaseConfirmedAgoMs() ?? null) : 0) });
    planStore = new RenderedPlanStore();
  }
  const audit = new MoneyLayerAuditLog({ stateDir: o.stateDir });
  let goLiveRef: GeminiPaygGoLive | null = null;
  const surface = new MoneyLayerEnableSurface({
    store: enableStore,
    audit,
    machineId: o.self,
    machineNickname: o.name ?? null,
    configEnabled: () => false,
    configSnapshotAt: () => new Date(now()).toISOString(),
    componentsConstructed: () => gate !== null && ledger !== null,
    gate: () => gate,
    capsSnapshot: () => { try { return capsStore?.read() ?? null; } catch { return null; } },
    ledger: () => ledger,
    lockHeld: () => true,
    settlingCount: () => ledger?.outstandingReserveCount() ?? 0,
    geminiPayg: () => goLiveRef?.port ?? null,
    now,
  });
  lane = buildGeminiPaygLane({
    stateDir: o.stateDir,
    selfMachineId: o.self,
    capsStore: () => capsStore,
    gate: () => gate,
    ledger: () => ledger,
    servingReady: () => surface.servingReady(),
    peers: () => o.peers?.() ?? [],
    isLiveSession: () => false,
    reviewRoots: () => [o.projectDir],
    notify: (k, t, m) => goLiveRef?.laneNotify(k, t, m),
    onRefusal: (e) => goLiveRef?.onRefusal(e),
    releaseProof: async (origin, payload) => goLiveRef!.releaseProofForwarded(origin, payload),
    renderSetup: async (by) => goLiveRef!.renderForPeer(by),
    credentialEnv: {},
    testOrigin: o.origin,
    vaultGet: (name) => o.vault[name],
  });
  const restarts: string[] = [];
  const goLive = buildGeminiPaygGoLive({
    stateDir: o.stateDir,
    selfMachineId: o.self,
    selfMachineName: o.name ?? null,
    lane,
    capsStore: () => capsStore,
    ledger: () => ledger,
    prices: () => prices,
    servingReady: () => surface.servingReady(),
    moneyAudit: () => audit,
    failoverThresholdMs: () => (o.failoverTimeoutMinutes ?? 15) * 60_000,
    multiMachine: () => (o.peers?.() ?? []).length > 0,
    isLiveSession: () => false,
    deliverNotice: async () => true,
    now,
  });
  goLiveRef = goLive;
  goLive.setRenderer(() => surface.renderPlanAsync('gemini-payg-setup'));
  if (capsStore) goLive.applyPending(capsStore);
  if (mesh) lane.runtime.setSend((to, cmd) => mesh(to, cmd));

  const ctx = {
    config: {
      projectName: 'test', projectDir: o.projectDir, stateDir: o.stateDir, port: 0, dashboardPin: PIN, developmentAgent: true,
      authToken: 'test-token',
      routingSpend: { enabled: true, money: { enabled: false } }, sessions: {} as unknown, scheduler: {} as unknown,
    } as unknown,
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    tokenLedger: null, featureMetricsLedger: null, routingPriceAuthority: prices,
    meteredSpendLedger: ledger, routingSpendCapsStore: capsStore, meteredSpendGate: gate, spendPlanStore: planStore,
    moneyLayerEnableSurface: surface, moneyLayerAudit: audit,
    geminiPaygGoLive: goLive, meteredLaneRuntime: lane.runtime, meshSelfId: o.self,
    requestSupervisedRestart: (reason: string) => { restarts.push(reason); return true; },
    intelligence: null, startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/', createRoutes(ctx));
  app.use(lane.router);
  app.use(goLive.router);
  return { app, surface, audit, enableStore, capsStore, ledger, gate, lane, goLive, restarts, self: o.self };
}

/** Write the account lane's artifacts (two screenshots, one transcript) and return a valid handoff body. */
export function writeHandoffArtifacts(dir: string, opts: { designationEpoch?: number; keyCount?: number; transcriptText?: string; readAt?: string } = {}): Record<string, unknown> {
  fs.mkdirSync(dir, { recursive: true });
  const shot1 = path.join(dir, 'one-key.png');
  const shot2 = path.join(dir, 'limit.png');
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(shot1, 'png-one-key');
  fs.writeFileSync(shot2, 'png-limit');
  fs.writeFileSync(transcript, opts.transcriptText ?? '{"role":"assistant","text":"key stored via the no-echo pipe"}\n');
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const readAt = opts.readAt ?? new Date(Date.now() + 1000).toISOString();
  return {
    noEchoTransfer: { attestedBy: 'account-lane', at: readAt, method: 'secret-drop-retrieve --run -- secret-set', sourceMessageRef: 'echo-topic-145625#1' },
    oneKeyArtifact: { providerKeyId: 'projects/p/keys/k1', keyFingerprint: KEY_FP, readAt, screenshotPath: shot1, screenshotSha256: sha(shot1), keyCount: opts.keyCount ?? 1 },
    googleSpendLimit: { kind: 'budget-alert-only', amountUsd: 50, readAt, screenshotPath: shot2, screenshotSha256: sha(shot2) },
    boundTo: { designationEpoch: opts.designationEpoch ?? 1 },
    transcripts: { paths: [transcript], complete: true },
  };
}
