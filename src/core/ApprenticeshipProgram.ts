/**
 * ApprenticeshipProgram — the standing program scaffold for apprenticeship /
 * mentorship instances (Apprenticeship Step 1, APPRENTICESHIP-STEP1-PROGRAM-
 * SCAFFOLD-SPEC.md).
 *
 * Each instance is a project under a standing program that crystallizes by
 * bootstrap. This module is the instance-as-project REGISTRY plus the two
 * lifecycle GATES that make "review before you start / capture before you
 * close" unskippable at the state-mutating transition:
 *
 *   - the RETRO-GATE (pending→active): refused unless the prior instance's
 *     retro-harvest exists at its CANONICAL CONFINED PATH and passes the
 *     Step 0 validator (the first instance is seeded by the Echo→Codey
 *     bootstrap harvest).
 *   - the DOC-AS-REQUIRED-ARTIFACT GATE (active→complete): refused until the
 *     instance's declared-required artifacts are VERIFIED PRESENT FROM LIVE
 *     STATE (never a stored flag).
 *
 * Signal vs Authority / The Body and the Mind: the gates are structural
 * preconditions on OBJECTIVE artifacts ("does a validated harvest exist?",
 * "is there ≥1 instance-scoped ledger entry?"). They are NOT quality
 * judgments — whether the mentor truly internalized the lessons stays with
 * the overseer (the mind), informed by the gate. Every verdict is appended
 * to logs/apprenticeship-decisions.jsonl (the decision audit).
 *
 * Concurrency: file-backed store at `.instar/apprenticeship/instances.json`,
 * atomic tmp-write+rename, with a single in-process serialized mutator and an
 * optimistic `version` CAS (lost-update safe under the single-process-per-agent
 * AgentServer model). A corrupt/unparseable store FAILS CLOSED — gates return
 * `allow:false`, never "no prior instance → open the gate".
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  validateRetroHarvest,
  parseArtifact,
  safeArtifactPath,
  type ValidateResult,
} from './retroHarvestValidator.js';

// ── Types ────────────────────────────────────────────────────────────

export type InstanceType = 'apprenticeship' | 'mentorship';
export type InstanceStatus = 'pending' | 'active' | 'complete' | 'blocked' | 'abandoned';

/** A tracked program-need with its target step + a resolvable honoredBy slot (§4). */
export interface ProgramNeed {
  id: string;
  targetStep: number;
  /**
   * NOT a self-certifying boolean — must reference a concrete, resolvable
   * artifact (a merged spec slug `docs/specs/<slug>.md`, or `pr:<n>`). A
   * later step's gate / review job validates the reference resolves before
   * treating the need as honored. null = still open.
   */
  honoredBy: string | null;
}

