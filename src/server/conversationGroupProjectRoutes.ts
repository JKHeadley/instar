/**
 * Draft "make this group a project" (docs/specs/conversation-groups-phone.md §3). Owner only.
 *
 *   POST /mobile/conversation-graph/nodes/:ref/project-draft   (owner phone, device-signed)
 *   POST /conversation-graph/nodes/:ref/project-draft          (dashboard operator session)
 *
 * Body: {} or { goal?: string, done?: string[], repos?: string[] } within the Chief of Staff store's own limits —
 * the owner's own words replace the drafted ones. Answers 201 with a self-certifying draft (stored nowhere).
 * Writes no binding: confirming is the owner's Face ID tap (POST /mobile/work/projects/drafts/:draftId/confirm,
 * carrying the draft back) or, on the dashboard, the PIN-gated POST /chief-of-staff/projects.
 *
 * This module also builds the graph half of that confirm (`groupProjectConfirmPort`): the group as it is now,
 * read with the confirming phone's own owner view.
 */
import { Router, type Request, type Response } from 'express';
import { decodeRouteRef, nodeKey, validateNodeRef, type ConversationRef, type EffortRef, type NodeRef } from '../core/conversationGraph.js';
import type { ConversationGraphReadModel, GraphViewer } from '../core/conversationGraphRead.js';
import {
  GROUP_PROJECT_LIMITS, buildGroupProjectBinding, cleanDraftText, confirmGroupProjectDraft, cosConversationKey, groupProjectConfirmLine,
  groupProjectContext, makeGroupProjectDraft, type BoundProjectContent, type GroupProjectConfirmDeps, type GroupProjectGroupNow,
} from './ConversationGroupProjectDrafts.js';

export interface GroupProjectRouteDeps {
  model: ConversationGraphReadModel;
  resolveViewer(req: Request, surface: 'dashboard' | 'mobile'): GraphViewer | null;
  telegramChatId: string;
  /** What one conversation is about (topic summary and goals), bounded; '' when unknown. Display only. */
  evidence(ref: ConversationRef): string;
  /** Bound projects by conversation key; null when the Chief of Staff is off or its journal is unreadable. */
  boundProjects(): Map<string, BoundProjectContent> | null;
  /** False when the Chief of Staff is off on this agent. */
  chiefOfStaffOn(): boolean;
  now?: () => number;
}

function ownerBody(raw: unknown): { goal?: string; done?: string[]; repos?: string[] } | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== 'goal' && k !== 'done' && k !== 'repos')) return null;
  const out: { goal?: string; done?: string[]; repos?: string[] } = {};
  if (b.goal !== undefined) { if (typeof b.goal !== 'string' || b.goal.length > GROUP_PROJECT_LIMITS.goal) return null; out.goal = b.goal; }
  if (b.done !== undefined) {
    if (!Array.isArray(b.done) || b.done.length > GROUP_PROJECT_LIMITS.doneItems || !b.done.every((t) => typeof t === 'string' && t.length <= GROUP_PROJECT_LIMITS.doneText)) return null;
    out.done = b.done as string[];
  }
  if (b.repos !== undefined) {
    if (!Array.isArray(b.repos) || b.repos.length > GROUP_PROJECT_LIMITS.repos || !b.repos.every((r) => typeof r === 'string' && /^[\w.-]{1,64}\/[\w.-]{1,100}$/.test(r))) return null;
    out.repos = b.repos as string[];
  }
  return out;
}

type GroupRead = { title: string; frontDoor: ConversationRef | null; members: ConversationRef[] };
const noAnswer = (status: number) => status === 0 || status === 408 || status >= 500;
/** A group as the graph shows it to this viewer now (members: its first page); null when gone or hidden, 'unavailable' when it did not answer. */
function readGroup(model: ConversationGraphReadModel, viewer: GraphViewer, ref: NodeRef): GroupRead | null | 'unavailable' {
  const read = model.node(viewer, ref, {}) as { status: number; body: Record<string, unknown> };
  if (noAnswer(read.status)) return 'unavailable';
  if (read.status !== 200) return null;
  const node = read.body.node as { title?: unknown; frontDoor?: unknown } | undefined;
  const title = typeof node?.title === 'string' && node.title.trim() ? node.title : 'Untitled group';
  const members = ((read.body.children as { items?: Array<{ ref?: unknown }> } | undefined)?.items ?? [])
    .map((c) => validateNodeRef(c?.ref)).filter((r): r is ConversationRef => r?.kind === 'conversation');
  const front = node?.frontDoor ? validateNodeRef(node.frontDoor) : null;
  return { title, frontDoor: front?.kind === 'conversation' ? front : null, members };
}

