/**
 * RelationshipIndex — what is connected to one conversation (docs/specs/work-front-doors.md §4).
 *
 * A DERIVED, pointer-only view rebuilt from the authoritative stores on read: the conversation graph
 * (placement), the work board (cards), the Chief of Staff (bound projects and their tree), commitments
 * and the people named on cards. It owns no state of its own and never writes to a source, so rebuilding
 * it can never change source authority (§4.2). Every machine derives it from its own replicas (§4.5).
 *
 * The agent's read is scoped to the conversation's LEAST-PRIVILEGED AUDIENCE (§4.3, hierarchy v3
 * decision 8): a neighbour is included only when EVERY current reader of the conversation may read it,
 * both ends checked (§4.4). A project's name is shown only when the owner is the conversation's only
 * reader, so a session in a shared conversation is never handed owner-private names. When the audience
 * cannot be resolved (team access on but its record unreadable or behind), the read returns no names and
 * no neighbours and says so — the strict direction, never a guess.
 *
 * Each group says whether it is complete. A source that is off, unreadable, behind or cut by a ceiling is
 * named (`couldNotCheck`, `behind`, `cut`), never shown as a false zero (§4.2).
 *
 * Pure: every source is passed in, so each decision boundary is testable on both sides.
 */
import crypto from 'node:crypto';

/** A conversation key in the stores' shared form: `telegram:<topic>`, `app:<key>`, `slack:…`. */
export type ConversationKey = string;

export interface GraphPlacement {
  /** The effort this conversation sits inside (nearest effort in its primary path), or null. */
  effort: { id: string; title: string; frontDoor: ConversationKey | null } | null;
  /** Other conversations inside that same effort (siblings), already filtered by the graph's viewer. */
  siblings: Array<{ key: ConversationKey; title: string }>;
  /** True when the sibling list was paged (more exist). */
  siblingsTruncated: boolean;
}

export interface GraphRead {
  /** The graph revision this read consumed. */
  revision: string;
  /** Replication lag / event gap / missing evidence, as the graph read model reports them. */
  partialReasons: string[];
  /** The conversation's placement, or null when the graph does not hold it (unplaced or unknown). */
  placement: GraphPlacement | null;
}

export interface GraphSource {
  /**
   * Read the conversation as a viewer whose `mayView` is `visible` (the graph applies it before any
   * path, count or child). Throws when the graph is not ready, which the caller reports as unreadable.
   */
  read(key: ConversationKey, visible: (ref: { kind: 'effort' } | { kind: 'conversation'; key: ConversationKey }) => boolean): GraphRead;
}

export interface CardRow {
  cardId: string;
  /** The card's own conversation key (`app:<uuid>`). */
  conversationKey: ConversationKey;
  title: string;
  status: string;
  projectKey: ConversationKey | null;
  /** The conversation the card was made from (`made from`), when it was. */
  sourceConversationKey: ConversationKey | null;
  /** Who acts next: the agent, nobody, or a person key. */
  waitingOn: 'agent' | 'none' | { personKey: string };
  carrier: 'agent' | { personKey: string };
}

export interface CardSource {
  /** The newest record clock the board consumed (its source version). */
  version: string;
  /** Set when this machine has not yet heard from a machine that wrote cards. */
  behind: { machineId: string; since: string } | null;
  cards(): CardRow[];
}

export interface ProjectSource {
  /** Bound projects; null when the Chief of Staff union cannot be read ("could not check"). */
  projects(): Array<{ conversationKey: ConversationKey; title: string }> | null;
  /** The Chief of Staff tree: conversation → its parent conversation. */
  parentOf(key: ConversationKey): ConversationKey | null;
}

export interface CommitmentRow {
  id: string;
  originMachineId: string;
  topicId: number | null;
  status: string;
  /** What the agent said it would do. */
  text: string;
  /** Replica rows only: how old the copy is. */
  stalenessMs?: number;
}

export interface CommitmentSource {
  rows(): CommitmentRow[];
}

/** Who may read the conversation now. */
export type Audience =
  | { kind: 'resolved'; ownerKey: string | null; readers: string[] }
  | { kind: 'unresolved'; reason: string };

