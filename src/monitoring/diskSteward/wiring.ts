/**
 * Disk Steward production wiring (spec docs/specs/disk-steward.md §3).
 * Kept out of server.ts so the composition is testable: the server passes the
 * few live handles it owns (state, telegram, peer resolver, identity) and gets
 * back a started steward plus its runner.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskSteward, type DuePost, type PeerHandle, type SendOutcome, type DiskStewardStatus } from '../DiskSteward.js';
import { PruneRunner } from './pruneRunner.js';
import { makeDiskStewardSender } from '../DiskStewardPoster.js';
import { DEFAULT_THRESHOLDS, type DiskStewardThresholdConfig } from './levels.js';
import { DegradationReporter } from '../DegradationReporter.js';
import { featureEvidence } from '../FeatureEvidenceLog.js';

export const DISK_TOPIC_NAME = 'Disk space (all machines)';
export const DISK_TOPIC_STATE_KEY = 'agent-disk-topic';

export interface DiskStewardConfig {
  enabled?: boolean;
  sampleIntervalMs?: number;
  topicId?: number | null;
  warnPercent?: number; warnMinGiB?: number; escalatePercent?: number; escalateMinGiB?: number; forecastEscalateDays?: number;
  prune?: { enabled?: boolean; dryRun?: boolean; minIntervalMs?: number; npmCacheMaxGiB?: number };
}

export interface DiskStewardWiringInput {
  readConfig: () => { diskSteward?: DiskStewardConfig; developmentAgent?: boolean; reaper?: { enabled?: boolean; dryRun?: boolean } };
  stateDir: string;
  agentHome: string;
  agentName: string;
  machineId: string;
  machineName: () => string;
  isHolder: () => boolean;
  /** Other active machines with a credential-admissible URL. */
  peers: () => Array<{ machineId: string; url: string | null; allowed: boolean }>;
  authToken: string | undefined;
  /** State get/set for the system-topic key (holder writes it; standbys adopt it). */
  getTopicId: () => number | null;
  setTopicId: (id: number) => void;
  canCreateTopic: () => boolean;
  findTopicIdByName?: (name: string) => number | undefined;
  findOrCreateTopic?: (name: string) => Promise<number>;
  sendToTopic?: (topicId: number, text: string) => Promise<unknown>;
}

function num(v: unknown, d: number): number { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d; }

