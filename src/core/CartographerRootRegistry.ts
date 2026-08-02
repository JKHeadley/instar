/**
 * Live Cartographer consumer for verified-root authority.
 *
 * One resolved entry binds the authority assessment, isolated tree, reporting
 * metadata, zero-cost boot population, and paid-authoring revalidation. Routes
 * must resolve once and keep that entry for the entire operation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CartographerTree } from './CartographerTree.js';
import {
  CartographerRootAuthority,
  selectCartographerRootCandidate,
  type CartographerRootAssessment,
  type CartographerRootCandidate,
  type CartographerRootDecision,
  type CartographerRootProvenance,
  type CartographerRootSelectionResult,
} from './CartographerRootAuthority.js';
import {
  populateCartographer,
  type CartographerPopulationConfig,
  type CartographerPopulationResult,
  type CartographerPopulationDeps,
} from './cartographerPopulation.js';
import type { TopicProjectBinding } from './ScopeVerifier.js';
import type { AgentType } from './types.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface CartographerRootReport {
  rootId: string;
  repositoryId: string | null;
  kind: 'agent-home' | 'active-project-checkout' | 'instar-source-checkout';
  canonicalPath: string;
  revision: string | null;
  provenance: CartographerRootProvenance;
  verificationState: 'verified' | 'structural-only';
  verificationReason: CartographerRootAssessment['reason'];
  structuralPopulationAllowed: boolean;
  paidAuthoringAllowed: boolean;
}

export interface CartographerResolvedRoot {
  tree: CartographerTree;
  assessment: CartographerRootAssessment;
  report: CartographerRootReport;
}

export type CartographerRootResolution =
  | { ok: true; root: CartographerResolvedRoot }
  | {
      ok: false;
      reason: string;
      message: string;
      report?: Omit<CartographerRootReport, 'verificationState'> & {
        verificationState: 'refused';
      };
    };

export type CartographerAuthoringDecision =
  | { ok: true; root: CartographerResolvedRoot }
  | { ok: false; reason: string; message: string };

export interface CartographerBootPopulationResult extends CartographerPopulationResult {
  rootAuthority: CartographerRootReport;
}

export interface CartographerRootRegistryOptions {
  agentType: AgentType;
  agentHome: string;
  agentName: string;
  stateDir: string;
  serverProject?: {
    projectDir: string;
    projectName: string;
    gitRemote?: string;
  };
  topicBindings: () => Record<string, TopicProjectBinding>;
  population?: {
    config?: CartographerPopulationConfig;
    onYield?: CartographerPopulationDeps['onYield'];
    /** Test seam only. Production always omits this and uses the real worker. */
    runDetectWorker?: CartographerPopulationDeps['runDetectWorker'];
  };
  decisionLogPath?: string;
  /** Active decision-log ceiling. Default 5 MiB. */
  decisionLogMaxBytes?: number;
  /** Rotated archives retained. Default 2. */
  decisionLogKeepArchives?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

interface CachedResolution {
  signature: string;
  root: CartographerResolvedRoot;
}

type RuntimeDecision =
  | CartographerRootDecision
  | {
      schemaVersion: 1;
      decidedAt: string;
      operation: 'select';
      context: { topicId: number | null; standalone: boolean };
      rule: string;
      outcome: { trust: 'refused' };
    };

function reportFor(
  assessment: CartographerRootAssessment,
): CartographerRootReport | null {
  const identity = assessment.identity;
  if (!identity || assessment.trust === 'refused') return null;
  return {
    rootId: identity.rootId,
    repositoryId: identity.repositoryId,
    kind: identity.kind,
    canonicalPath: identity.canonicalPath,
    revision: identity.revision,
    provenance: { ...assessment.candidate.provenance },
    verificationState: assessment.trust,
    verificationReason: assessment.reason,
    structuralPopulationAllowed: assessment.structuralPopulationAllowed,
    paidAuthoringAllowed: assessment.paidAuthoringAllowed,
  };
}

function refusedReport(
  assessment: CartographerRootAssessment,
): CartographerRootResolution & { ok: false } {
  const identity = assessment.identity;
  const report = identity
    ? {
        rootId: identity.rootId,
        repositoryId: identity.repositoryId,
        kind: identity.kind,
        canonicalPath: identity.canonicalPath,
        revision: identity.revision,
        provenance: { ...assessment.candidate.provenance },
        verificationState: 'refused' as const,
        verificationReason: assessment.reason,
        structuralPopulationAllowed: false,
        paidAuthoringAllowed: false,
      }
    : undefined;
  return {
    ok: false,
    reason: assessment.reason,
    message: `Cartographer root authority refused the selected root (${assessment.reason})`,
    ...(report ? { report } : {}),
  };
}

