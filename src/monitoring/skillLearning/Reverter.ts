/**
 * Reverter — the §3.7 bounded auto-revert (docs/specs/skill-learning-sentinel.md §3.7 "Bounded auto-revert";
 * integration map brief 3A).
 *
 * Trigger, per learned skill whose live version is N+1 and whose previous DIFFERENT body is N: N+1 has
 * ≥ 3 corroborated runs (measured label + transcript-corroborated use of that body), ≥ 2 of them `corrected`,
 * and a corrected rate STRICTLY above N's (an unmeasured N reads as rate 0 and is recorded `prevRate: null`).
 * Counts are per BODY (the rendering stamp = the body hash), so a pending create and its confirm share them.
 *
 * Action: version N+2 = the document of N (kept by the VersionStore's bodies), version bumped, state `active`,
 * through `CommitProtocol.write('revert')` — a deterministic version write: the structural lint and the
 * semantic flags run (references are grounded in N's own body, which was reviewed when N was written); NO LLM
 * review. The revert row is annotated `revertOf` (N+1's txId), `rejectedBodyHash` (hash of N+1's body) and
 * the `uncertainty` the trigger saw. A later patch whose body hash or cited-correction set matches a rejected
 * version is refused by the Reviewer; after a revert the key needs two agreeing corrected runs before any patch.
 *
 * A REFUSED revert (no body of N, lint, protocol) never leaves the harmful version live silently: N+1 is
 * rewritten `pending` through the protocol (`pendingReason: 'revert-refused'`, no further render) and a
 * `revert-refused` event row is appended to the ledger — the signal attention item 1 (3C) consumes. The
 * rendering of N+1 that is already on disk is NOT removed here (the retire path owns rendering archival); the
 * event names it.
 *
 * Breaker: `review.revertBreakerPer30d` reverts on one key inside 30 days ⇒ the reverted canonical is locked
 * `operator-owned` through `write('lock')` and a `revert-breaker` event row is appended (attention item 5).
 *
 * Self-action posture: registered as `skill-learning-revert` in src/testing/selfActionRegistry.ts — at most
 * `revertBreakerPer30d` reverts per key per 30 days (then the lock stops the loop); a refusal is decided once per
 * (name, on-disk fileHash) through the durable handled map.
 */
/* @self-action-controller: skill-learning-revert */

import crypto from 'node:crypto';
import { parseSkillDoc, type ExistingSkill } from './Drafter.js';
import { extractReferences, lintDraft, DRAFT_BODY_MAX_CHARS } from './Lint.js';
import { nextVersionOf, patchLearnedDocument, type DurableMap, type LearnedCanonical, type PendingSidecarInput, type VersionStoreForReview } from './Reviewer.js';
import { versionCounts, type EffectiveVersionRow, type VersionCounts, type VersionUncertainty } from './VersionStore.js';
import type { CommitProtocolLike, CommitResult, EventRow, LedgerReader, LedgerWriter, SkillLearningConfig, SkillLearningHealOutcome } from './types.js';

const LEARNED_STATE_KEY = 'instar-learned-state';
const LEARNED_LOCKED_KEY = 'instar-learned-locked';
const LEARNED_VERSION_KEY = 'instar-learned-version';
export const REVERT_WINDOW_MS = 30 * 86_400_000;
/** The §3.7 floor: corroborated runs on N+1 and corrected runs among them. */
export const REVERT_MIN_RUNS = 3;
export const REVERT_MIN_CORRECTED = 2;

