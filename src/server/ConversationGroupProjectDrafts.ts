/**
 * "Make this group a project" (docs/specs/conversation-groups-phone.md §3).
 *
 * The owner asks, on a group (an effort), for it to become a Chief of Staff project. The agent DRAFTS the
 * binding here: a goal from the group's title, one owner-confirmed done item, and the bound conversation (the
 * group's front door, else its first conversation the Chief of Staff can track). The owner's own words (goal,
 * done items, repos) replace the drafted ones. What the conversations are about is returned BESIDE the draft as
 * display-only context: conversation text (which other people may have written) never becomes the goal or the
 * linked repos unless the owner types it in.
 *
 * A draft is self-certifying and stored nowhere: its hash is canonicalHash(draft) and its id is derived from the
 * hash. The phone carries the draft back with its confirm, so ANY machine can verify it (posture: unified). The
 * owner confirms from the phone with Face ID over `group-project-confirm <draftId> <draftHash>`
 * (mobilePermissionsRoutes.ts); only then does confirmGroupProjectDraft re-read the group (it still exists, has
 * the same name, and still holds the chosen conversation), check the Chief of Staff's bound projects with a read
 * that fails closed, and call ChiefOfStaffLoop.bindProject: the same write the dashboard's PIN-gated
 * POST /chief-of-staff/projects makes. A binding is written ONLY by an owner tap.
 */
import { canonicalHash, exactFields } from '../core/GraphWitnessTypes.js';
import { validateNodeRef, type ConversationRef, type EffortRef } from '../core/conversationGraph.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const GROUP_PROJECT_DRAFT_ID = /^gpd-[0-9a-f]{20}$/;
/** How long a drafted proposal stays signable. The confirm re-checks the group itself, so this only bounds a stale screen. */
export const GROUP_PROJECT_DRAFT_TTL_MS = 60 * 60_000;
/** The Chief of Staff store's own limits (ChiefOfStaffStore.ts): the phone may send what the dashboard may. */
export const GROUP_PROJECT_LIMITS = { goal: 4000, doneItems: 64, doneText: 2000, repos: 16 } as const;
const REPO = /^[\w.-]{1,64}\/[\w.-]{1,100}$/;

export interface GroupProjectDoneItem { id: string; kind: 'judgment'; text: string; certify: 'owner-confirms' }
export interface GroupProjectBinding {
  conversationKey: string;
  goal: string;
  doneDefinition: GroupProjectDoneItem[];
  linked: { repos: string[]; branches: string[]; domains: string[] };
}
/** Exactly what the owner's Face ID confirms (hashed with canonicalHash: sorted-key JSON, SHA-256). */
export interface GroupProjectDraft {
  v: 2;
  group: { ref: EffortRef; title: string };
  conversation: ConversationRef;
  binding: GroupProjectBinding;
  expiresAt: string;
}

/** A Chief of Staff conversation key for a graph conversation ("telegram:<topic>" or "app:<key>"), or null. */
export function cosConversationKey(ref: ConversationRef, telegramChatId: string): string | null {
  const r = ref as unknown as Record<string, unknown>;
  if (r.platform === 'telegram' && Number.isSafeInteger(r.topicId) && (r.topicId as number) > 1 && telegramChatId && String(r.chatId) === telegramChatId) return `telegram:${r.topicId}`;
  if (r.platform === 'app' && typeof r.conversationKey === 'string' && /^[A-Za-z0-9_.:-]{1,123}$/.test(r.conversationKey)) return `app:${r.conversationKey}`;
  return null;
}

const REPO_RE = /\bgithub\.com\/([\w.-]{1,64}\/[\w.-]{1,100})|\b([\w.-]{1,64}\/[\w.-]{1,100})#\d+/g;
/** Repos the conversations name outright (a github.com link or owner/repo#123). Shown as suggestions only. */
export function inferRepos(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(REPO_RE)) {
      const repo = (m[1] ?? m[2] ?? '').replace(/\.git$/, '').replace(/[.]+$/, '');
      if (REPO.test(repo)) out.add(repo);
      if (out.size >= GROUP_PROJECT_LIMITS.repos) return [...out];
    }
  }
  return [...out];
}