/**
 * Registry lifetime is one server boot. Assessments therefore pin the exact
 * revision that produced the current hierarchy; paid writes revalidate against
 * that pin instead of silently adopting a later HEAD.
 */
export class CartographerRootRegistry {
  private readonly options: CartographerRootRegistryOptions;
  private readonly authority: CartographerRootAuthority;
  private readonly decisionLogPath: string;
  private readonly decisionLogMaxBytes: number;
  private readonly decisionLogKeepArchives: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly cachedBySelection = new Map<string, CachedResolution>();
  private readonly treesByRootId = new Map<string, CartographerTree>();

  constructor(options: CartographerRootRegistryOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.decisionLogPath = options.decisionLogPath
      ?? path.join(options.stateDir, 'cartographer', 'root-authority-decisions.jsonl');
    this.decisionLogMaxBytes = options.decisionLogMaxBytes && options.decisionLogMaxBytes > 0
      ? options.decisionLogMaxBytes
      : 5 * 1024 * 1024;
    this.decisionLogKeepArchives = options.decisionLogKeepArchives !== undefined
      && options.decisionLogKeepArchives >= 0
      ? Math.floor(options.decisionLogKeepArchives)
      : 2;
    this.authority = new CartographerRootAuthority({
      now: this.now,
      recordDecision: (decision) => this.recordDecision(decision),
    });
  }

