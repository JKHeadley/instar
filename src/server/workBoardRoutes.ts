/**
 * Work Board routes (docs/specs/work-board-asks.md §4, §7).
 *
 *   Agent (Bearer) / scoped session (mps_, its own card only):
 *     GET  /work-board                      lanes, pending pickups, behind
 *     GET  /work-board/cards/:id
 *     POST /work-board/cards                create (agent)
 *     POST /work-board/cards/:id/records    edited | waiting-on | evidence | claimed-done
 *   Team owner from the console (dashboard PIN):
 *     POST /work-board/cards                create (person-written)
 *     POST /work-board/cards/:id/records    edited (person-written)
 *     POST /work-board/cards/:id/tap        every tap
 *     POST /work-board/settings             limits and the `policy` record
 *   Phone (device principal; tap = active owner phone + presence signature):
 *     GET  /mobile/work-board
 *     POST /mobile/work-board/cards/:id/tap
 *
 * The route decides who the caller is from how the request authenticated, never from a body
 * field: a body's `by` is ignored. With the feature off every route answers 503
 * `work-board-disabled`. A card a person may not read does not exist for them (404, never 403).
 */

import type { Router, Request, Response } from 'express';
import type { WorkBoardService, WorkPrincipal, WorkBoardSettings, CardView } from '../core/WorkBoardService.js';
import { validateSettingsPatch, transcriptLineFor, lineIdFor } from '../core/WorkBoardService.js';
import { cardJson, boardJson, type Viewer, type BehindInfo } from '../core/workBoardViews.js';
import type { WorkBoardPickupController } from '../core/WorkBoardPickupController.js';
import { isCardId, isRestrictingTap, type WorkRecordType } from '../core/WorkCardStore.js';

/**
 * How the request authenticated. `bearer` is the server token, which both the agent and the
 * console hold: a bearer request is the AGENT unless it also proves the dashboard PIN, which is
 * what makes it the team owner (the existing Approvals posture; §4 "Limits of the proof").
 */
export type ResolvedCaller =
  | { kind: 'bearer' }
  | { kind: 'session'; conversationKey: string | null }
  | { kind: 'device'; personKey: string | null; isOwner: boolean; mayRead: (conversationKey: string) => boolean }
  | { kind: 'none' };