/**
 * Characters the phone cannot show faithfully, so what is shown could differ from what is bound: every control and
 * format character (bidi controls, zero-width characters, invisible joiners, tag characters, soft hyphen), the
 * Mongolian vowel separator, the combining grapheme joiner and variation selectors. Whitespace runs (line breaks
 * included) collapse to one space first, so words never join.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\u034F\u180E\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
export const cleanDraftText = (s: string, max: number): string => s.replace(/\s+/g, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim().slice(0, max);
const clean = cleanDraftText;
/** True when the text is exactly what clean() would produce: no control, invisible or doubled whitespace. */
const isClean = (s: string, max: number): boolean => s === clean(s, max);

/** What the conversations are about, for the owner to read beside the draft. Never part of the binding. */
export function groupProjectContext(members: ConversationRef[], evidence: (ref: ConversationRef) => string): { about: string[]; suggestedRepos: string[]; conversationsNotShown: number } {
  const about: string[] = [];
  for (const m of members.slice(0, 8)) {
    let text = '';
    try { text = clean(evidence(m) ?? '', 300); } catch {
      DegradationReporter.getInstance().report({ feature: 'Conversations.groupProject', primary: 'What each conversation is about, shown beside the project draft',
        fallback: 'Show the draft without it', reason: 'group-project-evidence-unreadable', impact: 'The owner sees less about the conversations while deciding', internalOnly: true });
    }
    if (text) about.push(text);
  }
  // Said in band: the owner knows when the context covers only some of the group's conversations.
  return { about, suggestedRepos: inferRepos(about), conversationsNotShown: Math.max(0, members.length - 8) };
}

/** The drafted binding: the group's title, or the owner's own goal / done items / repos. */
export function buildGroupProjectBinding(input: { title: string; conversationKey: string; ownerGoal?: string; ownerDone?: string[]; ownerRepos?: string[] }): GroupProjectBinding {
  const title = clean(input.title || 'Untitled group', 200);
  const drafted = `${title}. This project tracks the work in the group "${title}" until the owner says it is finished.`;
  const goal = clean(input.ownerGoal && input.ownerGoal.trim() ? input.ownerGoal : drafted, GROUP_PROJECT_LIMITS.goal);
  const doneTexts = (input.ownerDone ?? []).map((t) => clean(String(t), GROUP_PROJECT_LIMITS.doneText)).filter(Boolean).slice(0, GROUP_PROJECT_LIMITS.doneItems);
  const doneDefinition: GroupProjectDoneItem[] = (doneTexts.length ? doneTexts : [`The work in the group "${title}" is finished, and the owner says so.`])
    .map((text, i) => ({ id: `group-done-${i + 1}`, kind: 'judgment', text, certify: 'owner-confirms' }));
  const repos = [...new Set((input.ownerRepos ?? []).filter((r) => REPO.test(r)))].slice(0, GROUP_PROJECT_LIMITS.repos);
  return { conversationKey: input.conversationKey, goal, doneDefinition, linked: { repos, branches: [], domains: [] } };
}

export const groupProjectDraftHash = (draft: GroupProjectDraft): string => canonicalHash(draft);
export const groupProjectDraftId = (hash: string): string => `gpd-${hash.slice(0, 20)}`;