/** The confirm's view: the group's name, and whether the conversation still sits in it (its own parent) or is its front door. */
function groupNow(model: ConversationGraphReadModel, viewer: GraphViewer, ref: EffortRef, conversation: ConversationRef): GroupProjectGroupNow {
  const group = readGroup(model, viewer, ref);
  if (group === 'unavailable' || group === null) return group;
  const groupKey = nodeKey(ref), convKey = nodeKey(conversation);
  if (group.frontDoor && nodeKey(group.frontDoor) === convKey) return { title: group.title, holds: true };
  const conv = model.node(viewer, conversation, {}) as { status: number; body: Record<string, unknown> };
  if (noAnswer(conv.status)) return 'unavailable';
  const path = conv.status === 200 && Array.isArray(conv.body.path) ? (conv.body.path as Array<{ ref?: unknown }>).map((p) => validateNodeRef(p?.ref)) : [];
  const parent = path.length ? path[path.length - 1] : null;
  return { title: group.title, holds: Boolean(parent && nodeKey(parent) === groupKey) };
}

/** The graph half of the phone confirm: the group re-read with the confirming owner phone's view. */
export function groupProjectConfirmPort(deps: Pick<GroupProjectRouteDeps, 'model' | 'resolveViewer' | 'telegramChatId' | 'boundProjects' | 'now'>,
  bindProject: GroupProjectConfirmDeps['bindProject']) {
  return (req: Request, draftId: string, draftHash: string, carried: unknown): { status: number; body: Record<string, unknown> } => {
    const viewer = deps.resolveViewer(req, 'mobile');
    if (!viewer) return { status: 403, body: { error: 'hierarchy-owner-only' } };
    return confirmGroupProjectDraft({
      telegramChatId: deps.telegramChatId, now: deps.now ?? Date.now, boundProjects: deps.boundProjects, bindProject,
      groupNow: (ref, conversation) => groupNow(deps.model, viewer, ref, conversation),
    }, draftId, draftHash, carried);
  };
}

export function createConversationGroupProjectRouter(deps: GroupProjectRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  for (const [base, surface] of [['/conversation-graph', 'dashboard'], ['/mobile/conversation-graph', 'mobile']] as const) {
    router.post(`${base}/nodes/:ref/project-draft`, (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const viewer = deps.resolveViewer(req, surface);
      if (!viewer) return void res.status(403).json({ code: 'hierarchy-owner-only' });
      const ref = decodeRouteRef(req.params.ref);
      if (!ref) return void res.status(404).json({ code: 'not-found' });
      if (ref.kind !== 'effort') return void res.status(400).json({ code: 'not-a-group', text: 'Only a group can become a project.' });
      const body = ownerBody(req.body);
      if (!body) return void res.status(400).json({ code: 'invalid-draft-request' });
      if (!deps.chiefOfStaffOn()) return void res.status(503).json({ code: 'chief-of-staff-off', text: 'Projects need the Chief of Staff, which is not on for this agent.' });
      const group = readGroup(deps.model, viewer, ref);
      if (group === 'unavailable') return void res.status(503).json({ code: 'conversation-graph-pending' });
      if (!group) return void res.status(404).json({ code: 'not-found' });
      const candidates: ConversationRef[] = [...(group.frontDoor ? [group.frontDoor] : []), ...group.members];
      // The front door, else the first conversation the Chief of Staff can track.
      let chosen: { ref: ConversationRef; key: string } | null = null;
      for (const c of candidates) { const key = cosConversationKey(c, deps.telegramChatId); if (key) { chosen = { ref: c, key }; break; } }
      if (!chosen) return void res.status(409).json({ code: 'group-has-no-conversation', text: 'This group has no conversation a project can be tied to yet. Move one in first.' });
      // The complete projects read is the expensive part: only after the cheap refusals.
      const bound = deps.boundProjects();
      if (!bound) return void res.status(503).json({ code: 'could-not-check-projects', text: 'The agent could not read its whole project history. Try again in a moment; if it keeps saying this, make the project from the dashboard and tell your agent.' });
      if (bound.has(chosen.key)) return void res.status(409).json({ code: 'already-a-project', conversationKey: chosen.key, text: 'Its conversation is already a project.' });
      // The title is a hashed field the phone shows, so it is cleaned like every other draft text.
      const title = cleanDraftText(group.title, 200) || 'Untitled group';
      const binding = buildGroupProjectBinding({ title, conversationKey: chosen.key, ownerGoal: body.goal, ownerDone: body.done, ownerRepos: body.repos });
      const made = makeGroupProjectDraft({ group: { ref: ref as EffortRef, title }, conversation: chosen.ref, binding, now: now() });
      const context = groupProjectContext(candidates, deps.evidence);
      const current = deps.resolveViewer(req, surface);
      if (!current || current.principalKey !== viewer.principalKey || current.grantVersion !== viewer.grantVersion) return void res.status(403).json({ code: 'hierarchy-owner-only' });
      res.status(201).json({
        draftId: made.draftId, draftHash: made.draftHash, expiresAt: made.draft.expiresAt,
        draft: made.draft,
        context,
        confirm: {
          action: 'group-project-confirm', target: made.draftId, proposalHash: made.draftHash,
          actionLine: groupProjectConfirmLine(made.draftId, made.draftHash),
          route: `/mobile/work/projects/drafts/${made.draftId}/confirm`,
        },
      });
    });
  }
  return router;
}
