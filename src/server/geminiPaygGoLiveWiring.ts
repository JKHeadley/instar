/**
 * geminiPaygGoLiveWiring — the go-live, release and reduce-only routes of the Gemini
 * pay-per-use lane (docs/specs/gemini-payg-metered-lane.md §4, §5 notices, §7, §8, §9).
 *
 * AgentServer builds this ONCE on every machine, after the lane (`geminiPaygWiring`).
 * Every read is a late-bound closure, so nothing captures money state at boot.
 *
 *   port       — the enable surface's `gemini-payg-setup` contract: render from the
 *                persisted proposal with every precondition re-run; write the intent;
 *                apply hot; archive the handoff.
 *   recorder   — the release gate (the only path to `live`), serving the local route
 *                and the holder side of `release-proof-forward`.
 *   notices    — the lane's one voice to the spend-alert path.
 *   router     — the Bearer routes:
 *                  POST /routing-spend/key-handoff/mint-start   (loopback; money may be off)
 *                  POST /routing-spend/key-handoff              (loopback; money may be off)
 *                  POST /routing-spend/gemini-payg/proposal     (agent-proposed values)
 *                  GET  /routing-spend/gemini-payg/proposal
 *                  GET  /routing-spend/gemini-payg/release      (release checks, read-only)
 *                  POST /routing-spend/release-proof            (forwards from a non-holder)
 *                  POST /routing-spend/caps/lower               (≤ current only)
 *                  POST /routing-spend/callers/disable
 *                  POST /routing-spend/share/lower
 *                  POST /routing-spend/reconciliation           (browser-read, reporting only)
 */

import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { isLoopbackPeer } from '../core/desktopTransport.js';
import { hasForwardingHeaders } from './mobileBrowserDevices.js';
import { sessionOf } from './geminiPaygRoutes.js';
import {
  GeminiPaygGoLiveFiles,
  GEMINI_PAYG_DOOR,
  GEMINI_PAYG_KEY_REF_NAME,
  applyPendingGeminiPaygIntent,
  buildGeminiPaygProposal,
  currentDesignationEpoch,
  enableReconcileJobManifest,
  evaluateGeminiPaygRenderPreconditions,
  renderGeminiPaygPlanText,
  validateKeyHandoffBody,
  type ApplyOutcome,
  type GeminiPaygKeyHandoff,
  type ProposalOverrides,
} from '../core/geminiPaygGoLive.js';
import { GeminiPaygReleaseRecorder, type LiveTestRef } from '../core/geminiPaygReleaseRecorder.js';
import { GeminiPaygReconciliationStore } from '../core/geminiPaygReconciliation.js';
import { GeminiPaygNotices, type WorkCardRequest } from '../core/geminiPaygNotices.js';
import { MoneyLayerRefusal, type GeminiPaygSetupPort } from '../core/MoneyLayerEnableSurface.js';
import { RoutingSpendCapsStore, type CapsStoreFile } from '../core/RoutingSpendCapsStore.js';
import type { MeteredSpendLedger } from '../core/MeteredSpendLedger.js';
import { nextPeriodBoundaryMs, periodEpochs } from '../core/MeteredSpendLedger.js';
import { LEASE_LIVENESS_WINDOW_MS, type MoneyGateRefusal } from '../core/MeteredSpendGate.js';
import type { RoutingPriceAuthority } from '../core/routingPriceAuthority.js';
import type { MoneyLayerAuditLog } from '../core/MoneyLayerAuditLog.js';
import { GEMINI_API_MODELS } from '../providers/metered/gemini-api/geminiApiModels.js';
import type { GeminiPaygLane } from './geminiPaygWiring.js';
import type { StopAction } from './meteredLaneRuntime.js';

export interface GeminiPaygGoLiveDeps {
  stateDir: string;
  selfMachineId: string;
  selfMachineName: string | null;
  lane: GeminiPaygLane;
  /** The money layer's caps store (null while money is off). */
  capsStore: () => RoutingSpendCapsStore | null;
  ledger: () => MeteredSpendLedger | null;
  prices: () => RoutingPriceAuthority | null;
  servingReady: () => boolean;
  moneyAudit: () => MoneyLayerAuditLog | null;
  /** `failoverTimeoutMinutes` in ms. */
  failoverThresholdMs: () => number;
  /** True on an agent with more than one registered machine. */
  multiMachine: () => boolean;
  isLiveSession: (name: string) => boolean;
  /** Deliver one notice to the spend-alert voice. */
  deliverNotice: (n: { kind: string; dedupeKey: string; text: string; urgent: boolean }) => Promise<boolean>;
  openCard?: (c: WorkCardRequest) => boolean;
  spendTabLink?: () => string | null;
  verifyLiveTest?: ((ref: LiveTestRef) => { ok: boolean; reason?: string }) | null;
  now?: () => number;
}