export interface NeighbourhoodSources {
  graph: () => GraphSource | null;
  cards: () => CardSource | null;
  projects: () => ProjectSource | null;
  commitments: () => CommitmentSource | null;
  /** The conversation's current readers (owner included). */
  audience: (key: ConversationKey) => Audience;
  /** May this (non-owner) reader read that conversation? The stores' own permission check. */
  mayRead: (personKey: string, key: ConversationKey) => boolean;
  displayName: (personKey: string) => string;
}

/**
 * Declared ceilings (§4.2, rules 55/60/61). Safety floors, not working sizes: each group is cut at its
 * ceiling and the cut is reported. `blockBytes` is the injected-context ceiling: the session-start and
 * per-prompt hooks share Claude Code's 9,000-character hook output limit with the topic history, so the
 * block takes a fifth of it by default and is configurable (`relationshipIndex.maxBlockBytes`).
 */
export interface NeighbourhoodCeilings {
  cards: number;
  related: number;
  commitments: number;
  people: number;
  blockBytes: number;
}

export const DEFAULT_CEILINGS: NeighbourhoodCeilings = { cards: 50, related: 30, commitments: 30, people: 20, blockBytes: 1800 };
/** The block can never be asked to be larger than the hook's whole output budget. */
export const HOOK_OUTPUT_LIMIT_CHARS = 9000;
/** The smallest block that can still hold its envelope, its intro and a "cut to fit" line. */
export const MIN_BLOCK_BYTES = 600;

export function resolveCeilings(cfg: { maxBlockBytes?: unknown } | undefined): NeighbourhoodCeilings {
  const raw = cfg?.maxBlockBytes;
  const blockBytes = typeof raw === 'number' && Number.isFinite(raw) && raw >= MIN_BLOCK_BYTES
    ? Math.min(Math.floor(raw), HOOK_OUTPUT_LIMIT_CHARS / 2)
    : DEFAULT_CEILINGS.blockBytes;
  return { ...DEFAULT_CEILINGS, blockBytes };
}

export interface Group<T> {
  items: T[];
  complete: boolean;
  /** Why the group is incomplete: a source off or unreadable, behind, or cut at its ceiling. */
  reasons: string[];
}

export interface Neighbourhood {
  conversation: ConversationKey;
  /** A digest of every source version consumed plus the audience: changes whenever any of them does. */
  revision: string;
  audience: { kind: 'owner-only' | 'shared' | 'unresolved'; readers: number; reason?: string };
  /** The project this conversation belongs to. `title` is null when the audience may not see it. */
  project: { key: ConversationKey | null; title: string | null; via: 'graph' | 'chief-of-staff' | 'self' } | null;
  /** When this conversation is itself a card's conversation. */
  isCard: { cardId: string; title: string } | null;
  cards: Group<{ cardId: string; title: string; status: string; turn: string; relation: 'in-project' | 'made-from-here' }>;
  related: Group<{ key: ConversationKey; title: string }>;
  commitments: Group<{ id: string; originMachineId: string; text: string }>;
  people: Group<{ personKey: string; name: string; role: string }>;
  sourceVersions: Record<string, string>;
  ceilings: NeighbourhoodCeilings;
  /** Sources that could not be read at all. */
  couldNotCheck: string[];
  complete: boolean;
}

const CLOSED_CARD = new Set(['done', 'archived', 'removed']);

/** Topic id of a telegram key, else null. */
export function topicOfKey(key: ConversationKey): number | null {
  const m = /^telegram:(-?\d{1,20})$/.exec(key);
  return m ? Number(m[1]) : null;
}

export function isConversationKey(key: unknown): key is ConversationKey {
  return typeof key === 'string' && /^(telegram:-?\d{1,20}|app:[A-Za-z0-9_.:-]{1,200}|slack:[A-Za-z0-9_.:-]{1,200})$/.test(key);
}