export interface ApprenticeshipInstance {
  /** create-time clamp ^[a-z0-9-]+$ ; unique (dup-create rejected). */
  id: string;
  instanceType: InstanceType;
  /** each ^[a-z0-9-]+$ */
  overseer: string;
  mentor: string;
  mentee: string;
  /** ^[a-z0-9-]+$ (flows into the ledger-count query). */
  framework: string;
  status: InstanceStatus;
  /** Independence ladder rung, per approved ladder spec §5.1. */
  ladderRung: 0 | 1 | 2 | 3 | 4 | 5;
  /** Append-only evidence trail for rung changes. */
  rungHistory: Array<{ rung: 0 | 1 | 2 | 3 | 4 | 5; at: string; evidenceRef: string }>;
  /** for the retro-gate; must resolve to a `complete` instance (or null = bootstrap). */
  priorInstanceId: string | null;
  /** the CHECKLIST DEFINITION (what's required), not evidence. Immutable after create. */
  requiredArtifacts: {
    retroHarvest: boolean;
    ledgerEntries: boolean;
    detectorAudit: boolean;
  };
  /** tracked sequencing of the deferred needs (Close-the-Loop). */
  programNeeds: ProgramNeed[];
  /** canonical harvest identity, computed at create (§3.5). harvestFrom = mentor. */
  harvestFrom: string;
  /** harvestTo = mentee. */
  harvestTo: string;
  /** recorded for humans; NEVER the resolution source (§3.5). */
  harvestRef: string | null;
  /** optimistic-CAS counter for the serialized mutator (§3.1). */
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface InstanceStore {
  version: 1;
  instances: ApprenticeshipInstance[];
  lastModified: string;
}

export interface CreateInstanceInput {
  id: string;
  instanceType: InstanceType;
  overseer?: string;
  mentor: string;
  mentee: string;
  framework: string;
  priorInstanceId?: string | null;
  requiredArtifacts?: Partial<ApprenticeshipInstance['requiredArtifacts']>;
  programNeeds?: ProgramNeed[];
}

/** Gate verdict shapes (§3.3). */
export interface StartGateVerdict {
  allow: boolean;
  reason: string;
}

export interface CompletionGateVerdict {
  allow: boolean;
  reason: string;
  missing: string[];
}

/**
 * Injected dependencies for the gates (§3.3). Truth is re-derived from these
 * LIVE deps, never from a stored requiredArtifacts boolean. Default impls read
 * the real filesystem / validator; tests inject fakes and wiring-integrity
 * tests assert the real ones are not no-ops.
 */
export interface GateDeps {
  /** Read the canonical harvest text. Returns null when the file is absent. */
  readHarvest: (relPath: string) => string | null;
  /** Validate harvest text (the Step 0 structural validator). */
  validate: (text: string, opts?: { priorHarvestExists?: boolean }) => ValidateResult;
  /** Count ledger entries scoped to THIS instance (framework + instance ref). ≥1 required. */
  countInstanceLedgerEntries: (instance: ApprenticeshipInstance) => number;
  /** Does the instance-scoped detector-audit artifact exist? */
  detectorAuditExists: (instance: ApprenticeshipInstance) => boolean;
}

/**
 * Step-4 differential-computation surface (§2). Declared here as a typed no-op
 * interface so its LOCATION is resolved in Step 1; the real implementation
 * lands in Step 4. The overseer (the mind) computes the differential between
 * the mentee's raw streams and the mentor's reports.
 */
export interface ApprenticeshipOverseer {
  /**
   * Compute the differential read-channel for an instance (need-001). The
   * Step-1 stub returns an explicit not-implemented marker — never silently
   * "no differences". Implemented in Step 4.
   */
  computeDifferential(instance: ApprenticeshipInstance): { implemented: false; reason: string };
}

/** The typed no-op overseer stub (§2). */
export const noopApprenticeshipOverseer: ApprenticeshipOverseer = {
  computeDifferential(_instance: ApprenticeshipInstance) {
    return { implemented: false, reason: 'differential read-channel is implemented in Step 4 (need-001)' };
  },
};

const CHARSET_RE = /^[a-z0-9-]+$/;

/** Legal status transitions (§3.4). `complete` and `abandoned` are terminal. */
const TRANSITIONS: Record<InstanceStatus, InstanceStatus[]> = {
  pending: ['active', 'abandoned'],
  active: ['complete', 'blocked'],
  blocked: ['active'],
  complete: [], // terminal
  abandoned: [], // terminal — retained disposal for a never-started mistake
};

export interface ApprenticeshipProgramConfig {
  /** Agent state dir (`.instar`). The store lives at `<stateDir>/apprenticeship/instances.json`. */
  stateDir: string;
  /** Project root — the canonical harvest path is resolved against this. */
  projectDir: string;
  /** Decision-audit log path. Default `<stateDir>/logs/apprenticeship-decisions.jsonl`. */
  decisionLogPath?: string;
  /** Override gate deps (tests). Defaults read the real fs + validator. */
  deps?: Partial<GateDeps>;
}

// ── Implementation ───────────────────────────────────────────────────

export class ApprenticeshipProgram {
  private storePath: string;
  private decisionLogPath: string;
  private projectDir: string;
  private store: InstanceStore;
  /** True when the on-disk store was unparseable → gates fail closed. */
  private corrupt = false;
  private deps: GateDeps;