export interface GeminiPaygGoLive {
  files: GeminiPaygGoLiveFiles;
  port: GeminiPaygSetupPort;
  recorder: GeminiPaygReleaseRecorder;
  reconciliation: GeminiPaygReconciliationStore;
  notices: GeminiPaygNotices;
  router: Router;
  /** Apply a pending intent to the given caps store (boot, or hot). Never throws. */
  applyPending: (caps: RoutingSpendCapsStore) => ApplyOutcome;
  /** The holder side of `release-proof-forward`. */
  releaseProofForwarded: (originMachine: string, payload: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  /** Render the setup plan here for a peer (the mesh verb's handler). Set by the server once the surface exists. */
  setRenderer: (fn: (() => Promise<unknown>) | null) => void;
  renderForPeer: (requestedBy: string) => Promise<unknown>;
  /** The §7 detail for the caps view (holder figures), or null when nothing is armed here. */
  capsDetail: () => GeminiPaygCapsDetail | null;
  /** A gate refusal on the reserve path. */
  onRefusal: (err: MoneyGateRefusal) => void;
  /** The 100%-of-month check (run on a tick). */
  checkMonth: () => Promise<void>;
  /** Route a lane notice from the wiring (designation conflict, plain-config key). */
  laneNotify: (kind: 'designation-conflict' | 'key-in-plain-config' | 'stop-action', text: string, meta?: { epoch?: number }) => void;
}

export interface GeminiPaygCapsDetail {
  keyRef: string;
  door: string;
  designatedMachineId: string | null;
  releaseState: 'armed-pending-proof' | 'live' | 'not-armed';
  periodTimeZone: string;
  month: { monthEpoch: string; settledUsd: number; committedUsd: number; capUsd: number | null; resetsAt: string; pct: number };
  day: { dayEpoch: string; committedUsd: number; guardUsd: number | null; resetsAt: string };
  outstandingReserveUsd: number;
  provisionalMonthUsd: number;
  perCallCeilingUsd: number | null;
  provisionalCeilingUsd: number | null;
  e2: { monthUsd: number; shareCapUsd: number | null; sharePct: number | null; dayUsd: number; dayCapUsd: number | null };
  callers: string[];
  e3Components: string[];
  e4: 'off';
  frozen: boolean;
  byCaller: Array<{ caller: string; committedUsd: number; calls: number }>;
  /** 50% / 80% are shown here and on the Spend tab, never pushed (Rule 87). */
  thresholds: { reached50: boolean; reached80: boolean; reached100: boolean };
  source: 'holder';
}

const MODELS_CHEAPEST_FIRST = Object.values(GEMINI_API_MODELS).sort((a, b) => a.cheapestRank - b.cheapestRank).map((m) => m.id);

function loopbackOnly(req: Request, res: Response): boolean {
  if (!isLoopbackPeer(req.socket.remoteAddress) || hasForwardingHeaders(req.headers as Record<string, unknown>)) {
    res.status(403).json({ error: 'forbidden', reason: 'not-local', message: 'This route is accepted only from this machine.' });
    return false;
  }
  return true;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function buildGeminiPaygGoLive(d: GeminiPaygGoLiveDeps): GeminiPaygGoLive {
  const now = d.now ?? (() => Date.now());
  const files = new GeminiPaygGoLiveFiles(d.stateDir, now);
  const reconciliation = new GeminiPaygReconciliationStore(d.stateDir, now);
  const runtime = d.lane.runtime;

  const notices = new GeminiPaygNotices({
    stateDir: d.stateDir,
    deliver: (n) => d.deliverNotice(n),
    ...(d.openCard ? { openCard: d.openCard } : {}),
    ...(d.spendTabLink ? { spendTabLink: d.spendTabLink } : {}),
    now,
  });

  /** Caps read that works while money is off (pre-gate): a read-only store over the same file. */
  const readCaps = (): CapsStoreFile | null => {
    try {
      return (d.capsStore() ?? new RoutingSpendCapsStore({ stateDir: d.stateDir })).read();
    } catch {
      return null; // @silent-fallback-ok — an unreadable store is reported by the version sentinel (-1) and refuses commit
    }
  };
  const capsVersion = (): number => {
    try { return (d.capsStore() ?? new RoutingSpendCapsStore({ stateDir: d.stateDir })).version(); } catch { return -1; } // @silent-fallback-ok — -1 never matches a pinned version
  };
  const modelVerified = (modelId: string): boolean => {
    try { return d.prices()?.canonicalPointAt(GEMINI_PAYG_DOOR, modelId, now())?.verified === true; } catch { return false; } // @silent-fallback-ok — unknown ⇒ unverified (release check (d) unmet)
  };
  const commitAuditHas = (intentHash: string): boolean => {
    try {
      const rows = d.moneyAudit()?.readAll() ?? [];
      return rows.some((r) => r.type === 'gemini-payg-setup-committed' && (r.detail as { intentHash?: unknown } | undefined)?.intentHash === intentHash);
    } catch { return false; } // @silent-fallback-ok — an unreadable log cannot vouch for the commit; the apply fails closed
  };

  const applyPending = (caps: RoutingSpendCapsStore): ApplyOutcome => {
    const out = applyPendingGeminiPaygIntent({
      files,
      capsStore: caps,
      selfMachineId: d.selfMachineId,
      commitAuditHas,
      notify: (text) => { void notices.laneNotice(`gemini-payg-apply-failed:${files.readIntent()?.hash ?? 'unreadable'}`, text).catch(() => undefined); },
      enableReconcileJob: () => { enableReconcileJobManifest(d.stateDir); },
    });
    try {
      if (out.kind === 'applied' || out.kind === 'failed') {
        d.moneyAudit()?.auditOnly().append('gemini-payg-intent-applied', 'system', { outcome: out.kind, intentHash: out.intentHash, ...(out.kind === 'failed' ? { reason: out.reason } : {}) });
      }
    } catch (err) {
      console.error(`[instar] gemini-payg: the apply audit row could not be written: ${String(err)}`);
    }
    return out;
  };

  const conflictingDesignation = (): string | null => {
    const heard = runtime.heardDesignation();
    if (heard && heard.machineId !== d.selfMachineId) return `machine ${heard.machineId} is already announcing itself as the Gemini spender (designation ${heard.designationEpoch})`;
    const f = readCaps();
    const g = f?.goLive?.[GEMINI_PAYG_DOOR];
    if (g?.enabled && g.designatedMachineId !== d.selfMachineId) return `this machine's own record names ${g.designatedMachineId} as the spender`;
    return null;
  };

  const port: GeminiPaygSetupPort = {
    async prepareRender(expectedProposalHash) {
      const proposal = files.readProposal();
      if (!proposal) throw new MoneyLayerRefusal(409, 'no-proposal', 'there is no Gemini go-live proposal on this machine yet — the agent proposes it on the machine that will spend');
      if (expectedProposalHash && expectedProposalHash !== proposal.hash) throw new MoneyLayerRefusal(409, 'proposal-changed', 'the proposal changed; a new card is needed');
      if (proposal.setup.designatedMachineId !== d.selfMachineId) {
        throw new MoneyLayerRefusal(409, 'wrong-machine', `this plan renders only on the machine that will spend: ${proposal.setup.designatedMachineName ?? proposal.setup.designatedMachineId} (${proposal.setup.designatedMachineId})`, { designatedMachineId: proposal.setup.designatedMachineId });
      }
      if (capsVersion() < 0) {
        throw new MoneyLayerRefusal(409, 'precondition-unmet', 'the go-live plan cannot be shown yet: caps-store-unreadable: the spending record on this machine cannot be read', { blockers: ['caps-store-unreadable'] });
      }
      const pre = await evaluateGeminiPaygRenderPreconditions({
        files,
        selfMachineId: d.selfMachineId,
        storedFingerprint: () => d.lane.keyReader.storedFingerprint(),
        peerSecretNames: () => runtime.peerSecretNames(),
        conflictingDesignation,
        scanTranscripts: (paths) => d.lane.keyReader.scanForStoredKey(paths),
        failoverThresholdMs: d.failoverThresholdMs,
      }, proposal);
      if (!pre.ok) {
        throw new MoneyLayerRefusal(409, pre.awaitingKey ? 'awaiting-key' : 'precondition-unmet', `the go-live plan cannot be shown yet: ${pre.blockers.join('; ')}`, { blockers: pre.blockers });
      }
      return { hash: proposal.hash, text: renderGeminiPaygPlanText(proposal.setup, { modelVerified }, proposal.hash), capsVersion: capsVersion(), designatedMachineId: proposal.setup.designatedMachineId };
    },
    proposalHash: () => files.readProposal()?.hash ?? null,
    // An unreadable store never pins: -1 at commit refuses (never `-1 === -1`).
    capsVersion: () => { const v = capsVersion(); return v < 0 ? Number.NaN : v; },
    writeIntent(hash) {
      const p = files.readProposal();
      if (!p || p.hash !== hash) throw new MoneyLayerRefusal(409, 'proposal-changed', 'the proposal changed; a new card is needed');
      files.writeIntent(p.setup, hash);
    },
    async applyHot() {
      const caps = d.capsStore();
      if (!caps) return { applied: false, reason: 'the caps store is not constructed' };
      const out = applyPending(caps);
      return out.kind === 'applied' || out.kind === 'already-applied' ? { applied: true } : { applied: false, reason: out.kind === 'failed' ? out.reason : 'no intent' };
    },
    archiveHandoff(reason) { files.archiveHandoff(reason); },
  };

  const recorder = new GeminiPaygReleaseRecorder({
    stateDir: d.stateDir,
    door: GEMINI_PAYG_DOOR,
    selfMachineId: d.selfMachineId,
    capsStore: d.capsStore,
    provider: () => {
      const p = d.lane.provider();
      return p ? { call: async (req) => { const r = await p.call(req); return { reserveId: r.reserveId, costUsd: r.costUsd, modelId: r.modelId }; } } : null;
    },
    ledgerLookup: (callId) => d.ledger()?.lookupCall(callId) ?? null,
    modelsCheapestFirst: () => MODELS_CHEAPEST_FIRST,
    modelVerified,
    reconciliation: () => reconciliation,
    multiMachine: d.multiMachine,
    verifyLiveTest: d.verifyLiveTest ?? null,
    now,
  });

  const releaseProofForwarded = async (originMachine: string, payload: Record<string, unknown>) => {
    if (!runtime.isDesignatedHere()) return { status: 503, body: { status: 'unavailable', reason: 'no-cap-slice' } };
    const lt = payload.liveTestArtifact as LiveTestRef | undefined;
    if (lt) { try { recorder.recordLiveTestRef(lt); } catch { /* @silent-fallback-ok: (b) stays unmet and is named by the evaluation */ } }
    const r = await recorder.runProof({ forwardedFrom: originMachine === d.selfMachineId ? null : originMachine });
    try { d.moneyAudit()?.auditOnly().append('gemini-payg-release', `peer:${originMachine}`, { releaseState: r.evaluation.releaseState, blocker: r.evaluation.blocker, attempt: r.attempt?.state ?? null }); } catch { /* @silent-fallback-ok: audit-only */ }
    return { status: 200, body: { status: 'ok', ...r } };
  };

  let renderer: (() => Promise<unknown>) | null = null;
  const renderForPeer = async (requestedBy: string) => {
    if (!renderer) throw new MoneyLayerRefusal(503, 'render-unavailable', 'the money-layer enable surface is not available on this machine');
    void requestedBy;
    return renderer();
  };

  const capsDetail = (): GeminiPaygCapsDetail | null => {
    const f = readCaps();
    const caps = f?.caps?.[GEMINI_PAYG_KEY_REF_NAME];
    const g = f?.goLive?.[GEMINI_PAYG_DOOR];
    const p = f?.doorPolicy?.[GEMINI_PAYG_DOOR];
    if (!f || (!caps && !g)) return null;
    const zone = caps?.periodTimeZone ?? 'UTC';
    const ms = now();
    const { dayEpoch, monthEpoch } = periodEpochs(ms, zone);
    const ledger = d.ledger();
    const t = ledger?.committed(GEMINI_PAYG_KEY_REF_NAME);
    const br = ledger?.monthBreakdown(GEMINI_PAYG_KEY_REF_NAME);
    const committedMonth = t?.committedMonthUsd ?? 0;
    const capUsd = caps?.monthlyCapUsd ?? null;
    const pct = capUsd && capUsd > 0 ? committedMonth / capUsd : 0;
    return {
      keyRef: GEMINI_PAYG_KEY_REF_NAME,
      door: GEMINI_PAYG_DOOR,
      designatedMachineId: g?.designatedMachineId ?? null,
      releaseState: p ? p.releaseState : 'not-armed',
      periodTimeZone: zone,
      month: { monthEpoch, settledUsd: br?.settledUsd ?? 0, committedUsd: committedMonth, capUsd, resetsAt: new Date(nextPeriodBoundaryMs(ms, zone, 'month')).toISOString(), pct: Math.round(pct * 1000) / 10 },
      day: { dayEpoch, committedUsd: t?.committedDayUsd ?? 0, guardUsd: caps?.dailyCapUsd ?? null, resetsAt: new Date(nextPeriodBoundaryMs(ms, zone, 'day')).toISOString() },
      outstandingReserveUsd: t?.outstandingReserveUsd ?? 0,
      provisionalMonthUsd: t?.provisionalMonthUsd ?? 0,
      perCallCeilingUsd: p?.perCallCeilingUsd ?? null,
      provisionalCeilingUsd: p?.provisionalCeilingUsd ?? null,
      e2: {
        monthUsd: t?.e2MonthUsd ?? 0,
        shareCapUsd: p && capUsd !== null ? Math.round(capUsd * p.e2MonthSharePct) / 100 : null,
        sharePct: p?.e2MonthSharePct ?? null,
        dayUsd: t?.e2DayUsd ?? 0,
        dayCapUsd: p?.e2DayCapUsd ?? null,
      },
      callers: p?.meteredCallers.callers ?? [],
      e3Components: p?.meteredCallers.e3Components ?? [],
      e4: 'off',
      frozen: caps?.frozen === true,
      byCaller: br?.byCaller ?? [],
      thresholds: { reached50: pct >= 0.5, reached80: pct >= 0.8, reached100: pct >= 1 },
      source: 'holder',
    };
  };

  const checkMonth = async (): Promise<void> => {
    if (!runtime.isDesignatedHere()) return;
    const c = capsDetail();
    if (!c || c.month.capUsd === null || !c.thresholds.reached100) return;
    await notices.monthFull(GEMINI_PAYG_KEY_REF_NAME, c.month.monthEpoch, c.month.capUsd, c.month.resetsAt);
  };

  const onRefusal = (err: MoneyGateRefusal): void => {
    if (err.reason !== 'provisional-ceiling') return;
    const c = capsDetail();
    const monthEpoch = c?.month.monthEpoch ?? periodEpochs(now(), 'America/Los_Angeles').monthEpoch;
    const f = readCaps();
    const caps = f?.caps?.[GEMINI_PAYG_KEY_REF_NAME];
    const current = c?.provisionalCeilingUsd ?? 10;
    const lastRecon = reconciliation.list().filter((r) => r.month === monthEpoch && typeof r.figureUsd === 'number').pop();
    const billedLess = lastRecon && typeof lastRecon.figureUsd === 'number' && c && lastRecon.figureUsd < c.month.committedUsd
      ? ` Google's own bill for this month reads $${lastRecon.figureUsd.toFixed(2)}, less than my books ($${c.month.committedUsd.toFixed(2)}).`
      : '';
    const plan: Record<string, unknown> = {
      action: 'caps-adjust',
      keyRef: GEMINI_PAYG_KEY_REF_NAME,
      provider: 'google',
      monthlyCapUsd: caps?.monthlyCapUsd ?? null,
      dailyCapUsd: caps?.dailyCapUsd ?? null,
      lifetimeCapUsd: caps?.lifetimeCapUsd ?? null,
      periodTimeZone: caps?.periodTimeZone ?? null,
      door: GEMINI_PAYG_DOOR,
      provisionalCeilingUsd: current * 2,
      monthEpoch,
    };
    const link = d.spendTabLink?.() ?? null;
    notices.provisionalCeiling(monthEpoch, {
      title: 'Gemini paused: uncertain charges reached their limit',
      need: `Gemini stopped spending because calls whose cost Google may have billed but did not confirm reached the $${current.toFixed(2)} limit for ${monthEpoch}.${billedLess} It reopens on its own at the next month, or sooner if you approve a higher limit.`,
      recommendation: `Approve raising the uncertain-charge limit to $${(current * 2).toFixed(2)} if reviews are needed before the month resets; otherwise leave it.`,
      whyYou: 'Reopening releases money, which only you can approve.',
      doneWhen: [{ id: 'decided', text: 'The limit is raised by your PIN, or left to reset at the month boundary.' }],
      plan,
      link,
    });
  };

  const laneNotify = (kind: 'designation-conflict' | 'key-in-plain-config' | 'stop-action', text: string, meta?: { epoch?: number }): void => {
    if (kind === 'designation-conflict') {
      // The freeze already happened; the handoff can no longer vouch for anything.
      try { files.archiveHandoff('freeze'); } catch { /* @silent-fallback-ok: archival is lifecycle hygiene; the freeze is the stop */ }
      void notices.designationConflict(GEMINI_PAYG_KEY_REF_NAME, meta?.epoch ?? 0, text).catch(() => undefined);
      return;
    }
    if (kind === 'key-in-plain-config') {
      void notices.laneNotice('key-in-plain-config', text).catch(() => undefined);
      return;
    }
    void notices.laneNotice(`stop-action:${now()}`, text).catch(() => undefined);
  };

  // ── Routes ─────────────────────────────────────────────────────────
  const router = Router();

  router.post('/routing-spend/key-handoff/mint-start', (req, res) => {
    if (!loopbackOnly(req, res)) return;
    try {
      const at = files.recordMintStart();
      res.json({ ok: true, mintStartedAt: at, note: 'recorded by the server; a handoff whose reads predate this is refused at render' });
    } catch (err) {
      res.status(500).json({ error: 'mint-start-not-recorded', message: String(err instanceof Error ? err.message : err) });
    }
  });

  router.post('/routing-spend/key-handoff', (req, res) => {
    if (!loopbackOnly(req, res)) return;
    const err = validateKeyHandoffBody(req.body);
    if (err) { res.status(400).json({ error: 'malformed-handoff', message: err }); return; }
    const b = req.body as GeminiPaygKeyHandoff;
    const h: GeminiPaygKeyHandoff = {
      noEchoTransfer: { attestedBy: b.noEchoTransfer.attestedBy, at: b.noEchoTransfer.at, method: b.noEchoTransfer.method, sourceMessageRef: b.noEchoTransfer.sourceMessageRef },
      oneKeyArtifact: { ...b.oneKeyArtifact },
      googleSpendLimit: { ...b.googleSpendLimit },
      boundTo: { designationEpoch: b.boundTo.designationEpoch },
      ...(b.transcripts ? { transcripts: { paths: [...b.transcripts.paths], complete: b.transcripts.complete } } : {}),
    };
    try {
      files.writeHandoff(h);
      res.json({ ok: true, path: path.relative(d.stateDir, files.handoffPath), note: 'validated in full at render (screenshots, mint start, designation, key fingerprint, transcripts)' });
    } catch (e) {
      res.status(500).json({ error: 'handoff-not-written', message: String(e instanceof Error ? e.message : e) });
    }
  });

  router.post('/routing-spend/gemini-payg/proposal', (req, res) => {
    const h = files.readHandoff();
    if (!h) { res.status(409).json({ error: 'awaiting-key', message: 'no valid key handoff on this machine yet — the proposal names the key it attests' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const o: ProposalOverrides = {};
    for (const k of ['monthlyCapUsd', 'dailyCapUsd', 'perCallCeilingUsd', 'provisionalCeilingUsd', 'e2MonthSharePct', 'e2DayCapUsd'] as const) {
      const v = num(b[k]);
      if (b[k] !== undefined && (v === undefined || v <= 0)) { res.status(400).json({ error: 'bad-override', message: `${k} must be a number > 0` }); return; }
      if (v !== undefined) o[k] = v;
    }
    try {
      const setup = buildGeminiPaygProposal({
        designatedMachineId: d.selfMachineId,
        designatedMachineName: d.selfMachineName,
        currentDesignationEpoch: currentDesignationEpoch(readCaps()),
        handoff: h,
        models: MODELS_CHEAPEST_FIRST.slice().reverse(),
        overrides: o,
      });
      const rec = files.writeProposal(setup);
      res.json({ ok: true, proposalHash: rec.hash, setup: rec.setup });
    } catch (e) {
      res.status(400).json({ error: 'bad-proposal', message: String(e instanceof Error ? e.message : e) });
    }
  });

  router.get('/routing-spend/gemini-payg/proposal', (_req, res) => {
    const p = files.readProposal();
    res.json(p ? { present: true, proposalHash: p.hash, setup: p.setup, at: p.at } : { present: false });
  });

  router.get('/routing-spend/gemini-payg/release', (_req, res) => {
    if (!runtime.isDesignatedHere()) { res.json({ holder: runtime.holder(), here: false }); return; }
    // Read-only: a GET never records the release (only the audited POST paths do).
    // `lease` is the gate's own self-fence input (§6): how long ago the designation echo
    // was last positively confirmed by the peers, against the window a paid call needs.
    // Read-only observability — the holder-death drill (release check (b)) reads it to
    // see the echo re-confirm after the holder comes back; nothing here gates on it.
    let confirmedAgoMs: number | null = null;
    try { confirmedAgoMs = runtime.leaseConfirmedAgoMs(); } catch { confirmedAgoMs = null; } // @silent-fallback-ok — unknown reads as null (unconfirmed), the gate's own fail-closed reading
    res.json({
      here: true,
      evaluation: recorder.evaluate(undefined, { write: false }),
      attempts: recorder.attempts(),
      lease: { confirmedAgoMs, windowMs: LEASE_LIVENESS_WINDOW_MS, confirmed: confirmedAgoMs !== null && confirmedAgoMs <= LEASE_LIVENESS_WINDOW_MS },
    });
  });

  router.post('/routing-spend/release-proof', async (req, res) => {
    const session = sessionOf(req, d.isLiveSession);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const lt = b.liveTestArtifact as { featureId?: unknown; runId?: unknown } | undefined;
    const payload: Record<string, unknown> = lt && typeof lt.featureId === 'string' && typeof lt.runId === 'string' ? { liveTestArtifact: { featureId: lt.featureId, runId: lt.runId } } : {};
    if (!runtime.isDesignatedHere()) {
      // A non-holder never spends: it forwards, and the holder stamps the marker itself.
      const fwd = await runtime.forwardReleaseProof(session, payload);
      res.status(fwd.status).json(fwd.body);
      return;
    }
    if (payload.liveTestArtifact) { try { recorder.recordLiveTestRef(payload.liveTestArtifact as LiveTestRef); } catch { /* @silent-fallback-ok: (b) stays unmet and is named */ } }
    const r = await recorder.runProof({ forwardedFrom: null });
    try { d.moneyAudit()?.auditOnly().append('gemini-payg-release', session, { releaseState: r.evaluation.releaseState, blocker: r.evaluation.blocker, attempt: r.attempt?.state ?? null }); } catch { /* @silent-fallback-ok: audit-only */ }
    res.json({ status: 'ok', ...r });
  });

  // §9 reduce-only stop actions: Bearer, from any machine, delivered to the spender.
  const stop = async (req: Request, res: Response, action: StopAction, params: Record<string, unknown>, what: string) => {
    const session = sessionOf(req, d.isLiveSession);
    const actor = `session:${session}`;
    const r = await runtime.stopAction(action, actor, params);
    try { d.moneyAudit()?.auditOnly().append('gemini-payg-stop-action', actor, { action, params, confirmed: r.confirmed, ok: r.ok, reason: r.reason ?? null }); } catch { /* @silent-fallback-ok: audit-only; the stop itself already reached (or is queued for) the spender */ }
    if (r.ok && r.confirmed) {
      void notices.limitLowered(session, what).catch(() => undefined);
      res.json({ ok: true, stopped: true, confirmed: true, message: `done — ${what}` });
      return;
    }
    if (r.ok && !r.confirmed) {
      res.status(202).json({ ok: true, confirmed: false, message: 'stop applied here; no machine is designated to spend, so there is no spender to confirm it' });
      return;
    }
    if (r.reason === 'holder-unreachable') {
      res.status(202).json({ ok: false, confirmed: false, reason: r.reason, message: 'stop requested; the spending machine has not confirmed yet' });
      return;
    }
    if (r.reason === 'money-layer-off') {
      res.status(503).json({ ok: false, reason: r.reason, message: 'the spending controls are off on the spending machine, so there is nothing to lower' });
      return;
    }
    res.status(409).json({ ok: false, reason: r.reason ?? 'refused', message: r.reason ?? 'refused' });
  };

  router.post('/routing-spend/caps/lower', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const params: Record<string, unknown> = {};
    const words: string[] = [];
    for (const k of ['monthlyCapUsd', 'dailyCapUsd', 'perCallCeilingUsd', 'provisionalCeilingUsd', 'e2DayCapUsd'] as const) {
      if (b[k] === undefined) continue;
      const v = num(b[k]);
      if (v === undefined || v < 0) { res.status(400).json({ error: 'bad-value', message: `${k} must be a number ≥ 0` }); return; }
      params[k] = v;
      words.push(`${k.replace(/Usd$/, '')} to $${v.toFixed(2)}`);
    }
    if (!words.length) { res.status(400).json({ error: 'nothing-to-lower', message: 'name at least one limit to lower' }); return; }
    // Pre-check where the record is readable here (the holder): only ≤ current is accepted.
    const f = readCaps();
    if (f && runtime.isDesignatedHere()) {
      const c = f.caps[GEMINI_PAYG_KEY_REF_NAME];
      const p = f.doorPolicy?.[GEMINI_PAYG_DOOR];
      const cur: Record<string, number | undefined> = { monthlyCapUsd: c?.monthlyCapUsd, dailyCapUsd: c?.dailyCapUsd, perCallCeilingUsd: p?.perCallCeilingUsd, provisionalCeilingUsd: p?.provisionalCeilingUsd, e2DayCapUsd: p?.e2DayCapUsd };
      for (const [k, v] of Object.entries(params)) {
        const now0 = cur[k];
        if (now0 !== undefined && (v as number) > now0) {
          res.status(409).json({ ok: false, reason: 'raise-needs-pin', message: `${k} ${v} is above the current ${now0} — raising is the operator's, by PIN` });
          return;
        }
      }
    }
    await stop(req, res, 'lower', params, `lowered ${words.join(', ')}`);
  });

  router.post('/routing-spend/callers/disable', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const caller = typeof b.caller === 'string' ? b.caller : null;
    const e3 = typeof b.e3Component === 'string' ? b.e3Component : null;
    if (!caller && !e3) { res.status(400).json({ error: 'bad-request', message: 'name a caller or an e3Component to disable' }); return; }
    await stop(req, res, 'disable-caller', caller ? { caller } : { e3Component: e3 }, caller ? `turned off the ${caller} caller` : `removed the ${e3} background check`);
  });

  router.post('/routing-spend/share/lower', async (req, res) => {
    const v = num((req.body ?? {}).e2MonthSharePct);
    if (v === undefined || v < 0 || v > 100) { res.status(400).json({ error: 'bad-value', message: 'e2MonthSharePct must be a number in [0,100]' }); return; }
    await stop(req, res, 'lower-share', { e2MonthSharePct: v }, `lowered the second-opinion share to ${v}% of the month`);
  });

  router.post('/routing-spend/reconciliation', (req, res) => {
    if (!runtime.isDesignatedHere()) {
      res.status(409).json({ error: 'not-holder', message: `reconciliation records live on the spending machine (${runtime.holder() ?? 'none designated'})` });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const month = typeof b.month === 'string' && /^\d{4}-\d{2}$/.test(b.month) ? b.month : null;
    if (!month) { res.status(400).json({ error: 'bad-request', message: 'month (YYYY-MM, Pacific) is required' }); return; }
    const unmeasurable = b.unmeasurable === true;
    const figure = num(b.figureUsd);
    if (!unmeasurable && (figure === undefined || figure < 0)) { res.status(400).json({ error: 'bad-request', message: 'a figureUsd ≥ 0, or unmeasurable: true when the page could not be read (never a guess)' }); return; }
    // The books for THAT month, folded from the ledger rows' charged month (exact for a past month).
    const br = d.ledger()?.monthBreakdown(GEMINI_PAYG_KEY_REF_NAME, month) ?? null;
    const committed = br ? Math.round((br.settledUsd + br.outstandingUsd) * 1e6) / 1e6 : null;
    const out = reconciliation.append({
      machineId: d.selfMachineId,
      session: sessionOf(req, d.isLiveSession),
      month,
      figureUsd: unmeasurable ? null : (figure as number),
      unmeasurable,
      committedMonthUsd: committed,
    });
    if (out.notify && out.record.figureUsd !== null && out.record.committedMonthUsd !== null && out.record.driftPct !== null) {
      void notices.invoiceDrift(month, out.record.figureUsd, out.record.committedMonthUsd, out.record.driftPct).catch(() => undefined);
    }
    res.json({ ok: true, record: out.record, ...(out.rereadAfter ? { driftPendingReread: true, rereadAfter: out.rereadAfter } : {}), note: 'reporting only — never a gate input' });
  });

  return {
    files,
    port,
    recorder,
    reconciliation,
    notices,
    router,
    applyPending,
    releaseProofForwarded,
    setRenderer: (fn) => { renderer = fn; },
    renderForPeer,
    capsDetail,
    onRefusal,
    checkMonth,
    laneNotify,
  };
}