function group<T>(): Group<T> { return { items: [], complete: true, reasons: [] }; }
function cut<T>(g: Group<T>, max: number, label: string): void {
  if (g.items.length > max) { g.items = g.items.slice(0, max); g.complete = false; g.reasons.push(`cut at ${max} ${label}`); }
}
function incomplete<T>(g: Group<T>, reason: string): void { g.complete = false; if (!g.reasons.includes(reason)) g.reasons.push(reason); }

/** Derive one conversation's neighbourhood for its least-privileged audience. Never throws. */
export function deriveNeighbourhood(key: ConversationKey, src: NeighbourhoodSources, ceilings: NeighbourhoodCeilings = DEFAULT_CEILINGS): Neighbourhood {
  const couldNotCheck: string[] = [];
  const versions: Record<string, string> = {};
  const cards = group<Neighbourhood['cards']['items'][number]>();
  const related = group<Neighbourhood['related']['items'][number]>();
  const commitments = group<Neighbourhood['commitments']['items'][number]>();
  const people = group<Neighbourhood['people']['items'][number]>();

  let audience: Audience;
  try { audience = src.audience(key); } catch { audience = { kind: 'unresolved', reason: 'audience-unreadable' }; /* @silent-fallback-ok — the strict direction: an unreadable audience shows nothing */ }

  const finish = (project: Neighbourhood['project'], isCard: Neighbourhood['isCard'], aud: Neighbourhood['audience']): Neighbourhood => {
    // Over the content itself, not only the source versions: a late peer record, a status that changes with
    // time, a tree move, an edited promise, a renamed person or a grant that keeps the reader count all show.
    const revision = crypto.createHash('sha256').update(JSON.stringify({ key, aud, project, isCard, cards, related, commitments, people, couldNotCheck })).digest('hex').slice(0, 16);
    const complete = couldNotCheck.length === 0 && cards.complete && related.complete && commitments.complete && people.complete && aud.kind !== 'unresolved';
    return { conversation: key, revision, audience: aud, project, isCard, cards, related, commitments, people, sourceVersions: versions, ceilings, couldNotCheck, complete };
  };

  if (audience.kind === 'unresolved') {
    for (const g of [cards, related, commitments, people] as Group<unknown>[]) incomplete(g, 'audience-unresolved');
    return finish(null, null, { kind: 'unresolved', readers: 0, reason: audience.reason });
  }
  const ownerKey = audience.ownerKey;
  const others = audience.readers.filter((r) => r !== ownerKey);
  const ownerOnly = others.length === 0;
  const aud: Neighbourhood['audience'] = { kind: ownerOnly ? 'owner-only' : 'shared', readers: audience.readers.length };
  /** Both ends: may every reader of THIS conversation read that one? */
  const visible = (other: ConversationKey): boolean => {
    if (ownerOnly) return true;
    for (const r of others) {
      let ok = false;
      try { ok = src.mayRead(r, other); } catch { ok = false; /* @silent-fallback-ok — fail closed: an unanswerable check hides the neighbour */ }
      if (!ok) return false;
    }
    return true;
  };

  // ── Projects (Chief of Staff) ──
  let projectRows: Array<{ conversationKey: string; title: string }> | null = null;
  let projectSource: ProjectSource | null = null;
  try { projectSource = src.projects(); projectRows = projectSource ? projectSource.projects() : null; } catch { projectRows = null; }
  if (!projectSource) couldNotCheck.push('chief-of-staff (off)');
  else if (projectRows === null) couldNotCheck.push('chief-of-staff (unreadable)');
  const bound = new Map((projectRows ?? []).map((p) => [p.conversationKey, p.title] as const));
  versions['chief-of-staff'] = projectRows ? crypto.createHash('sha256').update(JSON.stringify([...bound].sort())).digest('hex').slice(0, 12) : 'none';

  // ── Graph placement ──
  let placement: GraphPlacement | null = null;
  let graph: GraphSource | null = null;
  try { graph = src.graph(); } catch { graph = null; }
  if (!graph) couldNotCheck.push('conversation graph (off)');
  else {
    try {
      const read = graph.read(key, (ref) => (ref.kind === 'effort' ? ownerOnly : visible(ref.key)));
      versions.graph = read.revision;
      placement = read.placement;
      for (const r of read.partialReasons) incomplete(related, `graph ${r}`);
    } catch { couldNotCheck.push('conversation graph (unreadable)'); incomplete(related, 'graph unreadable'); }
  }

  // The project: the graph's effort first (the one tree), else the nearest bound Chief of Staff project.
  let project: Neighbourhood['project'] = null;
  if (placement?.effort) {
    project = { key: placement.effort.frontDoor, title: ownerOnly ? placement.effort.title : null, via: 'graph' };
  } else if (bound.has(key)) {
    project = { key, title: ownerOnly ? bound.get(key) ?? null : null, via: 'self' };
  } else if (projectSource) {
    const seen = new Set<string>([key]);
    let at: string | null = null;
    try { at = projectSource.parentOf(key); } catch { at = null; }
    while (at && !seen.has(at)) {
      if (bound.has(at)) { project = { key: at, title: ownerOnly ? bound.get(at) ?? null : null, via: 'chief-of-staff' }; break; }
      seen.add(at);
      try { at = projectSource.parentOf(at); } catch { at = null; }
    }
  }
  // A project conversation a reader cannot read is not revealed at all: not its name, not its key, not
  // that it exists (§4.4). Its cards are then matched on nothing, so none leak through it either.
  if (project && project.key && !ownerOnly && !visible(project.key)) project = null;

  // ── Related conversations: siblings in the same effort, else the Chief of Staff tree's children/siblings ──
  if (placement) {
    for (const s of placement.siblings) if (s.key !== key && visible(s.key)) related.items.push({ key: s.key, title: s.title });
    if (placement.siblingsTruncated) incomplete(related, 'more in the graph than one page');
  }
  cut(related, ceilings.related, 'related conversations');

  // ── Cards ──
  let isCard: Neighbourhood['isCard'] = null;
  let cardSource: CardSource | null = null;
  try { cardSource = src.cards(); } catch { cardSource = null; }
  if (!cardSource) { couldNotCheck.push('work board (off)'); incomplete(cards, 'work board off'); }
  else {
    versions['work-board'] = cardSource.version;
    if (cardSource.behind) incomplete(cards, `behind ${cardSource.behind.machineId} since ${cardSource.behind.since}`);
    let rows: CardRow[] = [];
    try { rows = cardSource.cards(); } catch { couldNotCheck.push('work board (unreadable)'); incomplete(cards, 'work board unreadable'); }
    const projectKey = project?.key ?? null;
    const involved = new Map<string, Set<string>>();
    const note = (personKey: string, role: string) => { const s = involved.get(personKey) ?? new Set<string>(); s.add(role); involved.set(personKey, s); };
    for (const c of rows) {
      if (c.conversationKey === key) isCard = { cardId: c.cardId, title: c.title };
      if (CLOSED_CARD.has(c.status)) continue;
      const inProject = projectKey !== null && c.projectKey === projectKey;
      const madeHere = c.sourceConversationKey === key;
      if (!inProject && !madeHere) continue;
      if (!visible(c.conversationKey)) continue;
      const turn = c.waitingOn === 'agent' ? 'the agent' : c.waitingOn === 'none' ? 'nobody' : safeName(src, c.waitingOn.personKey);
      cards.items.push({ cardId: c.cardId, title: c.title, status: c.status, turn, relation: inProject ? 'in-project' : 'made-from-here' });
      if (typeof c.waitingOn === 'object') note(c.waitingOn.personKey, 'whose turn');
      if (typeof c.carrier === 'object') note(c.carrier.personKey, 'carrier');
    }
    cut(cards, ceilings.cards, 'cards');
    for (const [personKey, roles] of involved) people.items.push({ personKey, name: safeName(src, personKey), role: [...roles].sort().join(', ') });
    cut(people, ceilings.people, 'people');
  }

  // ── Commitments made in this conversation (joined on origin machine + id, never a bare id) ──
  const topic = topicOfKey(key);
  let commitmentSource: CommitmentSource | null = null;
  try { commitmentSource = src.commitments(); } catch { commitmentSource = null; }
  if (!commitmentSource) { couldNotCheck.push('commitments (off)'); incomplete(commitments, 'commitments off'); }
  else if (topic === null) {
    // Promises are recorded against Telegram topics only, so none can be listed here: say so, never a false zero.
    incomplete(commitments, 'promises are only linked to Telegram topics');
  } else {
    let rows: CommitmentRow[] = [];
    try { rows = commitmentSource.rows(); } catch { couldNotCheck.push('commitments (unreadable)'); incomplete(commitments, 'commitments unreadable'); }
    const seen = new Set<string>();
    let newestStale = 0;
    for (const r of rows) {
      if (r.topicId !== topic) continue;
      const id = `${r.originMachineId}::${r.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      commitments.items.push({ id: r.id, originMachineId: r.originMachineId, text: r.text });
      if (typeof r.stalenessMs === 'number') newestStale = Math.max(newestStale, r.stalenessMs);
    }
    versions.commitments = crypto.createHash('sha256').update([...seen].sort().join('|')).digest('hex').slice(0, 12);
    if (newestStale > 15 * 60_000) incomplete(commitments, `another machine's copy is ${Math.round(newestStale / 60_000)} min old`);
    cut(commitments, ceilings.commitments, 'commitments');
  }

  return finish(project, isCard, aud);
}

function safeName(src: NeighbourhoodSources, personKey: string): string {
  try { return src.displayName(personKey) || 'someone'; } catch { return 'someone'; /* @silent-fallback-ok — a name lookup that fails reads as "someone", never the key */ }
}

/** Neutralise text placed inside the block, so a title cannot close the envelope or open a fence. */
export function neutral(text: string, max = 120): string {
  const clean = String(text ?? '').replace(/[<>`]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The awareness block: labelled reference data, short prose, fitted under `ceilings.blockBytes` (UTF-8
 * bytes). Lines are added in priority order; anything that does not fit is counted in a closing
 * "Cut to fit" line. Returns '' when there is nothing to say.
 */
export function renderNeighbourhoodBlock(n: Neighbourhood): string {
  const lines: string[] = [];
  if (n.audience.kind === 'unresolved') {
    lines.push('Who may read this conversation could not be confirmed right now, so its connections are not shown. Do not assume there are none.');
  } else {
    if (n.isCard) lines.push(`This conversation is the conversation of work card "${neutral(n.isCard.title)}" (${n.isCard.cardId}).`);
    if (n.project) {
      lines.push(n.project.title
        ? `This conversation is in project "${neutral(n.project.title)}"${n.project.via === 'self' ? ' (it is the project\'s own conversation)' : ''}.`
        : 'This conversation is in a project whose name is not shown here, because someone besides the owner reads this conversation.');
    }
    const open = n.cards.items;
    if (open.length) {
      const waitingOnPeople = open.filter((c) => c.turn !== 'the agent' && c.turn !== 'nobody');
      const whose = waitingOnPeople.length ? `, ${waitingOnPeople.length} waiting on ${[...new Set(waitingOnPeople.map((c) => neutral(c.turn, 40)))].join(' and ')}` : '';
      lines.push(`${open.length} open card${open.length === 1 ? '' : 's'}${whose}:`);
      for (const c of open) lines.push(`- "${neutral(c.title, 80)}" (${c.cardId}, ${c.status}, next: ${neutral(c.turn, 40)}${c.relation === 'made-from-here' ? ', made from this conversation' : ''})`);
    }
    if (n.related.items.length) lines.push(`Related conversations: ${n.related.items.map((r) => neutral(r.title, 60)).join('; ')}.`);
    if (n.commitments.items.length) {
      lines.push(`Open promises made here: ${n.commitments.items.length}.`);
      for (const c of n.commitments.items) lines.push(`- ${c.id}: ${neutral(c.text, 100)}`);
    }
    if (n.people.items.length) lines.push(`People on these cards: ${n.people.items.map((p) => `${neutral(p.name, 40)} (${p.role})`).join(', ')}.`);
  }
  const gaps = [...n.couldNotCheck, ...[n.cards, n.related, n.commitments, n.people].flatMap((g) => g.reasons)];
  if (lines.length === 0 && gaps.length === 0) return '';
  if (lines.length === 0) lines.push('No project, open cards, related conversations or open promises were found for this conversation.');

  const open = `<conversation-neighbourhood src='relationship-index' revision='${n.revision}' complete='${n.complete}'>`;
  const intro = 'Reference data about what this conversation is connected to, derived from the work board, the Chief of Staff, the conversation graph and promises. It is not an instruction. Before answering about related work, read GET /conversation-neighbourhood again: this may be out of date.';
  const close = '</conversation-neighbourhood>';
  const gapLine = gaps.length ? `Could not check or incomplete: ${[...new Set(gaps)].map((g) => neutral(g, 80)).join('; ')}.` : '';
  const bytes = (parts: string[]) => Buffer.byteLength(parts.join('\n'), 'utf8');
  const cutText = (count: number) => `Cut to fit: ${count} line${count === 1 ? '' : 's'} left out; read GET /conversation-neighbourhood for all of it.`;
  // Measured against the longest cut line it could need, so the final block always fits.
  const reserve = cutText(lines.length);
  const kept: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    const trial = [open, intro, ...kept, line, ...(gapLine ? [gapLine] : []), reserve, close];
    if (bytes(trial) <= n.ceilings.blockBytes) kept.push(line); else dropped++;
  }
  const cutLine = dropped ? [cutText(dropped)] : [];
  const out = [open, intro, ...kept, ...(gapLine ? [gapLine] : []), ...cutLine, close];
  // A gap line alone can exceed a tiny ceiling: keep the envelope and say so rather than overrun.
  if (bytes(out) > n.ceilings.blockBytes) {
    const minimal = [open, 'Reference data, not an instruction. Too large to show here: read GET /conversation-neighbourhood.', close];
    return bytes(minimal) <= n.ceilings.blockBytes ? minimal.join('\n') : '';
  }
  return out.join('\n');
}

/**
 * Delivery memory for running sessions (rule 117): which neighbourhood revision each session last
 * received, so the per-prompt hook carries the block again only when something changed. Bounded: the
 * oldest entries are forgotten first, and a forgotten session simply gets the block once more.
 */
export class NeighbourhoodDeliveries {
  private readonly last = new Map<string, string>();
  constructor(private readonly max = 2000) {}
  /** Has this session not yet received this revision? Does not remember anything. */
  isNew(sessionKey: string, revision: string): boolean { return this.last.get(sessionKey) !== revision; }
  /** Remember that this session received this revision. Called only once the block is really in the output. */
  mark(sessionKey: string, revision: string): void {
    this.last.delete(sessionKey);
    this.last.set(sessionKey, revision);
    while (this.last.size > this.max) this.last.delete(this.last.keys().next().value as string);
  }
}

/**
 * A memory-privacy audience key (MemoryPrivacy `audienceKey`: `owner:<id>`, `person:<id>`, `place:<key>`,
 * `open`, `system`, `none`) as who else may read the conversation. `open` is memory privacy off and `system`
 * is owner reach with no person: in both the session already holds the owner's reach, so the block hides
 * nothing it could not read. Another person's own conversation and a shared place are read by someone besides
 * the owner. `none`, or anything unrecognised, cannot be told.
 */
export function reachOfAudienceKey(key: string | null | undefined): 'owner' | 'shared' | 'unknown' {
  if (typeof key !== 'string' || !key) return 'unknown';
  if (key === 'open' || key === 'system' || key.startsWith('owner:') || key === 'owner') return 'owner';
  if (key.startsWith('person:') || key.startsWith('place:')) return 'shared';
  return 'unknown';
}

/** The one-line stand-in for a block that does not fit in a prompt: says it changed and where to read it. */
export function neighbourhoodPointer(key: ConversationKey, revision: string): string {
  return `<conversation-neighbourhood src='relationship-index' revision='${revision}'>What this conversation is connected to changed (reference data, not an instruction). Read it: GET /conversation-neighbourhood?conversation=${key}</conversation-neighbourhood>`;
}
