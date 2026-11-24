/** Historical creation evidence, never an access grant or a current tree mutation.
 * Spec: docs/specs/conversation-creation-context.md.
 */
import crypto from 'node:crypto';
import { canonicalConversationKey, APP_CONVERSATION_KEY_RE } from './appConversationText.js';
import { parseCanonicalKey, WORKSPACE_PLACEHOLDER } from './conversationIdentity.js';
import type { CreatedEvent } from './AppConversationStore.js';

export interface AppCreationContext {
  v: 1;
  source: {
    kind: 'person' | 'work-board-card' | 'session';
    cardId?: string;
    requestId?: string;
    originMachineId?: string;
    sourceConversationKey?: string;
    projectKey?: string;
  };
  parentConversationKey?: string | null;
  parentBasis?: 'explicit' | 'source' | 'project';
}

const record = (raw: unknown): Record<string, unknown> | null => raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
const bounded = (raw: unknown, max: number): raw is string => typeof raw === 'string' && raw.length > 0 && raw.length <= max && !/[\u0000-\u001f\u007f]/.test(raw);
const exactKeys = (raw: Record<string, unknown>, keys: readonly string[]) => Object.keys(raw).every((key) => keys.includes(key));

/** Durable identity only; mobile negative Slack aliases are intentionally not converted here. */
export function normalizeCreationParentRef(raw: unknown): string | null {
  if (!bounded(raw, 256)) return null;
  if (APP_CONVERSATION_KEY_RE.test(raw)) return canonicalConversationKey(raw);
  if (raw.startsWith('app:') && APP_CONVERSATION_KEY_RE.test(raw.slice(4))) return raw;
  const telegram = /^telegram:([1-9][0-9]*)$/.exec(raw);
  if (telegram && Number.isSafeInteger(Number(telegram[1]))) return raw;
  const slack = parseCanonicalKey(raw);
  return slack && slack.workspaceId !== WORKSPACE_PLACEHOLDER ? raw : null;
}

/** Absent context is legacy data; callers distinguish that from an invalid supplied object. */
export function validateAppCreationContext(raw: unknown): AppCreationContext | null {
  const r = record(raw);
  if (!r || r.v !== 1 || !exactKeys(r, ['v', 'source', 'parentConversationKey', 'parentBasis'])) return null;
  const s = record(r.source);
  if (!s || !exactKeys(s, ['kind', 'cardId', 'requestId', 'originMachineId', 'sourceConversationKey', 'projectKey'])) return null;
  if (s.kind !== 'person' && s.kind !== 'work-board-card' && s.kind !== 'session') return null;
  if (s.kind === 'work-board-card' ? typeof s.cardId !== 'string' || !/^wc_[0-9a-f]{16}$/.test(s.cardId) : s.cardId !== undefined) return null;
  if (s.kind === 'session' ? !bounded(s.requestId, 128) : s.requestId !== undefined) return null;
  for (const key of ['originMachineId', 'sourceConversationKey', 'projectKey'] as const) if (s[key] !== undefined && !bounded(s[key], 256)) return null;
  if (r.parentBasis !== undefined && r.parentBasis !== 'explicit' && r.parentBasis !== 'source' && r.parentBasis !== 'project') return null;
  let parent: string | null | undefined;
  if (Object.hasOwn(r, 'parentConversationKey')) {
    parent = r.parentConversationKey === null ? null : normalizeCreationParentRef(r.parentConversationKey);
    if (r.parentConversationKey !== null && parent === null) return null;
  }
  return {
    v: 1,
    source: {
      kind: s.kind,
      ...(s.cardId !== undefined ? { cardId: s.cardId as string } : {}),
      ...(s.requestId !== undefined ? { requestId: s.requestId as string } : {}),
      ...(s.originMachineId !== undefined ? { originMachineId: s.originMachineId as string } : {}),
      ...(s.sourceConversationKey !== undefined ? { sourceConversationKey: s.sourceConversationKey as string } : {}),
      ...(s.projectKey !== undefined ? { projectKey: s.projectKey as string } : {}),
    },
    ...(parent !== undefined ? { parentConversationKey: parent } : {}),
    ...(r.parentBasis !== undefined ? { parentBasis: r.parentBasis as AppCreationContext['parentBasis'] } : {}),
  };
}

export function compareCreatedEvidence(a: Pick<CreatedEvent, 'at' | 'machineId' | 'eventId'>, b: Pick<CreatedEvent, 'at' | 'machineId' | 'eventId'>): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** Excludes optional context and local ingest metadata, so stripped copies share one base identity. */
export function creationBaseDigest(event: CreatedEvent): string {
  return crypto.createHash('sha256').update('instar.app-created-base.v1\n').update(JSON.stringify([
    canonicalConversationKey(event.conversationKey), event.eventId, 'created', event.title, event.at, event.machineId,
    event.ownerPerson ? [event.ownerPerson.machineId, event.ownerPerson.userId] : null,
  ])).digest('hex');
}

export function creationContextDigest(context: AppCreationContext): string {
  const s = context.source;
  return crypto.createHash('sha256').update('instar.app-creation-context.v1\n').update(JSON.stringify([
    1, s.kind, s.cardId ?? null, s.requestId ?? null, s.originMachineId ?? null, s.sourceConversationKey ?? null, s.projectKey ?? null,
    Object.hasOwn(context, 'parentConversationKey'), context.parentConversationKey ?? null, context.parentBasis ?? null,
  ])).digest('hex');
}
