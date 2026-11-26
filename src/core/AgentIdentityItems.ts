/**
 * AgentIdentityItems — raise / resolve for the agent-identity attention items
 * (a2a-single-agent-identity §1.1, §2.2) over a store that never forgets an id.
 *
 * The attention store answers a create for an id it has EVER seen with the existing row —
 * including a row that was resolved months ago — and never updates a body. Raised naively,
 * that makes three promised behaviours silently impossible:
 *   - a machine that adopts, loses its identity file and goes unprovisioned again could never
 *     re-raise `agent-identity-missing:*`;
 *   - the same pair of fingerprints splitting a second time (a superseded backup restored)
 *     would be silent for the life of the store;
 *   - "the open item always names the current refusal reason" could never change the text.
 *
 * So each logical item (the BASE id) is carried by one store row per EPISODE: the first
 * episode uses the base id itself, later ones `<base>#<n>`. Everything is derived from the
 * store on each call — no in-memory state — so a server restart neither loses an open episode
 * nor opens a duplicate one.
 */

export interface IdentityItemRow {
  id: string;
  status: string;
  description?: string;
}

export interface IdentityItemStore {
  /** Every row the store holds (any status). */
  list: () => IdentityItemRow[];
  /** Create a NEW row. Never called with an id the store already holds. */
  create: (item: { id: string; baseId: string; title: string; body: string; priority: string }) => void;
  /** Mark a row done, without notifying. */
  resolve: (id: string) => void;
}

const TERMINAL = new Set(['DONE', 'WONT_DO']);
const EPISODE_SUFFIX = /#\d+$/;

/** The base id a store row belongs to (`<base>` or `<base>#<n>`). */
export function identityItemBaseId(id: string): string {
  return id.replace(EPISODE_SUFFIX, '');
}

export type IdentityItemRaiseOutcome = 'created' | 'unchanged' | 'replaced';

export class IdentityAttentionItems {
  constructor(private readonly store: IdentityItemStore) {}

  private rowsFor(baseId: string): IdentityItemRow[] {
    return this.store.list().filter((r) => identityItemBaseId(r.id) === baseId);
  }

  /**
   * Raise the item for `baseId`. An open row with the same body is left alone (one item per
   * episode); an open row with a DIFFERENT body is closed and replaced so the open item
   * always carries the current text; with no open row a new episode is created.
   */
  raise(item: { id: string; title: string; body: string; priority: string }): { outcome: IdentityItemRaiseOutcome; id: string } {
    const rows = this.rowsFor(item.id);
    const open = rows.filter((r) => !TERMINAL.has(r.status));
    const same = open.find((r) => (r.description ?? '') === item.body);
    if (same) return { outcome: 'unchanged', id: same.id };
    // The operator's explicit "won't do" on this exact text stands: the same item is not
    // raised again (a restart would otherwise re-post it once per boot while the state lasts).
    // A changed text is a new fact and is raised.
    const dismissed = rows.find((r) => r.status === 'WONT_DO' && (r.description ?? '') === item.body);
    if (dismissed && open.length === 0) return { outcome: 'unchanged', id: dismissed.id };
    for (const r of open) this.store.resolve(r.id);
    const taken = new Set(rows.map((r) => r.id));
    let id = item.id;
    for (let n = 2; taken.has(id); n++) id = `${item.id}#${n}`;
    this.store.create({ id, baseId: item.id, title: item.title, body: item.body, priority: item.priority });
    return { outcome: open.length ? 'replaced' : 'created', id };
  }

  /**
   * Resolve every open row of `baseId`. Returns how many were closed. The condition is over,
   * so an operator's WONT_DO on it is retired too (flipped to DONE): a dismissal stands only
   * while the condition it dismissed lasts, and a later recurrence with the same text is raised.
   */
  resolve(baseId: string): number {
    const rows = this.rowsFor(baseId);
    const open = rows.filter((r) => !TERMINAL.has(r.status));
    for (const r of open) this.store.resolve(r.id);
    for (const r of rows) if (r.status === 'WONT_DO') this.store.resolve(r.id);
    return open.length;
  }

  /**
   * Base ids under `prefix` whose condition may still be live: an OPEN row, or a WONT_DO row
   * (dismissed, but the condition is not known to have cleared). A restarted detector
   * re-adopts both — a dismissed item is not raised again, but it IS retired when its
   * condition clears, so a later recurrence is raised.
   */
  openBaseIds(prefix: string): string[] {
    const out = new Set<string>();
    for (const r of this.store.list()) {
      if ((!TERMINAL.has(r.status) || r.status === 'WONT_DO') && r.id.startsWith(prefix)) out.add(identityItemBaseId(r.id));
    }
    return [...out];
  }
}