  private recordDecision(decision: RuntimeDecision): void {
    fs.mkdirSync(path.dirname(this.decisionLogPath), { recursive: true });
    let activeBytes = 0;
    try {
      activeBytes = fs.statSync(this.decisionLogPath).size;
    } catch {
      // @silent-fallback-ok — a missing active log starts at zero; any other
      // append failure still propagates below and fails the authority outcome.
    }
    if (activeBytes > this.decisionLogMaxBytes) {
      const operation = 'cartographer root-authority decision-log rotation';
      const oldest = `${this.decisionLogPath}.${this.decisionLogKeepArchives}`;
      if (this.decisionLogKeepArchives > 0 && fs.existsSync(oldest)) {
        SafeFsExecutor.safeUnlinkSync(oldest, { operation });
      }
      for (let index = this.decisionLogKeepArchives - 1; index >= 1; index -= 1) {
        const from = `${this.decisionLogPath}.${index}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.decisionLogPath}.${index + 1}`);
      }
      if (this.decisionLogKeepArchives > 0) {
        fs.renameSync(this.decisionLogPath, `${this.decisionLogPath}.1`);
      } else {
        SafeFsExecutor.safeUnlinkSync(this.decisionLogPath, { operation });
      }
    }
    fs.appendFileSync(this.decisionLogPath, `${JSON.stringify(decision)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  private select(topicId?: number): CartographerRootSelectionResult {
    const binding = topicId === undefined
      ? undefined
      : this.options.topicBindings()[String(topicId)];
    return selectCartographerRootCandidate({
      kind: 'active-project-checkout',
      standalone: this.options.agentType === 'standalone',
      ...(this.options.serverProject ? { serverProject: this.options.serverProject } : {}),
      ...(binding && topicId !== undefined
        ? {
            topicBinding: {
              topicId,
              projectDir: binding.projectDir,
              projectName: binding.projectName,
              ...(binding.gitRemote ? { gitRemote: binding.gitRemote } : {}),
            },
          }
        : {}),
    });
  }

  private selectionSignature(candidate: CartographerRootCandidate): string {
    return JSON.stringify({
      kind: candidate.kind,
      requestedPath: candidate.requestedPath,
      provenance: candidate.provenance,
      expectedRemote: candidate.expectedRemote ?? null,
    });
  }

  resolve(topicId?: number): CartographerRootResolution {
    const selection = this.select(topicId);
    if (!selection.ok) {
      try {
        this.recordDecision({
          schemaVersion: 1,
          decidedAt: this.now().toISOString(),
          operation: 'select',
          context: {
            topicId: topicId ?? null,
            standalone: this.options.agentType === 'standalone',
          },
          rule: selection.code,
          outcome: { trust: 'refused' },
        });
      } catch (error) {
        return {
          ok: false,
          reason: 'decision-recording-failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      return { ok: false, reason: selection.code, message: selection.message };
    }

    const signature = this.selectionSignature(selection.candidate);
    const cached = this.cachedBySelection.get(signature);
    if (cached) return { ok: true, root: cached.root };

    let assessment: CartographerRootAssessment;
    try {
      assessment = this.authority.assess(selection.candidate);
    } catch (error) {
      return {
        ok: false,
        reason: 'decision-recording-failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!assessment.structuralPopulationAllowed || assessment.trust === 'refused') {
      return refusedReport(assessment);
    }
    const report = reportFor(assessment);
    if (!report) {
      return {
        ok: false,
        reason: 'identity-unavailable',
        message: 'Cartographer root authority did not mint a usable root identity',
      };
    }
    let tree = this.treesByRootId.get(report.rootId);
    if (!tree) {
      tree = new CartographerTree({
        projectDir: report.canonicalPath,
        stateDir: this.options.stateDir,
        stateNamespace: report.rootId.startsWith('root-')
          ? report.rootId
          : `root-${report.rootId}`,
      });
      this.treesByRootId.set(report.rootId, tree);
    }
    const root = { tree, assessment, report };
    this.cachedBySelection.set(signature, { signature, root });
    return { ok: true, root };
  }

  authorizePaidAuthoring(root: CartographerResolvedRoot): CartographerAuthoringDecision {
    let revalidated: CartographerRootAssessment;
    try {
      revalidated = this.authority.revalidate(root.assessment);
    } catch (error) {
      return {
        ok: false,
        reason: 'decision-recording-failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (
      revalidated.trust !== 'verified'
      || !revalidated.paidAuthoringAllowed
      || revalidated.identity?.rootId !== root.report.rootId
      || revalidated.identity?.revision !== root.report.revision
    ) {
      return {
        ok: false,
        reason: revalidated.reason,
        message: `Cartographer paid authoring refused (${revalidated.reason})`,
      };
    }
    return { ok: true, root };
  }

  /**
   * Per-root trees are regenerable caches, not history. At boot, remove only
   * authority-shaped namespaces no longer selected by any live binding so old
   * topic churn cannot accumulate an unbounded archive of project maps.
   */
  private pruneInactiveRootCaches(activeNamespaces: Set<string>): void {
    const rootsDir = path.join(this.options.stateDir, 'cartographer', 'roots');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootsDir, { withFileTypes: true });
    } catch {
      return; // no root cache directory yet
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^root-[a-f0-9]{24}$/.test(entry.name)) continue;
      if (activeNamespaces.has(entry.name)) continue;
      const target = path.join(rootsDir, entry.name);
      try {
        SafeFsExecutor.safeRmSync(target, {
          recursive: true,
          force: true,
          operation: 'prune inactive Cartographer root cache at boot',
        });
      } catch (error) {
        this.log(`[cartographer-roots] inactive cache prune failed (${entry.name}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Enumerate all explicit live roots and rebuild each hierarchy once per boot. */
  async populateOnBoot(): Promise<CartographerBootPopulationResult[]> {
    const topicIds = Object.keys(this.options.topicBindings())
      .map((raw) => Number(raw))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b);
    const requests: Array<number | undefined> = this.options.agentType === 'standalone'
      ? topicIds
      : [undefined, ...topicIds];
    const roots = new Map<string, CartographerResolvedRoot>();
    for (const topicId of requests) {
      const resolved = this.resolve(topicId);
      if (resolved.ok) roots.set(resolved.root.report.rootId, resolved.root);
    }
    // An empty set can mean a temporarily unreadable/corrupt binding registry.
    // Never turn uncertainty into delete-all; prune only when at least one live
    // root positively selected and can anchor the keep set.
    if (roots.size > 0) {
      this.pruneInactiveRootCaches(new Set(
        [...roots.values()].map((root) => `root-${root.report.rootId}`),
      ));
    }

    const results: CartographerBootPopulationResult[] = [];
    for (const root of roots.values()) {
      const result = await populateCartographer({
        tree: root.tree,
        ...(this.options.population?.config ? { config: this.options.population.config } : {}),
        ...(this.options.population?.onYield ? { onYield: this.options.population.onYield } : {}),
        ...(this.options.population?.runDetectWorker
          ? { runDetectWorker: this.options.population.runDetectWorker }
          : {}),
      });
      results.push({ ...result, rootAuthority: root.report });
    }
    return results;
  }
}