export function makeGroupProjectDraft(input: { group: { ref: EffortRef; title: string }; conversation: ConversationRef; binding: GroupProjectBinding; now: number }): { draft: GroupProjectDraft; draftHash: string; draftId: string } {
  const draft: GroupProjectDraft = { v: 2, group: input.group, conversation: input.conversation, binding: input.binding, expiresAt: new Date(input.now + GROUP_PROJECT_DRAFT_TTL_MS).toISOString() };
  const draftHash = groupProjectDraftHash(draft);
  return { draft, draftHash, draftId: groupProjectDraftId(draftHash) };
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** The draft a phone carried back, shape-checked to the limits a drafted one has; null when malformed. */
export function parseCarriedDraft(raw: unknown): GroupProjectDraft | null {
  if (!exactFields(raw, ['v', 'group', 'conversation', 'binding', 'expiresAt'])) return null;
  const d = raw as Record<string, unknown>;
  if (d.v !== 2 || !str(d.expiresAt, 40) || !Number.isFinite(Date.parse(d.expiresAt as string))) return null;
  if (!exactFields(d.group, ['ref', 'title'])) return null;
  const g = d.group as Record<string, unknown>;
  const groupRef = validateNodeRef(g.ref);
  if (groupRef?.kind !== 'effort' || !str(g.title, 200) || !isClean(g.title as string, 200)) return null;
  const conv = validateNodeRef(d.conversation);
  if (conv?.kind !== 'conversation') return null;
  if (!exactFields(d.binding, ['conversationKey', 'goal', 'doneDefinition', 'linked'])) return null;
  const b = d.binding as Record<string, unknown>;
  if (!str(b.conversationKey, 160) || !str(b.goal, GROUP_PROJECT_LIMITS.goal) || !isClean(b.goal as string, GROUP_PROJECT_LIMITS.goal)) return null;
  if (!Array.isArray(b.doneDefinition) || !b.doneDefinition.length || b.doneDefinition.length > GROUP_PROJECT_LIMITS.doneItems) return null;
  for (const it of b.doneDefinition) {
    if (!exactFields(it, ['id', 'kind', 'text', 'certify'])) return null;
    const i = it as Record<string, unknown>;
    if (!str(i.id, 64) || i.kind !== 'judgment' || !str(i.text, GROUP_PROJECT_LIMITS.doneText) || !isClean(i.text as string, GROUP_PROJECT_LIMITS.doneText) || i.certify !== 'owner-confirms') return null;
  }
  if (!exactFields(b.linked, ['repos', 'branches', 'domains'])) return null;
  const l = b.linked as Record<string, unknown>;
  if (!Array.isArray(l.repos) || l.repos.length > GROUP_PROJECT_LIMITS.repos || !l.repos.every((r) => typeof r === 'string' && REPO.test(r))) return null;
  if (!Array.isArray(l.branches) || l.branches.length || !Array.isArray(l.domains) || l.domains.length) return null;
  return raw as GroupProjectDraft;
}

/** The action line the owner's phone signs for a confirm (mobilePermissionsRoutes.ts actionLine). */
export const groupProjectConfirmLine = (draftId: string, draftHash: string): string => `group-project-confirm ${draftId} ${draftHash}`;

/**
 * The group as it is now, for the confirm's re-check; null when it is gone or hidden, 'unavailable' when the graph
 * did not answer. `holds` says whether the chosen conversation is still the front door or a member (read from the
 * conversation's own parent, so a group of any size answers correctly).
 */
export type GroupProjectGroupNow = { title: string; holds: boolean } | null | 'unavailable';

/** A stored binding as the confirm compares it: what a repeat tap of the same draft would have written. */
export interface BoundProjectContent { goal: string; doneDefinition: Array<{ id: string; kind: string; text: string; certify?: string }>; repos: string[] }
const contentHash = (c: BoundProjectContent): string => canonicalHash({
  goal: c.goal.trim(),
  done: c.doneDefinition.map((d) => ({ id: d.id, kind: d.kind, text: d.text, certify: d.certify ?? null })),
  repos: [...c.repos],
});

export interface GroupProjectConfirmDeps {
  telegramChatId: string;
  now(): number;
  /** Bound projects by conversation key; null when the Chief of Staff's journal could not be read (fail closed). */
  boundProjects(): Map<string, BoundProjectContent> | null;
  groupNow(ref: EffortRef, conversation: ConversationRef): GroupProjectGroupNow;
  bindProject(input: { conversationKey: string; goal: string; doneDefinition: GroupProjectDoneItem[]; linked: GroupProjectBinding['linked'] }): { ok: true; conversationKey: string } | { ok: false; reason: 'invalid-binding' | 'write-refused' };
}

const stale = (detail: string) => ({ status: 409, body: { error: 'draft-stale', detail } });

/**
 * The owner confirmed a draft (the caller has already proved the owner's phone and Face ID over
 * `group-project-confirm <draftId> <signedHash>`). Verifies the carried draft against that exact hash, re-checks
 * the group and the bound projects as they are NOW, and writes the binding through the Chief of Staff's own
 * bindProject. Answers in the phone's words.
 */
export function confirmGroupProjectDraft(deps: GroupProjectConfirmDeps, draftId: string, signedHash: string, carried: unknown): { status: number; body: Record<string, unknown> } {
  const draft = parseCarriedDraft(carried);
  if (!draft) return { status: 400, body: { error: 'invalid-draft', detail: 'The draft did not come through. Open it again.' } };
  const hash = groupProjectDraftHash(draft);
  if (hash !== signedHash || groupProjectDraftId(hash) !== draftId) return { status: 409, body: { error: 'draft-changed', detail: 'The draft changed since you looked at it. Open it again.' } };
  const now = deps.now(), expires = Date.parse(draft.expiresAt);
  if (expires <= now) return { status: 410, body: { error: 'draft-expired', detail: 'This draft is more than an hour old. Ask for a new one.' } };
  if (expires > now + GROUP_PROJECT_DRAFT_TTL_MS + 5 * 60_000) return { status: 400, body: { error: 'invalid-draft', detail: 'The draft did not come through. Open it again.' } };
  const key = draft.binding.conversationKey;
  if (cosConversationKey(draft.conversation, deps.telegramChatId) !== key) return { status: 400, body: { error: 'invalid-draft', detail: 'The draft did not come through. Open it again.' } };
  const bound = deps.boundProjects();
  if (!bound) return { status: 503, body: { error: 'could-not-check-projects', detail: 'The agent could not read its whole project history, so nothing was changed. Try again in a moment; if it keeps saying this, make the project from the dashboard and tell your agent.' } };
  const existing = bound.get(key);
  if (existing) {
    // A repeat tap of THIS draft: the stored binding is exactly what it would write (goal, done items, repos).
    const same = contentHash(existing) === contentHash({ goal: draft.binding.goal, doneDefinition: draft.binding.doneDefinition, repos: draft.binding.linked.repos });
    if (same) return { status: 200, body: { ok: true, alreadyConfirmed: true, conversationKey: key, group: draft.group } };
    return { status: 409, body: { error: 'already-a-project', conversationKey: key, detail: 'Its conversation is already a project.' } };
  }
  const group = deps.groupNow(draft.group.ref, draft.conversation);
  if (group === 'unavailable') return { status: 503, body: { error: 'conversation-graph-pending', detail: 'The agent could not check the group just now, so nothing was changed. Try again in a moment.' } };
  if (!group) return stale('This group was removed. Nothing was changed.');
  if (clean(group.title, 200) !== draft.group.title) return stale('This group was renamed since the draft. Open it again.');
  if (!group.holds) return stale('Its conversation is no longer in this group. Open it again.');
  const r = deps.bindProject({ conversationKey: key, goal: draft.binding.goal, doneDefinition: draft.binding.doneDefinition, linked: draft.binding.linked });
  if (!r.ok) return { status: r.reason === 'invalid-binding' ? 400 : 409, body: { error: r.reason, detail: 'The project was not created.' } };
  return { status: 201, body: { ok: true, conversationKey: r.conversationKey, group: draft.group } };
}

/**
 * Where the conversation graph surface puts the phone confirm once the graph is open (it needs the graph to
 * re-check the group). Null until then: the confirm route answers 503 conversation-graph-pending.
 */
export interface GroupProjectConfirmHolder {
  /** Set when the graph is open but owner changes are off here: the confirm answers a lasting refusal, not "try again". */
  off?: boolean;
  confirm: ((req: import('express').Request, draftId: string, draftHash: string, carried: unknown) => { status: number; body: Record<string, unknown> }) | null;
}