export interface WorkBoardRouteDeps {
  enabled: () => boolean;
  svc: () => WorkBoardService | null;
  controller: () => WorkBoardPickupController | null;
  settings: () => WorkBoardSettings;
  /** How the request authenticated (the middleware's principal). */
  caller: (req: Request) => ResolvedCaller;
  /** The team owner's personKey. */
  ownerPersonKey: () => string | null;
  /** Dashboard PIN check (createMandatePinCheck). Writes the refusal and returns false when it fails. */
  requirePin: (req: Request, res: Response, message: string) => boolean;
  displayName: (personKey: string) => string;
  /** Append one server-written `Work board:` line (role agent + systemSource) to the card's conversation. */
  appendLine: (conversationKey: string, lineId: string, text: string) => Promise<void>;
  /** Create the card's conversation (idempotent: the key is derived from the card id). */
  ensureConversation: (cardId: string, conversationKey: string, title: string) => Promise<void>;
  /** Remove the card's conversation and its files after a redact. */
  removeConversation: (conversationKey: string) => Promise<void>;
  behind: () => BehindInfo | null;
  lastWrittenOn: (v: CardView) => string | null;
  repliedAfterQuestion: (v: CardView) => boolean;
  brokenAttachments: (v: CardView) => string[];
  when: (iso: string) => string;
  /** True on the lease holder (the graduation record is written there). Absent ⇒ single machine. */
  holdsLease?: () => boolean;
  /** One `Work board:` line on each card a policy change made workable. */
  afterPolicy?: (policyRecordData: Record<string, unknown>, cardIds: string[]) => Promise<void>;
  /** Persist a settings change (live config); returns false on failure. */
  saveSettings: (patch: Record<string, unknown>) => boolean;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

function disabled(res: Response): void { res.status(503).json({ error: 'work-board-disabled' }); }

export function registerWorkBoardRoutes(router: Router, deps: WorkBoardRouteDeps): void {
  const gate = (res: Response): WorkBoardService | null => {
    if (!deps.enabled()) { disabled(res); return null; }
    const svc = deps.svc();
    if (!svc) { res.status(503).json({ error: 'work-board-starting' }); return null; }
    return svc;
  };

  const viewerFor = (c: ResolvedCaller): Viewer | null => {
    const owner = deps.ownerPersonKey();
    switch (c.kind) {
      case 'bearer': return { personKey: owner, isOwner: false, isAgent: true };
      case 'session': return { personKey: null, isOwner: false, isAgent: true };
      case 'device': return c.isOwner ? { personKey: owner, isOwner: true, isAgent: false } : (c.personKey ? { personKey: c.personKey, isOwner: false, isAgent: false } : null);
      default: return null;
    }
  };

  const extraFor = (svc: WorkBoardService) => (v: CardView) => ({
    behind: deps.behind(), lastWrittenOn: deps.lastWrittenOn(v), repliedAfterQuestion: deps.repliedAfterQuestion(v),
    capacity: (() => { const p = v.pickups.find((x) => x.status === 'pending' && svc.capacityWait.has(x.cause.id)); return p ? svc.capacityWait.get(p.cause.id)! : null; })(),
    brokenAttachments: deps.brokenAttachments(v),
  });

  /** Visible to this viewer? The owner and the agent see every card; others need read access to its conversation. */
  const visible = (c: ResolvedCaller, viewer: Viewer, v: CardView): boolean => viewer.isAgent || viewer.isOwner || (c.kind === 'device' && c.mayRead(v.card.conversationKey));

  const writeLine = async (svc: WorkBoardService, cardId: string, recordId: string, type: WorkRecordType, data: Record<string, unknown>, ctx: { materialChanged?: string[]; voidedApproval?: boolean } = {}) => {
    const v = svc.view(cardId); if (!v || v.card.redacted) return;
    const line = transcriptLineFor(type, data, { name: deps.displayName, when: deps.when, ...ctx });
    if (!line) return;
    try { await deps.appendLine(v.card.conversationKey, lineIdFor(recordId), line); }
    catch (err) { /* @silent-fallback-ok: logged; the record stands and the line is presentation */ deps.log?.('work-board-line-failed', { cardId, error: (err as Error)?.message }); }
  };

  const send = (res: Response, result: { ok: boolean }, okStatus = 200) => {
    const r = result as { ok: boolean; status?: number; error?: string; detail?: Record<string, unknown> } & Record<string, unknown>;
    if (r.ok) { const { ok: _ok, ...rest } = r; res.status(okStatus).json(rest); return; }
    res.status(r.status ?? 400).json({ error: r.error, ...(r.detail ?? {}) });
  };

  // ── reads ──────────────────────────────────────────────────────────────────

  const listBoard = (req: Request, res: Response) => {
    const svc = gate(res); if (!svc) return;
    const c = deps.caller(req);
    if (c.kind === 'session') { res.status(403).json({ error: 'scoped-session-reads-its-own-card-only' }); return; }
    const viewer = viewerFor(c);
    if (!viewer) { res.status(401).json({ error: 'unauthorized' }); return; }
    const donePage = Number.parseInt(String(req.query.donePage ?? '0'), 10) || 0;
    const board = boardJson(svc, viewer, (ck) => c.kind === 'device' && c.mayRead(ck), deps.displayName, { softOpenCards: deps.settings().softOpenCards, donePage, extraFor: extraFor(svc) });
    const ctl = deps.controller();
    // `viewer.canTap`: the team owner (a phone proves each tap with Face ID; the console with the PIN).
    res.json({ ...board, viewer: { isOwner: viewer.isOwner || c.kind === 'bearer', canTap: viewer.isOwner || c.kind === 'bearer' }, ...(viewer.isAgent || viewer.isOwner ? { pickups: ctl?.status() ?? null } : {}), behind: deps.behind(), settings: viewer.isOwner || viewer.isAgent ? deps.settings() : undefined });
  };
  router.get('/work-board', listBoard);
  router.get('/mobile/work-board', listBoard);

  router.get('/work-board/cards/:id', (req, res) => {
    const svc = gate(res); if (!svc) return;
    const c = deps.caller(req);
    const viewer = viewerFor(c);
    if (!viewer) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = String(req.params.id);
    const v = isCardId(id) ? svc.view(id) : null;
    if (!v || !v.card.created) { res.status(404).json({ error: 'not-found' }); return; }
    if (c.kind === 'session' && c.conversationKey !== v.card.conversationKey) { res.status(404).json({ error: 'not-found' }); return; }
    if (!visible(c, viewer, v)) { res.status(404).json({ error: 'not-found' }); return; }
    res.json({ card: cardJson(svc, v, viewer, deps.displayName, extraFor(svc)(v)) });
  });

  // ── writes ─────────────────────────────────────────────────────────────────

  /** Agent / scoped session / console-PIN owner. Returns the principal or writes a refusal. */
  const writerOf = (req: Request, res: Response, pinMessage: string): WorkPrincipal | null => {
    const c = deps.caller(req);
    if (c.kind === 'session') {
      if (!c.conversationKey) { res.status(403).json({ error: 'session-not-bound' }); return null; }
      return { kind: 'session', conversationKey: c.conversationKey };
    }
    if (c.kind === 'bearer') {
      // No PIN offered ⇒ the agent. A PIN offered ⇒ it must be right, and the write is the team owner's.
      if ((req.body as { pin?: unknown } | undefined)?.pin === undefined) return { kind: 'agent' };
      if (!deps.requirePin(req, res, pinMessage)) return null;
      const owner = deps.ownerPersonKey();
      if (!owner) { res.status(409).json({ error: 'no-team-owner' }); return null; }
      return { kind: 'person', personKey: owner, proof: 'pin', isOwner: true };
    }
    res.status(401).json({ error: 'unauthorized' });
    return null;
  };

  router.post('/work-board/cards', async (req, res) => {
    const svc = gate(res); if (!svc) return;
    const p = writerOf(req, res, 'Enter your dashboard PIN to add this card'); if (!p) return;
    const { pin: _pin, ...body } = (req.body ?? {}) as Record<string, unknown>;
    const r = svc.createCard(p, body);
    if (!r.ok) { send(res, r); return; }
    try { await deps.ensureConversation(r.cardId, r.conversationKey, String(body.title ?? '')); }
    catch (err) { /* @silent-fallback-ok: logged; the card exists and its chat is created at the next write or boot (the key is derived) */ deps.log?.('work-board-conversation-create-failed', { cardId: r.cardId, error: (err as Error)?.message }); }
    const v = svc.view(r.cardId)!;
    deps.controller()?.poke();
    res.status(201).json({ cardId: r.cardId, conversationKey: r.conversationKey, card: cardJson(svc, v, viewerFor(deps.caller(req))!, deps.displayName), ...(r.overSoftBudget ? { overSoftBudget: r.overSoftBudget } : {}) });
  });

  router.post('/work-board/cards/:id/records', async (req, res) => {
    const svc = gate(res); if (!svc) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = body.kind ?? body.recordType;
    if (kind === 'dispatching' || kind === 'dispatched' || kind === 'policy' || kind === 'tap' || kind === 'created') {
      res.status(400).json({ error: 'record-kind-not-allowed', message: 'Pickup records are written only by the pickup controller, the policy only by the settings route, and taps only by the tap route.' });
      return;
    }
    const p = writerOf(req, res, 'Enter your dashboard PIN to change this card'); if (!p) return;
    const id = String(req.params.id);
    const { pin: _pin, kind: _k, recordType: _rt, ...rest } = body;
    const fields = (body.fields && typeof body.fields === 'object' ? body.fields : rest) as Record<string, unknown>;
    if (p.kind === 'person' && kind !== 'edited') { res.status(403).json({ error: 'agent-only' }); return; }
    const before = svc.view(id);
    const wasApproved = !!before?.card.approvalValid;
    switch (kind) {
      case 'edited': {
        const r = svc.edit(p, id, fields);
        if (r.ok && r.recordId) {
          const after = svc.view(id)!;
          const rec = svc.recordsOf(id).find((x) => x.id === r.recordId);
          const material = after.card.lastMaterialChangeFields;
          if (rec && wasApproved && !after.card.approvalValid) await writeLine(svc, id, r.recordId, 'edited', rec.d, { materialChanged: material, voidedApproval: true });
          deps.controller()?.poke();
        }
        send(res, r); return;
      }
      case 'waiting-on': {
        const r = svc.setWaitingOn(p, id, fields as never);
        if (r.ok) { const rec = svc.recordsOf(id).find((x) => x.id === r.questionId); if (rec?.d.supersedes) await writeLine(svc, id, r.questionId, 'waiting-on', rec.d); }
        send(res, r); return;
      }
      case 'evidence': send(res, svc.addEvidence(p, id, fields as never)); return;
      case 'claimed-done': send(res, svc.claimDone(p, id)); return;
      default: res.status(400).json({ error: 'unknown-record-kind', allowed: ['edited', 'waiting-on', 'evidence', 'claimed-done'] });
    }
  });

  const applyTap = async (svc: WorkBoardService, req: Request, res: Response, p: WorkPrincipal) => {
    const r = await performOwnerTap(deps, svc, String(req.params.id), (req.body ?? {}) as Record<string, unknown>, p);
    res.status(r.status).json(r.body);
  };

  router.post('/work-board/cards/:id/tap', async (req, res) => {
    const svc = gate(res); if (!svc) return;
    const c = deps.caller(req);
    // A scoped session or a phone has no console PIN path; a bearer request must prove the PIN.
    if (c.kind !== 'bearer') { res.status(403).json({ error: 'person-required' }); return; }
    if ((req.body as { pin?: unknown } | undefined)?.pin === undefined) { res.status(403).json({ error: 'person-required', message: 'A tap is a person\'s: it needs the dashboard PIN (console) or Face ID (phone). The agent cannot tap.' }); return; }
    if (!deps.requirePin(req, res, 'Enter your dashboard PIN to confirm')) return;
    const owner = deps.ownerPersonKey();
    if (!owner) { res.status(409).json({ error: 'no-team-owner' }); return; }
    await applyTap(svc, req, res, { kind: 'person', personKey: owner, proof: 'pin', isOwner: true });
  });

  // ── graduation (Maturation plan): the pilot's own measurement, written by the scheduled job ──
  router.get('/work-board/graduation', (req, res) => {
    const svc = gate(res); if (!svc) return;
    if (deps.caller(req).kind !== 'bearer') { res.status(403).json({ error: 'not-available-to-this-caller' }); return; }
    res.json({ ...svc.graduationState(), current: svc.graduationMetrics(7) });
  });
  router.post('/work-board/graduation/pass', (req, res) => {
    const svc = gate(res); if (!svc) return;
    if (deps.caller(req).kind !== 'bearer') { res.status(403).json({ error: 'not-available-to-this-caller' }); return; }
    // The lease holder writes the record; any other machine reports what is due and writes nothing.
    if (deps.holdsLease && !deps.holdsLease()) { res.json({ written: [], due: svc.graduationState().due, skipped: 'not-lease-holder' }); return; }
    res.json(svc.graduationPass());
  });

  router.post('/work-board/settings', async (req, res) => {
    const svc = gate(res); if (!svc) return;
    const c = deps.caller(req);
    if (c.kind !== 'bearer') { res.status(403).json({ error: 'person-required' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.preview === true && body.policy) {
      // The PIN prompt says how many waiting cards would start at once (§7); no PIN for the count.
      res.json({ wouldStart: svc.cardsStartingUnder(body.policy === 'outward-only' ? 'outward-only' : 'every-agent-card') });
      return;
    }
    if (body.pin === undefined) { res.status(403).json({ error: 'person-required', message: 'Only the team owner changes the work board settings, with the dashboard PIN.' }); return; }
    if (!deps.requirePin(req, res, 'Enter your dashboard PIN to change the work board settings')) return;
    const owner = deps.ownerPersonKey();
    if (!owner) { res.status(409).json({ error: 'no-team-owner' }); return; }
    const { pin: _pin, policy, preview: _pv, ...patch } = body;
    // Validate EVERYTHING before anything is written: a request with a policy and one bad setting changes nothing.
    if (policy !== undefined && policy !== 'every-agent-card' && policy !== 'outward-only') { res.status(400).json({ error: 'unknown-policy' }); return; }
    if (Object.keys(patch).length) {
      const v = validateSettingsPatch(patch);
      if (!v.ok) { res.status(400).json({ error: 'invalid-setting', field: v.field, message: 'Settings are positive whole numbers with known names; the free check cannot run more often than once a minute, and the attempt cap is at least 1.' }); return; }
    }
    let policyResult: unknown = null;
    if (policy !== undefined) {
      const before = svc.cardIds().filter((id) => { const v = svc.view(id); return !!v && !v.card.workable && !v.card.redacted; });
      const r = svc.setPolicy({ kind: 'person', personKey: owner, proof: 'pin', isOwner: true }, policy);
      if (!r.ok) { send(res, r); return; }
      policyResult = { recordId: r.recordId, wouldStart: r.wouldStart };
      const started = before.filter((id) => svc.view(id)?.card.workable);
      const rec = svc.policyRecords().find((x) => x.id === r.recordId);
      if (rec && started.length) await deps.afterPolicy?.(rec.d, started).catch(() => { /* @silent-fallback-ok: the line is presentation; the policy record stands */ });
      deps.controller()?.poke();
    }
    if (Object.keys(patch).length && !deps.saveSettings(patch)) { res.status(500).json({ error: 'settings-not-saved' }); return; }
    res.json({ settings: deps.settings(), policy: svc.policy(), ...(policyResult ? { policyChange: policyResult } : {}) });
  });
}

/**
 * Apply one person-proven tap: the record, its transcript line (or the conversation's removal for a
 * redact), a poke to the pickup controller. Shared by the console route (PIN) and the phone route
 * (presence signature, mounted in mobilePermissionsRoutes behind the write gate).
 */
export async function performOwnerTap(deps: Pick<WorkBoardRouteDeps, 'displayName' | 'when' | 'appendLine' | 'removeConversation' | 'controller' | 'ownerPersonKey' | 'log'>, svc: WorkBoardService, cardId: string, body: Record<string, unknown>, p: WorkPrincipal): Promise<{ status: number; body: Record<string, unknown> }> {
  // A tap that PERMITS something must name the title the person saw (its hash): the title is what
  // they read on screen, and an answer, a release or a Try again is bound to nothing else that shows it.
  if (!isRestrictingTap(String(body.action)) && !(typeof body.titleHash === 'string' && /^[0-9a-f]{64}$/.test(body.titleHash))) {
    return { status: 400, body: { error: 'title-hash-required', message: 'Send titleHash (the card\'s titleHash as shown) with this tap.' } };
  }
  const r = svc.tap(p, cardId, body);
  if (!r.ok) return { status: r.status, body: { error: r.error, ...(r.detail ?? {}) } };
  if (r.recordId) {
    const rec = svc.recordsOf(cardId).find((x) => x.id === r.recordId);
    const v = svc.view(cardId);
    if (rec && v) {
      if (rec.d.action === 'redact') {
        await deps.removeConversation(v.card.conversationKey).catch((err) => deps.log?.('work-board-redact-conversation-failed', { cardId, error: (err as Error)?.message }));
      } else {
        const line = transcriptLineFor('tap', rec.d, { name: deps.displayName, when: deps.when });
        if (line) await deps.appendLine(v.card.conversationKey, lineIdFor(r.recordId), line).catch((err) => deps.log?.('work-board-line-failed', { cardId, error: (err as Error)?.message }));
      }
    }
  }
  deps.controller()?.poke();
  const v = svc.view(cardId)!;
  return { status: 200, body: { recordId: r.recordId, card: cardJson(svc, v, { personKey: deps.ownerPersonKey(), isOwner: true, isAgent: false }, deps.displayName) } };
}