export interface ReverterDeps {
  cfg: SkillLearningConfig;
  machineId: string;
  ledger: LedgerReader & LedgerWriter;
  versions: VersionStoreForReview;
  protocol: CommitProtocolLike;
  learnedCanonicals: () => LearnedCanonical[];
  existingSkills: () => ExistingSkill[];
  writePendingSidecar: (sidecar: PendingSidecarInput) => void;
  /** name → on-disk fileHash a refusal was decided for (one decision per body on this machine). */
  handled: DurableMap;
  /**
   * Late-bound (3B's Retirer): after a refused revert leaves N+1 `pending`, archive the renderings of N+1 that are
   * still on disk so the harmful body is not live. Absent ⇒ the renderings stay and the event names it.
   */
  archiveRenderings?: (name: string) => Promise<{ archived: unknown[]; blocked: unknown[]; left: string[] } | null | undefined> | { archived: unknown[]; blocked: unknown[]; left: string[] } | null | undefined;
  log: (row: Record<string, unknown>) => void;
  evidence: { record(kind: 'fired' | 'held' | 'error' | 'outcome', reason: string, context: Record<string, unknown>): void };
  now?: () => number;
  logger?: (message: string) => void;
}

export interface RevertDecision {
  name: string;
  trigger: boolean;
  current: { version: number; bodyHash: string; runs: number; corrected: number; rate: number | null };
  previous: { version: number; bodyHash: string; runs: number; corrected: number; rate: number | null } | null;
  reason: string;
}

export interface ReverterTickSummary {
  considered: number;
  reverted: number;
  refused: number;
  breakers: number;
  /** `mode: shadow`: reverts that were decided and logged `would-revert`, with no protocol write. */
  wouldRevert: number;
  /** Skills skipped because the body before the live one was itself rejected by an earlier revert (never revert to a rejected body). */
  skipped: number;
  decisions: RevertDecision[];
}

const EMPTY: VersionCounts = { uses: 0, accepted: 0, acceptedInferred: 0, corrected: 0, unknown: 0, weakPositive: 0, corroborated: 0, measuredCorroborated: 0, correctedCorroborated: 0, score: null };

/** The §3.7 trigger, pure: rate = correctedCorroborated / measuredCorroborated; an unmeasured N is rate 0 (recorded null). */
export function revertTrigger(current: VersionCounts, previous: VersionCounts): { trigger: boolean; curRate: number | null; prevRate: number | null; reason: string } {
  const curRate = current.measuredCorroborated > 0 ? current.correctedCorroborated / current.measuredCorroborated : null;
  const prevRate = previous.measuredCorroborated > 0 ? previous.correctedCorroborated / previous.measuredCorroborated : null;
  if (current.measuredCorroborated < REVERT_MIN_RUNS) return { trigger: false, curRate, prevRate, reason: `corroborated runs ${current.measuredCorroborated} < ${REVERT_MIN_RUNS}` };
  if (current.correctedCorroborated < REVERT_MIN_CORRECTED) return { trigger: false, curRate, prevRate, reason: `corrected runs ${current.correctedCorroborated} < ${REVERT_MIN_CORRECTED}` };
  if ((curRate ?? 0) <= (prevRate ?? 0)) return { trigger: false, curRate, prevRate, reason: `corrected rate ${curRate} not strictly above the previous version's ${prevRate ?? 0}` };
  return { trigger: true, curRate, prevRate, reason: `corrected rate ${curRate} > previous ${prevRate ?? 0} on ${current.measuredCorroborated} corroborated runs` };
}

export class Reverter {
  private readonly d: ReverterDeps;
  private readonly now: () => number;

