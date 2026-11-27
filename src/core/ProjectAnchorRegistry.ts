import type { Initiative } from './InitiativeTracker.js';

export interface ProjectAnchorSourceMessage {
  conversationKey: string;
  messageId: string;
  at: string;
}

export interface ProjectAnchorHistoryReader {
  getVerifiedOwner(): number | undefined;
  findTopicMessage(topicId: number, messageId: number, notBefore: number): {
    entry: { fromUser?: boolean; forwarded?: boolean; telegramUserId?: number; timestamp: string; text: string } | null;
  };
}

export function readVerifiedProjectAnchorSource(history: ProjectAnchorHistoryReader | undefined, source: ProjectAnchorSourceMessage): string | undefined {
  const owner = history?.getVerifiedOwner();
  if (!history || owner === undefined) return undefined;
  const topic = Number(source.conversationKey.slice('telegram:'.length));
  const id = Number(source.messageId);
  const at = Date.parse(source.at);
  if (!Number.isSafeInteger(topic) || !Number.isSafeInteger(id) || !Number.isFinite(at)) return undefined;
  const row = history.findTopicMessage(topic, id, at).entry;
  if (row?.fromUser === true && row.forwarded === false && row.telegramUserId === owner &&
    Date.parse(row.timestamp) === at) return row.text;
}

export interface ApprovedProjectAnchor {
  revision: number;
  purpose: string;
  sourceMessages: ProjectAnchorSourceMessage[];
  done: Array<{ id: string; text: string; state: 'open' | 'done' }>;
  outOfScope: Array<{ text: string; ownedByProjectId?: string }>;
}

export interface ApprovedProjectAnchorRecord {
  conversationKey: string;
  approvedAt: string;
  anchor: ApprovedProjectAnchor;
}

const telegramKey = /^telegram:([1-9]\d*)$/;
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const knownFields = (value: object, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

export function isProjectAnchorSourceMessage(value: unknown): value is ProjectAnchorSourceMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !knownFields(value, ['conversationKey', 'messageId', 'at'])) return false;
  const source = value as Partial<ProjectAnchorSourceMessage>;
  return typeof source.conversationKey === 'string' && telegramKey.test(source.conversationKey) &&
    typeof source.messageId === 'string' && /^[1-9]\d{0,15}$/.test(source.messageId) &&
    typeof source.at === 'string' && Number.isFinite(Date.parse(source.at));
}

export function isValidProjectAnchor(value: unknown): value is ApprovedProjectAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !knownFields(value, ['revision', 'purpose', 'sourceMessages', 'done', 'outOfScope'])) return false;
  const anchor = value as Partial<ApprovedProjectAnchor>;
  if (!Number.isSafeInteger(anchor.revision) || (anchor.revision ?? 0) < 1 || typeof anchor.purpose !== 'string' || !anchor.purpose.trim()) return false;
  if (!Array.isArray(anchor.sourceMessages) || anchor.sourceMessages.length < 1 || anchor.sourceMessages.length > 8 ||
    !anchor.sourceMessages.every(isProjectAnchorSourceMessage)) return false;
  if (!Array.isArray(anchor.done) || anchor.done.length > 6 ||
    (anchor.done.length > 0 && anchor.purpose.length > 2000) ||
    !anchor.done.every((item) => item && typeof item === 'object' && knownFields(item, ['id', 'text', 'state']) &&
      text(item.id, 64) && text(item.text, 1000) && ['open', 'done'].includes(item.state)) ||
    new Set(anchor.done.map((item) => item.id)).size !== anchor.done.length) return false;
  return Array.isArray(anchor.outOfScope) && anchor.outOfScope.length <= 12 &&
    (anchor.done.length > 0 || (anchor.sourceMessages.length === 1 && anchor.outOfScope.length === 0)) &&
    anchor.outOfScope.every((item) => item && typeof item === 'object' && knownFields(item, ['text', 'ownedByProjectId']) &&
      text(item.text, 1000) && (item.ownedByProjectId === undefined || text(item.ownedByProjectId, 63)));
}

export function readRegistryApprovedProjectAnchor(project: Initiative, conversationKey: string): ApprovedProjectAnchor | null {
  if (project.kind !== 'project' || project.status !== 'active' ||
    conversationKey !== `telegram:${project.telegramTopicId}`) return null;
  const record = project.approvedProjectAnchor;
  if (!record || record.conversationKey !== conversationKey || !Number.isFinite(Date.parse(record.approvedAt))) return null;
  return isValidProjectAnchor(record.anchor) ? record.anchor : null;
}

export interface ProjectAnchorChange {
  projectId: string;
  revision: number | null;
  conversationKeys: string[];
}

export interface VerifiedProjectPurposeProposal {
  projectId: string;
  conversationKey: string;
  purpose: string;
  source: ProjectAnchorSourceMessage;
}

export type ProjectAnchorLookup =
  | { status: 'resolved'; projectId: string; anchor: ApprovedProjectAnchor }
  | { status: 'proposed'; projectId: string; purpose: string; source: ProjectAnchorSourceMessage }
  | { status: 'missing' }
  | { status: 'ambiguous' };

/** The approval reader is backed by the owner-approved registry revision.
 * Matching a topic alone gives no authority to treat the project description as approved.
 */
export function createProjectAnchorLookup(deps: {
  listProjects: () => readonly Initiative[];
  readApproved: (project: Initiative, conversationKey: string) => ApprovedProjectAnchor | null;
}) {
  return createStandingProjectAnchorLookup({ listProjects: deps.listProjects, readApproved: deps.readApproved });
}

/** Proposal text is available only to the caller that builds the destination's standing packet. */
export function createStandingProjectAnchorLookup(deps: {
  listProjects: () => readonly Initiative[];
  readApproved: (project: Initiative, conversationKey: string) => ApprovedProjectAnchor | null;
  readVerifiedProposal?: (project: Initiative, conversationKey: string) => VerifiedProjectPurposeProposal | null;
}) {
  return (conversationKey: string): ProjectAnchorLookup => {
    const match = telegramKey.exec(conversationKey);
    if (!match) return { status: 'missing' };
    const candidates = deps.listProjects().filter((project) =>
      project.kind === 'project' && project.telegramTopicId === match[1]);
    if (candidates.length > 1) return { status: 'ambiguous' };
    const project = candidates[0];
    if (!project || project.status !== 'active') return { status: 'missing' };
    const anchor = deps.readApproved(project, conversationKey);
    if (anchor) return { status: 'resolved', projectId: project.id, anchor };
    if (project.approvedProjectAnchor || (project.approvedProjectAnchorRevision ?? 0) > 0) return { status: 'missing' };
    const proposal = deps.readVerifiedProposal?.(project, conversationKey);
    if (!proposal || proposal.projectId !== project.id || proposal.conversationKey !== conversationKey ||
      !proposal.purpose.trim() || !isProjectAnchorSourceMessage(proposal.source)) return { status: 'missing' };
    return { status: 'proposed', projectId: project.id, purpose: proposal.purpose, source: proposal.source };
  };
}