export function createDiskSteward(input: DiskStewardWiringInput): { steward: DiskSteward; runner: PruneRunner; intervalMs: number } {
  const dsCfg = () => input.readConfig().diskSteward ?? {};
  const stewardDir = path.join(input.stateDir, 'state', 'disk-steward');
  const auditPath = path.join(input.stateDir, '..', 'logs', 'disk-steward.jsonl');
  const audit = (e: Record<string, unknown>) => {
    try { fs.mkdirSync(path.dirname(auditPath), { recursive: true }); fs.appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), machineId: input.machineId, ...e }) + '\n'); }
    catch { /* @silent-fallback-ok — a full disk may refuse the audit line; the steward keeps going */ }
  };
  const mainScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'diskStewardMain.js');
  const runner = new PruneRunner({
    stateDir: stewardDir, agent: input.agentName, agentHome: input.agentHome, mainScript, nodePath: process.execPath,
    npmCacheMaxGiB: () => num(dsCfg().prune?.npmCacheMaxGiB, 5), auditPath,
  });

  let topicIdCache: number | null = null;
  const resolveTopicId = async (): Promise<number | null> => {
    const fromCfg = dsCfg().topicId;
    if (typeof fromCfg === 'number' && fromCfg > 0) {
      if (input.canCreateTopic() && input.getTopicId() !== fromCfg) input.setTopicId(fromCfg);
      return fromCfg;
    }
    const recorded = input.getTopicId();
    if (recorded) return recorded;
    if (topicIdCache) return topicIdCache;
    if (!input.canCreateTopic()) return null; // a standby never creates
    const found = input.findTopicIdByName?.(DISK_TOPIC_NAME);
    if (found) { input.setTopicId(found); topicIdCache = found; return found; }
    if (!input.findOrCreateTopic) return null;
    const id = await input.findOrCreateTopic(DISK_TOPIC_NAME);
    input.setTopicId(id);
    topicIdCache = id;
    return id;
  };

  const send: (post: DuePost) => Promise<SendOutcome> = input.sendToTopic
    ? makeDiskStewardSender({ resolveTopicId, sendToTopic: input.sendToTopic, log: audit })
    : async () => 'posted'; // no Telegram: the route and the degradation report are the surfaces (§3.5)

  const headers = (): Record<string, string> => ({ 'Content-Type': 'application/json', ...(input.authToken ? { Authorization: `Bearer ${input.authToken}` } : {}) });
  const peers = async (): Promise<PeerHandle[]> => input.peers().filter((p) => p.url && p.allowed).map((p) => ({
    machineId: p.machineId,
    status: async () => {
      try {
        const res = await fetch(`${p.url!.replace(/\/$/, '')}/disk-steward`, { headers: headers(), signal: AbortSignal.timeout(5_000) });
        if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` };
        return { ok: true as const, body: (await res.json()) as DiskStewardStatus };
      } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) }; }
    },
    ack: async (postId, outcome) => {
      try {
        const res = await fetch(`${p.url!.replace(/\/$/, '')}/disk-steward/posted`, { method: 'POST', headers: headers(), body: JSON.stringify({ postId, outcome }), signal: AbortSignal.timeout(5_000) });
        return res.ok;
      } catch { return false; } // @silent-fallback-ok — the peer keeps its due post and the holder retries next tick
    },
  }));

  const steward = new DiskSteward({
    machineId: input.machineId,
    machineName: input.machineName,
    agentHome: input.agentHome,
    stateFile: path.join(stewardDir, `${input.machineId}.json`),
    now: () => Date.now(),
    statfs: () => {
      try { const s = fs.statfsSync(input.agentHome); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; }
      catch { return null; } // @silent-fallback-ok — reported by the steward as a degradation
    },
    isHolder: input.isHolder,
    runner,
    pruneEnabled: () => dsCfg().prune?.enabled === true,
    pruneDryRun: () => dsCfg().prune?.dryRun === true,
    reaperArmed: () => { const r = input.readConfig().reaper; return r ? (r.enabled === true && r.dryRun === false) : null; },
    thresholds: (): DiskStewardThresholdConfig => {
      const c = dsCfg();
      return {
        warnPercent: num(c.warnPercent, DEFAULT_THRESHOLDS.warnPercent), warnMinGiB: num(c.warnMinGiB, DEFAULT_THRESHOLDS.warnMinGiB),
        escalatePercent: num(c.escalatePercent, DEFAULT_THRESHOLDS.escalatePercent), escalateMinGiB: num(c.escalateMinGiB, DEFAULT_THRESHOLDS.escalateMinGiB),
        forecastEscalateDays: num(c.forecastEscalateDays, DEFAULT_THRESHOLDS.forecastEscalateDays),
      };
    },
    pruneMinIntervalMs: () => num(dsCfg().prune?.minIntervalMs, 6 * 3_600_000),
    peers,
    send,
    log: audit,
    degrade: (feature, message) => { try { DegradationReporter.getInstance().report({ feature, primary: 'disk steward', fallback: 'skipped this check', reason: message, impact: message }); } catch { /* @silent-fallback-ok — reporter unavailable early in boot */ } },
    evidence: (kind, reason) => { try { featureEvidence.record('monitoring.diskSteward.prune', { kind, reason }); } catch { /* @silent-fallback-ok — evidence log is best-effort */ } },
  });
  const recovered = runner.recover();
  if (recovered.outcome !== 'none') audit({ event: 'boot-recovery', outcome: recovered.outcome, runId: recovered.record?.runId ?? null });
  if (recovered.outcome === 'collected') steward.adoptRecoveredResult(recovered.result);
  return { steward, runner, intervalMs: num(dsCfg().sampleIntervalMs, 15 * 60_000) };
}

/** Machine name for posts: registry nickname, else identity name, else hostname. */
export function diskStewardMachineName(nickname: string | null | undefined, identityName: string | null | undefined): string {
  return (nickname && nickname.trim()) || (identityName && identityName.trim()) || os.hostname();
}
