/**
 * Builds the owned-repository registry for one server (docs/specs/no-data-loss-on-machine-death.md
 * increment 1). Kept out of server.ts so the production path and the E2E test share one builder.
 *
 * Switch: `noDataLoss.repos.enabled`, resolved by the development-agent gate (live on a
 * development agent, dark on the fleet; an explicit value wins).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDevAgentGate } from '../../core/devAgentGate.js';
import { setRepoBirthObserver } from '../../core/SafeGitExecutor.js';
import { OwnedRepoRegistry } from './OwnedRepoRegistry.js';
import { readGit, type GitReader } from './repoGit.js';
import type { OwnedRepoRouteDeps } from '../../server/ownedRepoRoutes.js';
import { OWNED_REPO_STORE_KEY, validateOwnedRepoReplica, type OwnedRepoReplica } from '../../core/OwnedRepoReplicatedStore.js';

export const OWNED_REPO_TICK_MS = 15 * 60_000;

export interface OwnedReposConfig {
  developmentAgent?: boolean;
  noDataLoss?: { repos?: { enabled?: boolean; roots?: string[] } };
}

export function ownedReposEnabled(config: OwnedReposConfig): boolean {
  return resolveDevAgentGate(config.noDataLoss?.repos?.enabled, config);
}

export interface OwnedReposInput {
  config: OwnedReposConfig;
  stateDir: string;
  machineId: string;
  machineName: () => string;
  userHome?: string;
  git?: GitReader;
  peers: OwnedRepoRouteDeps['peers'];
  authToken: string | undefined;
  /** Disk below its warn line (the grace window shortens to 1 h). */
  atRisk?: () => boolean;
  /** WS2 emit + read seams; absent ⇒ the pool read is live-only. */
  emit?: (rec: OwnedRepoReplica) => void;
  loadReplicas?: () => Array<{ origin: string; data: unknown }>;
  /** Registered agents' homes (GET /agents), this one included. */
  agentHomes?: () => string[];
  /** Hook events (session evidence): `on('event', payload)`. */
  hookEvents?: { on: (event: 'event', fn: (p: { cwd?: unknown; tool_input?: Record<string, unknown> }) => void) => unknown };
  log?: (e: Record<string, unknown>) => void;
}

export interface OwnedReposHandle {
  registry: OwnedRepoRegistry;
  routeDeps: () => OwnedRepoRouteDeps;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

function projectRoots(stateDir: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'project-registry.json'), 'utf8')) as Array<{ dir?: unknown }>;
    return Array.isArray(raw) ? raw.map((p) => p?.dir).filter((d): d is string => typeof d === 'string' && path.isAbsolute(d)) : [];
  } catch { return []; } // @silent-fallback-ok — no project registry yet: the agent home is still scanned
}

const AUDIT_MAX_BYTES = 16 * 1024 * 1024;
const AUDIT_KEEP = 4;

/** The audit of every tick and repair (metadata only), rotated at 16 MB with 4 kept (spec §Defaults "Audit log"). */
export function auditWriter(file: string): (e: Record<string, unknown>) => void {
  return (e) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let size = 0;
      try { size = fs.statSync(file).size; } catch { size = 0; } // @silent-fallback-ok — no log yet
      if (size >= AUDIT_MAX_BYTES) {
        for (let i = AUDIT_KEEP - 1; i >= 1; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* @silent-fallback-ok — that segment does not exist yet */ } }
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
    } catch { /* @silent-fallback-ok — a full disk may refuse the audit line; the registry keeps going and its state is still served */ }
  };
}

export function createOwnedRepos(input: OwnedReposInput): OwnedReposHandle {
  const agentHome = path.dirname(input.stateDir);
  const userHome = input.userHome ?? os.homedir();
  const declared = () => (input.config.noDataLoss?.repos?.roots ?? []).filter((r) => typeof r === 'string' && path.isAbsolute(r));
  const registry = new OwnedRepoRegistry({
    machineId: input.machineId,
    machineName: input.machineName,
    agentHome,
    userHome,
    stateFile: path.join(input.stateDir, 'state', 'owned-repos', `${input.machineId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`),
    git: input.git ?? readGit,
    roots: () => projectRoots(input.stateDir),
    declaredRoots: declared,
    otherAgentHomes: () => (input.agentHomes?.() ?? []).filter((h) => path.resolve(h) !== path.resolve(agentHome)),
    atRisk: input.atRisk,
    emit: input.emit,
    log: input.log ?? auditWriter(path.join(input.stateDir, 'logs', 'no-data-loss.jsonl')),
  });

  // Registration at birth: SafeGitExecutor's init / clone observer (§1.3 path 1).
  setRepoBirthObserver((repoPath, via) => registry.noteBirth(repoPath, via));
  // Session evidence: the working directory and file paths of hook events (§1.3 path 2).
  input.hookEvents?.on('event', (p) => {
    registry.noteSessionPath(p?.cwd);
    const fp = p?.tool_input && typeof p.tool_input === 'object' ? (p.tool_input as Record<string, unknown>).file_path : undefined;
    registry.noteSessionPath(fp);
  });

  const replicas = (): Map<string, OwnedRepoReplica[]> => {
    const out = new Map<string, OwnedRepoReplica[]>();
    for (const r of input.loadReplicas?.() ?? []) {
      if (r.origin === input.machineId) continue;
      const rep = validateOwnedRepoReplica((r.data as { repo?: unknown } | null)?.repo);
      if (!rep || rep.machineId !== r.origin) continue;
      const list = out.get(r.origin) ?? [];
      list.push(rep);
      out.set(r.origin, list);
    }
    return out;
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    registry,
    routeDeps: () => ({ registry, machineId: input.machineId, peers: input.peers, authToken: input.authToken, replicas }),
    start: (intervalMs = OWNED_REPO_TICK_MS) => {
      const first = setTimeout(() => { void registry.tick(); }, 30_000);
      first.unref?.();
      timer = setInterval(() => { void registry.tick(); }, intervalMs);
      timer.unref?.();
    },
    stop: () => { if (timer) clearInterval(timer); timer = null; setRepoBirthObserver(null); },
  };
}

export { OWNED_REPO_STORE_KEY };