  constructor(deps: ReverterDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** `dryRun` (`mode: shadow`): the same trigger and lint, but the write becomes a `would-revert` log row; no event, no lock. */
  async tick(opts: { dryRun?: boolean } = {}): Promise<ReverterTickSummary> {
    const dryRun = opts.dryRun === true;
    const s: ReverterTickSummary = { considered: 0, reverted: 0, refused: 0, breakers: 0, wouldRevert: 0, skipped: 0, decisions: [] };
    for (const c of this.d.learnedCanonicals()) {
      if (!c.key || c.locked || c.state !== 'active') continue;
      // A decision was recorded for this body (refusal, skip, breaker lock); a shadow `would:` mark is re-evaluated once on a live tick.
      const mark = this.d.handled.get(c.name);
      if (mark === c.fileHash || (dryRun && mark === `would:${c.fileHash}`)) continue;
      const live = this.d.versions.rows(c.name).filter((r) => !r.void && !r.superseded);
      const current = live.length ? live[live.length - 1] : null;
      if (!current || current.fileHash !== c.fileHash) continue;       // not on the chain: the versions phase / protocol own it
      const previous = [...live].reverse().find((r) => r.bodyHash !== current.bodyHash && r.op !== 'lock' && r.state !== 'operator-owned' && r.state !== 'retired' && r.state !== 'pending') ?? null;
      if (!previous) continue;
      // Never revert TO a body an earlier revert rejected (after N+2 = body(N), a decline of N must not bring N+1 back).
      if (this.d.versions.rejectedVersions(c.name).some((r) => r.bodyHash === previous.bodyHash)) {
        s.skipped++;
        this.d.handled.set(c.name, c.fileHash);
        this.d.log({ kind: 'revert-skipped', name: c.name, key: c.key, reason: 'rejected-body', currentVersion: current.version, previousVersion: previous.version, previousBodyHash: previous.bodyHash });
        this.d.evidence.record('held', 'revert-skipped: rejected-body', { name: c.name, key: c.key, currentVersion: current.version, previousVersion: previous.version });
        continue;
      }
      s.considered++;
      const counts = versionCounts(c.name, this.d.ledger.outcomesForKey(c.key));
      const cur = counts.get(current.bodyHash) ?? EMPTY;
      const prev = counts.get(previous.bodyHash) ?? EMPTY;
      const t = revertTrigger(cur, prev);
      s.decisions.push({
        name: c.name, trigger: t.trigger, reason: t.reason,
        current: { version: current.version, bodyHash: current.bodyHash, runs: cur.measuredCorroborated, corrected: cur.correctedCorroborated, rate: t.curRate },
        previous: { version: previous.version, bodyHash: previous.bodyHash, runs: prev.measuredCorroborated, corrected: prev.correctedCorroborated, rate: t.prevRate },
      });
      if (!t.trigger) continue;
      const uncertainty: VersionUncertainty = { nCorrected: cur.correctedCorroborated, nRuns: cur.measuredCorroborated, prevRate: t.prevRate };
      // Breaker read BEFORE reverting: a key already at the limit is locked again (a refused lock last time left it active), never reverted once more.
      const limit = Math.max(1, Math.floor(this.d.cfg.review.revertBreakerPer30d));
      const recent = this.d.versions.revertsSince(c.name, this.now() - REVERT_WINDOW_MS).length;
      if (recent >= limit) {
        if (dryRun) {
          this.d.handled.set(c.name, `would:${c.fileHash}`);
          s.wouldRevert++;
          this.d.log({ kind: 'would-revert', mode: 'shadow', name: c.name, key: c.key, breaker: true, reverts30d: recent, limit, rejectedVersion: current.version, restoredVersion: previous.version, uncertainty, reason: t.reason });
          continue;
        }
        this.d.handled.set(c.name, c.fileHash);
        await this.breaker(c, this.d.versions.expectedPrevHash(c.name) ?? c.fileHash, c.raw, recent, limit, 'relock');
        s.breakers++;
        continue;
      }
      const done = await this.revert(c, current, previous, uncertainty, t.reason, dryRun);
      if (done === 'reverted') s.reverted++;
      else if (done === 'breaker') { s.reverted++; s.breakers++; }
      else if (done === 'would') s.wouldRevert++;
      else s.refused++;
    }
    return s;
  }

  /**
   * Item 1's heal (SkillLearningHeals.revertFirst): the bounded revert of ONE skill whose live version is `version`,
   * run on the retirer's harm judgment rather than the §3.7 counts trigger. `healed` when the revert row lands;
   * `terminal` (notify now, no retry) when nothing can be reverted to, the version before is itself a rejected
   * body, the breaker is already tripped, or the canonical is not live under `.instar/skills` (a retired canonical
   * cannot pass the commit protocol). A refused revert is `healed: false` without `terminal` — the gate retries.
   */
  async revertOne(name: string, version: number): Promise<SkillLearningHealOutcome> {
    const c = this.d.learnedCanonicals().find((x) => x.name === name) ?? null;
    if (!c) return { healed: false, reason: 'canonical-not-live', detail: `no learned canonical "${name}" under .instar/skills (retired or absent): the protocol cannot revert it`, terminal: true };
    if (c.locked) return { healed: false, reason: 'locked', detail: 'operator-owned canonicals are never reverted', terminal: true };
    const live = this.d.versions.rows(name).filter((r) => !r.void && !r.superseded);
    const current = live.length ? live[live.length - 1] : null;
    if (!current) return { healed: false, reason: 'no-version-rows', terminal: true };
    if (current.op === 'revert' && current.revertOf) {
      const rejected = live.find((r) => r.txId === current.revertOf);
      if (rejected?.version === version) return { healed: true, detail: `already reverted: v${version} was rejected by v${current.version}` };
    }
    if (current.version !== version) return { healed: false, reason: 'version-mismatch', detail: `live version is v${current.version}, the heal names v${version}` };
    if (current.fileHash !== c.fileHash) return { healed: false, reason: 'chain-mismatch', detail: 'the on-disk canonical is not the chain\'s last row (the versions phase owns it)' };
    if (c.state !== 'active') return { healed: false, reason: `state:${c.state}`, detail: 'only an active canonical is reverted', terminal: c.state === 'retired' || c.state === 'operator-owned' };
    const previous = [...live].reverse().find((r) => r.bodyHash !== current.bodyHash && r.op !== 'lock' && r.state !== 'operator-owned' && r.state !== 'retired' && r.state !== 'pending') ?? null;
    if (!previous) return { healed: false, reason: 'no-earlier-version', detail: `v${version} is the only body this skill ever had`, terminal: true };
    if (this.d.versions.rejectedVersions(name).some((r) => r.bodyHash === previous.bodyHash)) {
      return { healed: false, reason: 'reverted-to-rejected', detail: `the body before v${version} (v${previous.version}) was itself rejected by an earlier revert`, terminal: true };
    }
    const limit = Math.max(1, Math.floor(this.d.cfg.review.revertBreakerPer30d));
    const recent = this.d.versions.revertsSince(name, this.now() - REVERT_WINDOW_MS).length;
    if (recent >= limit) return { healed: false, reason: 'revert-breaker', detail: `${recent} reverts in 30 days (limit ${limit}) — the key is locked, not reverted again`, terminal: true };
    const counts = versionCounts(name, this.d.ledger.outcomesForKey(c.key));
    const cur = counts.get(current.bodyHash) ?? EMPTY;
    const prev = counts.get(previous.bodyHash) ?? EMPTY;
    const t = revertTrigger(cur, prev);
    const uncertainty: VersionUncertainty = { nCorrected: cur.correctedCorroborated, nRuns: cur.measuredCorroborated, prevRate: t.prevRate };
    const done = await this.revert(c, current, previous, uncertainty, `heal (item 1, retired for harm): v${version} → body of v${previous.version}; counts ${t.reason}`, false);
    if (done === 'refused') return { healed: false, reason: 'revert-refused', detail: `the revert of v${version} was refused; v${version} is held pending (see the revert-refused event)` };
    return { healed: true, detail: done === 'breaker' ? `reverted to v${previous.version}'s body; the breaker then locked the key` : `reverted to v${previous.version}'s body` };
  }

  private async revert(c: LearnedCanonical, current: EffectiveVersionRow, previous: EffectiveVersionRow, uncertainty: VersionUncertainty, why: string, dryRun: boolean): Promise<'reverted' | 'breaker' | 'refused' | 'would'> {
    const { name, key } = c;
    // Shadow mode: every refusal and the write itself become a `would-revert` row (no hold, no event, no protocol call).
    const refuse = (reason: string, context: Record<string, unknown>): Promise<'refused' | 'would'> => dryRun ? Promise.resolve(this.wouldRevert(c, current, previous, uncertainty, why, { refused: reason, ...context })) : this.refuse(c, current, previous, uncertainty, reason, context);
    const prevRaw = this.d.versions.readBody(name, previous.fileHash);
    if (prevRaw === null) return refuse('no-body', { previousFileHash: previous.fileHash });
    const prevDoc = parseSkillDoc(prevRaw);
    if (!prevDoc) return refuse('unparseable-body', { previousFileHash: previous.fileHash });
    const rows = this.d.versions.rows(name);
    const newRaw = patchLearnedDocument(prevRaw, { metadata: { [LEARNED_VERSION_KEY]: String(nextVersionOf(rows)), [LEARNED_STATE_KEY]: 'active', [LEARNED_LOCKED_KEY]: 'false' } });
    const doc = newRaw ? parseSkillDoc(newRaw) : null;
    if (!newRaw || !doc) return refuse('unparseable-body', { previousFileHash: previous.fileHash });

    // Lint + semantic flags only (no LLM): N's references were grounded when N was reviewed, so N's own body grounds them.
    const existing = this.d.existingSkills();
    const lint = lintDraft(doc, {
      operatorMessages: [], toolTargets: extractReferences(prevDoc.body), argsExcerpts: [],
      existingSkillNames: existing.map((x) => x.name), handWrittenDescriptions: existing.filter((x) => !x.learned).map((x) => x.description),
      patchTarget: name, bodyMaxChars: DRAFT_BODY_MAX_CHARS,
    });
    if (!lint.ok) return refuse(`lint:${lint.refusals[0].rule}`, { rules: lint.refusals.map((r) => r.rule).join(','), detail: lint.refusals[0].detail.slice(0, 200) });
    const relaxation = lint.flags.find((f) => f.rule === 'policy-relaxation');
    if (relaxation) return refuse('policy-relaxation-uncleared', { line: relaxation.line.slice(0, 160) });
    if (dryRun) return this.wouldRevert(c, current, previous, uncertainty, why, { version: nextVersionOf(rows), restoredBodyHash: previous.bodyHash, flags: lint.flags.map((f) => f.rule) });

    let res: CommitResult;
    try {
      res = await this.d.protocol.write('revert', name, newRaw, {
        expectedPrevHash: this.d.versions.expectedPrevHash(name) ?? c.fileHash,
        reason: `bounded revert of v${current.version} (${current.bodyHash.slice(0, 12)}…) to the body of v${previous.version}: ${why}`,
      });
    } catch (err) {
      res = { ok: false, reason: 'invalid', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
    if (!res.ok) return this.refuse(c, current, previous, uncertainty, `commit:${res.reason}`, { detail: (res.detail ?? '').slice(0, 200) });
    this.d.versions.annotate(name, res.txId, { revertOf: current.txId, rejectedBodyHash: current.bodyHash, uncertainty });
    this.d.versions.storeBody(name, res.fileHash, newRaw);
    this.d.log({
      kind: 'revert', name, key, version: res.version, txId: res.txId, fileHash: res.fileHash, revertOf: current.txId, rejectedVersion: current.version, rejectedBodyHash: current.bodyHash,
      restoredVersion: previous.version, restoredBodyHash: previous.bodyHash, uncertainty, epoch: res.epoch, fence: res.fence, flags: lint.flags.map((f) => f.rule), reason: why,
    });
    this.d.evidence.record('fired', 'revert', { name, key, version: res.version, rejectedVersion: current.version, restoredVersion: previous.version, ...uncertainty });

    // Breaker: this many reverts on one key inside 30 days ⇒ lock + item 5.
    const limit = Math.max(1, Math.floor(this.d.cfg.review.revertBreakerPer30d));
    const recent = this.d.versions.revertsSince(name, this.now() - REVERT_WINDOW_MS);
    if (recent.length >= limit) {
      await this.breaker(c, res.fileHash, newRaw, recent.length, limit, 'after-revert');
      return 'breaker';
    }
    return 'reverted';
  }

  /** Shadow mode's record of a revert decision (trigger met, lint judged): the row the shadow trial measures. */
  private wouldRevert(c: LearnedCanonical, current: EffectiveVersionRow, previous: EffectiveVersionRow, uncertainty: VersionUncertainty, why: string, context: Record<string, unknown>): 'would' {
    this.d.handled.set(c.name, `would:${c.fileHash}`);
    this.d.log({ kind: 'would-revert', mode: 'shadow', name: c.name, key: c.key, rejectedVersion: current.version, rejectedBodyHash: current.bodyHash, restoredVersion: previous.version, uncertainty, reason: why, ...context });
    this.d.evidence.record('held', 'would-revert', { name: c.name, key: c.key, rejectedVersion: current.version, restoredVersion: previous.version, refused: typeof context.refused === 'string' ? context.refused : null });
    return 'would';
  }

  /**
   * The breaker lock: `write('lock')` over `baseRaw` fenced on `expectedPrevHash`, plus the `revert-breaker` event
   * (item 5). `after-revert` follows the revert that reached the limit; `relock` re-attempts a lock the previous
   * pass could not land (the key is at the limit and tripping again — it is locked, never reverted once more).
   */
  private async breaker(c: LearnedCanonical, expectedPrevHash: string, baseRaw: string, reverts30d: number, limit: number, when: 'after-revert' | 'relock'): Promise<void> {
    const { name, key } = c;
    const reason = `revert-breaker: ${reverts30d} reverts on this key in 30 days (limit ${limit})${when === 'relock' ? '; the lock is re-attempted instead of another revert' : ''}`;
    const lockedRaw = patchLearnedDocument(baseRaw, { metadata: { [LEARNED_STATE_KEY]: 'operator-owned', [LEARNED_LOCKED_KEY]: 'true' } });
    let res: CommitResult;
    if (!lockedRaw) res = { ok: false, reason: 'invalid', detail: 'unparseable reverted document' };
    else {
      try { res = await this.d.protocol.write('lock', name, lockedRaw, { expectedPrevHash, reason }); } catch (err) {
        res = { ok: false, reason: 'invalid', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
      }
    }
    const row: EventRow = {
      kind: 'event', eventId: crypto.randomUUID(), event: 'revert-breaker', runId: '', procedureKey: key, skill: name,
      reason: `${reason}; ${res.ok ? `locked operator-owned (v${res.version})` : `lock refused: ${res.reason}`}`, at: new Date(this.now()).toISOString(), machineId: this.d.machineId,
    };
    this.appendEvent(row);
    this.d.log({ kind: 'revert-breaker', name, key, when, reverts30d, limit, locked: res.ok, ...(res.ok ? { version: res.version, txId: res.txId } : { lockRefused: res.reason, detail: (res.detail ?? '').slice(0, 200) }) });
    this.d.evidence.record('fired', 'revert-breaker', { name, key, when, reverts30d, limit, locked: res.ok });
  }

  /** A refused revert: N+1 is held `pending` (unrendered from here on), the `revert-refused` event is appended for item 1. */
  private async refuse(c: LearnedCanonical, current: EffectiveVersionRow, previous: EffectiveVersionRow, uncertainty: VersionUncertainty, reason: string, context: Record<string, unknown>): Promise<'refused'> {
    const { name, key } = c;
    this.d.handled.set(name, c.fileHash);
    const pendingRaw = patchLearnedDocument(c.raw, { metadata: { [LEARNED_STATE_KEY]: 'pending' } });
    let res: CommitResult;
    if (!pendingRaw) res = { ok: false, reason: 'invalid', detail: 'unparseable canonical' };
    else {
      try {
        res = await this.d.protocol.write('revert', name, pendingRaw, { expectedPrevHash: this.d.versions.expectedPrevHash(name) ?? c.fileHash, reason: `revert-refused: ${reason} — v${current.version} held pending` });
      } catch (err) {
        res = { ok: false, reason: 'invalid', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
      }
    }
    const latestCorrected = [...this.d.ledger.outcomesForKey(key)].filter((o) => (o.label === 'corrected' || o.label === 'redo') && o.skillUsed?.skill === name).sort((a, b) => b.at.localeCompare(a.at))[0];
    if (res.ok) {
      this.d.versions.annotate(name, res.txId, { revertOf: current.txId, rejectedBodyHash: current.bodyHash, uncertainty });
      this.d.writePendingSidecar({
        name, key, description: c.doc.description, paraphrases: [], pendingReason: 'revert-refused', createdAt: new Date(this.now()).toISOString(),
        evidence: { sources: [], runIds: latestCorrected ? [latestCorrected.runId] : [] }, disagreement: null, arbiterOnly: false,
      });
    }
    const held = res.ok ? `v${current.version} held pending (v${res.version})` : `hold refused: ${res.reason}`;
    // The renderings of N+1 are still on disk: ask the retirer (late-bound) to archive them; say what is left either way.
    let renderings: { archived: number; left: string[] } | { unavailable: true } | { error: string } = { unavailable: true };
    if (res.ok && this.d.archiveRenderings) {
      try {
        const r = await this.d.archiveRenderings(name);
        renderings = r ? { archived: r.archived.length, left: r.left } : { unavailable: true };
      } catch (err) { // @silent-fallback-ok — the archive failure is named in the event + log row below (`renderings: {error}`); the harmful rendering being left live is what the attention item reports
        renderings = { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
      }
    }
    const renderingNote = 'left' in renderings
      ? (renderings.left.length ? `renderings of v${current.version} still live in ${renderings.left.join(',')}` : `renderings of v${current.version} archived (${renderings.archived})`)
      : 'error' in renderings ? `rendering archive failed: ${renderings.error}` : `renderings of v${current.version} stay until archived`;
    const row: EventRow = {
      kind: 'event', eventId: crypto.randomUUID(), event: 'revert-refused', runId: latestCorrected?.runId ?? '', procedureKey: key, skill: name,
      reason: `${reason}: revert of v${current.version} to v${previous.version} refused; ${held}; ${renderingNote}`, at: new Date(this.now()).toISOString(), machineId: this.d.machineId,
    };
    this.appendEvent(row);
    this.d.log({ kind: 'revert-refused', name, key, reason, rejectedVersion: current.version, restoredVersion: previous.version, uncertainty, held: res.ok, renderings, ...(res.ok ? { version: res.version, txId: res.txId } : { holdRefused: res.reason, holdDetail: (res.detail ?? '').slice(0, 200) }), ...context });
    this.d.evidence.record('held', `revert-refused: ${reason}`, { name, key, rejectedVersion: current.version, held: res.ok });
    return 'refused';
  }

  private appendEvent(row: EventRow): void {
    try { this.d.ledger.append(row); } catch (err) {
      // Not silent: the log row below names the lost signal; the attention module reads the log too.
      this.d.logger?.(`[SkillLearning/Reverter] event append failed (${row.event} for ${row.skill}): ${err instanceof Error ? err.message : String(err)}`);
      this.d.log({ kind: 'event-append-failed', event: row.event, name: row.skill, key: row.procedureKey, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    }
  }
}