  constructor(config: ApprenticeshipProgramConfig) {
    this.storePath = path.join(config.stateDir, 'apprenticeship', 'instances.json');
    this.decisionLogPath =
      config.decisionLogPath ?? path.join(config.stateDir, 'logs', 'apprenticeship-decisions.jsonl');
    this.projectDir = config.projectDir;
    this.deps = {
      readHarvest: config.deps?.readHarvest ?? ((rel) => this.defaultReadHarvest(rel)),
      validate: config.deps?.validate ?? validateRetroHarvest,
      countInstanceLedgerEntries:
        config.deps?.countInstanceLedgerEntries ?? (() => 0),
      detectorAuditExists: config.deps?.detectorAuditExists ?? (() => false),
    };
    this.store = this.loadStore();
  }

  /** Default harvest reader — resolves the confined relative path under projectDir. */
  private defaultReadHarvest(relPath: string): string | null {
    try {
      const full = path.join(this.projectDir, relPath);
      if (!fs.existsSync(full)) return null;
      return fs.readFileSync(full, 'utf-8');
    } catch {
      return null;
    }
  }

  // ── Persistence ────────────────────────────────────────────────────

  private loadStore(): InstanceStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        const data = JSON.parse(raw);
        if (data && data.version === 1 && Array.isArray(data.instances)) {
          this.corrupt = false;
          let normalized = false;
          const instances = (data.instances as ApprenticeshipInstance[]).map((instance) => {
            const hasRung = Object.prototype.hasOwnProperty.call(instance, 'ladderRung');
            const hasHistory = Object.prototype.hasOwnProperty.call(instance, 'rungHistory');
            if (hasRung || hasHistory) {
              const validRung = Number.isInteger(instance.ladderRung)
                && instance.ladderRung >= 0 && instance.ladderRung <= 5;
              const validHistory = Array.isArray(instance.rungHistory)
                && instance.rungHistory.length > 0
                && instance.rungHistory.every((entry) => entry
                  && Number.isInteger(entry.rung) && entry.rung >= 0 && entry.rung <= 5
                  && typeof entry.at === 'string' && entry.at.trim().length > 0
                  && typeof entry.evidenceRef === 'string' && entry.evidenceRef.trim().length > 0)
                && instance.rungHistory.at(-1)?.rung === instance.ladderRung;
              if (!validRung || !validHistory || !hasRung || !hasHistory) {
                throw new Error('invalid apprenticeship ladder state');
              }
              return instance;
            }
            normalized = true;
            const rung = 0 as const;
            return {
              ...instance,
              ladderRung: rung,
              rungHistory: [{
                rung,
                at: instance.createdAt ?? new Date().toISOString(),
                evidenceRef: 'migration:pre-ladder-registry',
              }],
            };
          });
          const loaded = { ...data, instances } as InstanceStore;
          if (normalized) {
            this.store = loaded;
            this.saveStore();
          }
          return loaded;
        }
        // Present but unparseable shape → fail closed (do NOT silently reset).
        this.corrupt = true;
        return { version: 1, instances: [], lastModified: new Date().toISOString() };
      }
    } catch {
      // A present-but-corrupt file fails closed; a truly-missing file is fresh.
      if (fs.existsSync(this.storePath)) {
        this.corrupt = true;
        return { version: 1, instances: [], lastModified: new Date().toISOString() };
      }
    }
    this.corrupt = false;
    return { version: 1, instances: [], lastModified: new Date().toISOString() };
  }

  private saveStore(): void {
    this.store.lastModified = new Date().toISOString();
    const dir = path.dirname(this.storePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.store, null, 2) + '\n');
    fs.renameSync(tmpPath, this.storePath);
  }

  /**
   * The single in-process serialized mutator with optimistic `version` CAS.
   * JS is single-threaded and `fn` is synchronous, so a straight read → apply
   * → version++ → persist cannot interleave with another mutate() under the
   * single-process model; the CAS guards against a same-tick stale read by
   * re-reading the live record before commit. Returns the persisted snapshot.
   */
  private mutate(id: string, fn: (i: ApprenticeshipInstance) => ApprenticeshipInstance): ApprenticeshipInstance {
    const idx = this.store.instances.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error(`ApprenticeshipProgram.mutate: unknown instance id ${id}`);
    const current = this.store.instances[idx];
    const observedVersion = current.version ?? 0;
    const next = fn({ ...current });
    // CAS re-read: under single-process this is belt-and-braces.
    const latestIdx = this.store.instances.findIndex((i) => i.id === id);
    if (latestIdx === -1) throw new Error(`ApprenticeshipProgram.mutate: instance ${id} disappeared mid-apply`);
    if ((this.store.instances[latestIdx].version ?? 0) !== observedVersion) {
      throw new Error(`ApprenticeshipProgram.mutate: version drift on ${id} (CAS abort)`);
    }
    const committed: ApprenticeshipInstance = {
      ...next,
      // requiredArtifacts is immutable after create — restore from the live record.
      requiredArtifacts: current.requiredArtifacts,
      version: observedVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.store.instances[latestIdx] = committed;
    this.saveStore();
    return committed;
  }

  // ── Read ───────────────────────────────────────────────────────────

  list(): ApprenticeshipInstance[] {
    return [...this.store.instances];
  }

  get(id: string): ApprenticeshipInstance | null {
    return this.store.instances.find((i) => i.id === id) ?? null;
  }

  /** True when the on-disk store was present but unparseable (gates fail closed). */
  isCorrupt(): boolean {
    return this.corrupt;
  }

  // ── Create ─────────────────────────────────────────────────────────

  /**
   * Create an instance. Charset-clamps id/overseer/mentor/mentee/framework to
   * ^[a-z0-9-]+$, rejects a duplicate id, computes harvestFrom=mentor /
   * harvestTo=mentee. requiredArtifacts defaults to all-required.
   */
  createInstance(input: CreateInstanceInput): ApprenticeshipInstance {
    if (this.corrupt) {
      throw new Error('ApprenticeshipProgram: store is corrupt — refusing to create (fail closed)');
    }
    const overseer = input.overseer ?? '';
    const fields: Record<string, string> = {
      id: input.id,
      mentor: input.mentor,
      mentee: input.mentee,
      framework: input.framework,
    };
    // overseer is optional (apprenticeship has none); clamp only when present.
    if (overseer) fields.overseer = overseer;
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== 'string' || !CHARSET_RE.test(v)) {
        throw new Error(`ApprenticeshipProgram.createInstance: ${k}="${v}" must match ^[a-z0-9-]+$`);
      }
    }
    if (input.instanceType !== 'apprenticeship' && input.instanceType !== 'mentorship') {
      throw new Error(`ApprenticeshipProgram.createInstance: invalid instanceType "${input.instanceType}"`);
    }
    if (this.store.instances.some((i) => i.id === input.id)) {
      throw new Error(`ApprenticeshipProgram.createInstance: duplicate id "${input.id}"`);
    }

    const now = new Date().toISOString();
    const harvestFrom = input.mentor; // a harvest is named for the mentoring edge (§3.1)
    const harvestTo = input.mentee;
    // Record the canonical path for humans only — NEVER the resolution source.
    let harvestRef: string | null = null;
    try {
      harvestRef = safeArtifactPath(harvestFrom, harvestTo, input.instanceType);
    } catch {
      harvestRef = null;
    }

    const instance: ApprenticeshipInstance = {
      id: input.id,
      instanceType: input.instanceType,
      overseer,
      mentor: input.mentor,
      mentee: input.mentee,
      framework: input.framework,
      status: 'pending',
      ladderRung: 0,
      rungHistory: [{ rung: 0, at: now, evidenceRef: 'instance-created' }],
      priorInstanceId: input.priorInstanceId ?? null,
      requiredArtifacts: {
        retroHarvest: input.requiredArtifacts?.retroHarvest ?? true,
        ledgerEntries: input.requiredArtifacts?.ledgerEntries ?? true,
        detectorAudit: input.requiredArtifacts?.detectorAudit ?? true,
      },
      programNeeds: input.programNeeds ?? [],
      harvestFrom,
      harvestTo,
      harvestRef,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.instances.push(instance);
    this.saveStore();
    return instance;
  }

  // ── Gates (pure; truth re-derived from injected deps) ───────────────

  /**
   * The retro-gate (§3.3). priorInstanceId === null → the bootstrap seed (the
   * Echo→Codey artifact at its canonical path) must exist + validate. Else the
   * prior instance must be status:'complete' AND its canonical harvest must
   * exist + validate. partial-accepted passes ONLY with acceptance metadata
   * (acceptedBy + acceptedAt); complete always passes.
   *
   * The path is recomputed via safeArtifactPath(harvestFrom, harvestTo,
   * instanceType) — never a stored harvestRef.
   */
  evaluateStartGate(instance: ApprenticeshipInstance): StartGateVerdict {
    if (this.corrupt) {
      return { allow: false, reason: 'instance store is corrupt — fail closed' };
    }

    let priorInstance: ApprenticeshipInstance | null = null;
    let from: string;
    let to: string;
    let type: InstanceType;
    let priorHarvestExists: boolean;

    if (instance.priorInstanceId === null) {
      // Bootstrap: validate THIS instance's own canonical harvest (the seed).
      from = instance.harvestFrom;
      to = instance.harvestTo;
      type = instance.instanceType;
      priorHarvestExists = false;
    } else {
      priorInstance = this.get(instance.priorInstanceId);
      if (!priorInstance) {
        return { allow: false, reason: `prior instance "${instance.priorInstanceId}" not found` };
      }
      if (priorInstance.status !== 'complete') {
        return {
          allow: false,
          reason: `prior instance "${priorInstance.id}" is "${priorInstance.status}", must be "complete"`,
        };
      }
      from = priorInstance.harvestFrom;
      to = priorInstance.harvestTo;
      type = priorInstance.instanceType;
      priorHarvestExists = true;
    }

    // Recompute the confined path (NEVER the stored harvestRef).
    let relPath: string;
    try {
      relPath = safeArtifactPath(from, to, type);
    } catch (e) {
      return { allow: false, reason: `cannot resolve canonical harvest path: ${(e as Error).message}` };
    }

    const text = this.deps.readHarvest(relPath);
    if (text === null) {
      return { allow: false, reason: `retro-harvest missing at canonical path ${relPath}` };
    }

    const result = this.deps.validate(text, { priorHarvestExists });
    if (!result.valid) {
      return { allow: false, reason: `retro-harvest at ${relPath} is invalid: ${result.errors.join('; ')}` };
    }

    // partial-accepted requires acceptance metadata (acceptedBy + acceptedAt).
    let fm: Record<string, unknown>;
    try {
      fm = parseArtifact(text).frontmatter;
    } catch (e) {
      return { allow: false, reason: `cannot parse harvest frontmatter: ${(e as Error).message}` };
    }
    const completeness = fm.completeness;
    if (completeness === 'partial-accepted') {
      const acceptedBy = fm.acceptedBy;
      const acceptedAt = fm.acceptedAt;
      if (!acceptedBy || !acceptedAt) {
        return {
          allow: false,
          reason: `partial harvest at ${relPath} awaiting acceptance (acceptedBy + acceptedAt required)`,
        };
      }
    }

    return {
      allow: true,
      reason:
        instance.priorInstanceId === null
          ? `bootstrap seed ${relPath} present + valid (completeness=${String(completeness)})`
          : `prior instance "${priorInstance!.id}" complete; harvest ${relPath} present + valid`,
    };
  }

  /**
   * The doc-as-required-artifact gate (§3.3). Each requiredArtifacts flag the
   * instance DECLARES required is checked against LIVE state via injected deps —
   * harvestExists+validates, an instance-scoped ledger count ≥1, detectorAudit
   * present. A stored requiredArtifacts:true is NEVER treated as evidence of
   * presence.
   */
  evaluateCompletionGate(instance: ApprenticeshipInstance): CompletionGateVerdict {
    if (this.corrupt) {
      return { allow: false, reason: 'instance store is corrupt — fail closed', missing: ['store-corrupt'] };
    }

    const missing: string[] = [];

    if (instance.requiredArtifacts.retroHarvest) {
      // This instance's OWN harvest (mentor→mentee edge), at its canonical path.
      let relPath: string | null = null;
      try {
        relPath = safeArtifactPath(instance.harvestFrom, instance.harvestTo, instance.instanceType);
      } catch {
        relPath = null;
      }
      const text = relPath ? this.deps.readHarvest(relPath) : null;
      if (text === null) {
        missing.push('retroHarvest:absent');
      } else {
        const result = this.deps.validate(text, { priorHarvestExists: instance.priorInstanceId !== null });
        if (!result.valid) missing.push('retroHarvest:invalid');
      }
    }

    if (instance.requiredArtifacts.ledgerEntries) {
      const n = this.deps.countInstanceLedgerEntries(instance);
      if (!(n >= 1)) missing.push('ledgerEntries:none');
    }

    if (instance.requiredArtifacts.detectorAudit) {
      if (!this.deps.detectorAuditExists(instance)) missing.push('detectorAudit:absent');
    }

    if (missing.length > 0) {
      return {
        allow: false,
        reason: `completion blocked — missing live artifacts: ${missing.join(', ')}`,
        missing,
      };
    }
    return { allow: true, reason: 'all declared-required artifacts verified present from live state', missing: [] };
  }

  // ── Status transitions (the gates are not advisory) ─────────────────

  /**
   * The ONLY way status changes (§3.4). pending→active runs evaluateStartGate
   * and refuses on !allow; active→complete runs evaluateCompletionGate;
   * active→blocked / blocked→active (re-gate) allowed; pending→abandoned is
   * the retained disposal path for a mis-created never-started instance;
   * complete and abandoned are terminal.
   * Any transition not in the table is rejected with a reason. Every gate
   * verdict is appended to the decision audit.
   */
  transition(id: string, to: InstanceStatus): { ok: boolean; reason: string; instance?: ApprenticeshipInstance } {
    if (this.corrupt) {
      return { ok: false, reason: 'instance store is corrupt — fail closed' };
    }
    const instance = this.get(id);
    if (!instance) return { ok: false, reason: `instance "${id}" not found` };

    const allowed = TRANSITIONS[instance.status] ?? [];
    if (!allowed.includes(to)) {
      return {
        ok: false,
        reason: `illegal transition ${instance.status}→${to} (allowed: ${allowed.join(', ') || 'none — terminal'})`,
      };
    }

    // Gate the guarded transitions.
    if (instance.status === 'pending' && to === 'active') {
      const verdict = this.evaluateStartGate(instance);
      this.recordDecision({ gate: 'start', instanceId: id, allow: verdict.allow, reason: verdict.reason });
      if (!verdict.allow) return { ok: false, reason: `start gate refused: ${verdict.reason}` };
    }
    if (instance.status === 'blocked' && to === 'active') {
      // Re-gate on resume from blocked.
      const verdict = this.evaluateStartGate(instance);
      this.recordDecision({ gate: 'start', instanceId: id, allow: verdict.allow, reason: verdict.reason });
      if (!verdict.allow) return { ok: false, reason: `start gate refused (re-gate): ${verdict.reason}` };
    }
    if (instance.status === 'active' && to === 'complete') {
      const verdict = this.evaluateCompletionGate(instance);
      this.recordDecision({
        gate: 'completion',
        instanceId: id,
        allow: verdict.allow,
        reason: verdict.reason,
        missing: verdict.missing,
      });
      if (!verdict.allow) return { ok: false, reason: `completion gate refused: ${verdict.reason}` };
    }

    const updated = this.mutate(id, (i) => ({ ...i, status: to }));
    return { ok: true, reason: `transitioned ${instance.status}→${to}`, instance: updated };
  }

  /** Evidence-gated, adjacent independence-ladder transition (§5.1). */
  transitionRung(
    id: string,
    to: number,
    evidenceRef: string,
  ): { ok: boolean; reason: string; instance?: ApprenticeshipInstance } {
    const instance = this.get(id);
    const refuse = (reason: string) => {
      this.recordDecision({
        gate: 'ladder', instanceId: id, allow: false, reason,
        fromRung: instance?.ladderRung, toRung: to, evidenceRef,
      });
      return { ok: false as const, reason };
    };
    if (this.corrupt) return refuse('instance store is corrupt — fail closed');
    if (!instance) return refuse(`instance "${id}" not found`);
    if (!Number.isInteger(to) || to < 0 || to > 5) return refuse('to must be an integer from 0 through 5');
    const evidence = typeof evidenceRef === 'string' ? evidenceRef.trim() : '';
    if (!evidence || evidence.length > 2_000) return refuse('evidenceRef is required and must be at most 2000 characters');
    if (Math.abs(to - instance.ladderRung) !== 1) {
      return refuse(`ladder transitions must be adjacent (${instance.ladderRung}→${to} refused)`);
    }

    const at = new Date().toISOString();
    const rung = to as ApprenticeshipInstance['ladderRung'];
    const updated = this.mutate(id, (current) => ({
      ...current,
      ladderRung: rung,
      rungHistory: [...(current.rungHistory ?? []), { rung, at, evidenceRef: evidence }],
    }));
    this.recordDecision({
      gate: 'ladder', instanceId: id, allow: true,
      reason: `transitioned R${instance.ladderRung}→R${rung}`,
      fromRung: instance.ladderRung, toRung: rung, evidenceRef: evidence,
    });
    return { ok: true, reason: `transitioned R${instance.ladderRung}→R${rung}`, instance: updated };
  }

  // ── Decision audit (§3.6) ───────────────────────────────────────────

  private recordDecision(entry: {
    gate: 'start' | 'completion' | 'ladder';
    instanceId: string;
    allow: boolean;
    reason: string;
    missing?: string[];
    fromRung?: number;
    toRung?: number;
    evidenceRef?: string;
  }): void {
    try {
      const dir = path.dirname(this.decisionLogPath);
      fs.mkdirSync(dir, { recursive: true });
      const line =
        JSON.stringify({
          ts: new Date().toISOString(),
          gate: entry.gate,
          instanceId: entry.instanceId,
          allow: entry.allow,
          reason: entry.reason,
          ...(entry.missing && entry.missing.length ? { missing: entry.missing } : {}),
          ...(entry.fromRung !== undefined ? { fromRung: entry.fromRung } : {}),
          ...(entry.toRung !== undefined ? { toRung: entry.toRung } : {}),
          ...(entry.evidenceRef ? { evidenceRef: entry.evidenceRef } : {}),
        }) + '\n';
      fs.appendFileSync(this.decisionLogPath, line);
    } catch {
      // @silent-fallback-ok — the audit is observability; a write failure must
      // not block the (already-decided) transition.
    }
  }
}
