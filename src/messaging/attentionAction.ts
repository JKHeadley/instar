/**
 * Every Ask Is Actionable (docs/STANDARDS-REGISTRY.md): anything brought to the
 * operator carries one tap that either acts or opens the exact place to act.
 *
 * This module is the ONE answer to "what can the operator tap for this attention
 * item?". GET /attention stamps its answer on every item (the console's shared
 * count reads it), and the Attention hub post turns it into an inline button. An
 * item it cannot answer for is not the operator's ask: the console reports it as
 * the agent's, and a hub post without a button is logged to
 * logs/attention-unactionable.jsonl so the producer can be fixed at the source.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A tap that opens one console place (hash path under /dashboard/console/). */
export interface AttentionOpenAction {
  kind: 'open';
  /** Console hash path, always starting with "#/". */
  href: string;
  /** The button words ("Open sign-in", "Review held replies"). */
  label: string;
}

export type AttentionAction = AttentionOpenAction;

interface ItemLike {
  id?: string;
  category?: string;
  title?: string;
  summary?: string;
  action?: unknown;
}

const HASH_RE = /^#\/[a-z0-9/_-]+(\?[A-Za-z0-9_.:%=&+-]*)?$/;

/** A producer-supplied action is honoured only when it is a plain console hash path. */
export function validAction(a: unknown): a is AttentionAction {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return x.kind === 'open' && typeof x.href === 'string' && HASH_RE.test(x.href)
    && typeof x.label === 'string' && x.label.trim().length > 0 && x.label.length <= 40;
}

const enc = (s: string) => encodeURIComponent(s);

/**
 * Category/id → the console page where the operator acts on it. First match wins.
 * Each rule names a place that exists (see dashboard/console/console.js NATIVE) and
 * passes `item=<id>` so the page can open the exact row.
 */
const RULES: Array<{ test: (cat: string, id: string, text: string) => boolean; href: (id: string) => string; label: string }> = [
  { test: (c, id) => /sign-?in|relogin|re-?auth|account-follow-me|credential-identity-drift|subscription/i.test(c) || /relogin|sign-?in|account-follow-me/i.test(id), href: (id) => `#/capacity/accounts?s=needs&item=${enc(id)}`, label: 'Open sign-in' },
  { test: (c, id) => /telegram-origin/i.test(c) || /^telegram-origin-held/.test(id), href: (id) => `#/people/messages?s=held&item=${enc(id)}`, label: 'Review held replies' },
  { test: (c, id) => /mandate|permission/i.test(c) || /^mandate/.test(id), href: (id) => `#/people/mandates?s=waiting&item=${enc(id)}`, label: 'Open approvals' },
  { test: (c, id) => /secret|password|credential/i.test(c) || /^secret-drop/.test(id), href: (id) => `#/people/secrets?s=waiting&item=${enc(id)}`, label: 'Open passwords' },
  { test: (c, id) => /pairing|threadline/i.test(c) || /^(a2a-|pairing)/.test(id), href: (id) => `#/people/agents?item=${enc(id)}`, label: 'Open agents' },
  { test: (c, id) => /^feedback/.test(id) || /feedback/i.test(c), href: (id) => `#/work/development?s=feedback&item=${enc(id)}`, label: 'Open feedback' },
  { test: (c, id) => /^(green-pr|local-verify|release-readiness)/.test(id), href: (id) => `#/work/development?s=shipping&item=${enc(id)}`, label: 'Open shipping' },
  { test: (c, id) => /guard|security/i.test(c) || /^guard-posture/.test(id), href: (id) => `#/settings/allowed?s=guards&item=${enc(id)}`, label: 'Open safety checks' },
  { test: (c, id) => /machine|split-brain|mesh|rope/i.test(c) || /^(machine-coherence|split-brain|mesh-)/.test(id), href: (id) => `#/capacity/machines?item=${enc(id)}`, label: 'Open machines' },
  { test: (c, id) => /^(dup-reconciler|standdown)/.test(id), href: (id) => `#/work/sessions?item=${enc(id)}`, label: 'Open sessions' },
];

/** The one tap for this attention item, or null when the operator has nothing to tap. */
export function attentionActionFor(item: ItemLike | null | undefined): AttentionAction | null {
  if (!item || typeof item.id !== 'string' || !item.id) return null;
  if (validAction(item.action)) return { kind: 'open', href: item.action.href, label: item.action.label };
  const cat = String(item.category || '');
  const text = `${item.title || ''} ${item.summary || ''}`;
  for (const r of RULES) if (r.test(cat, item.id, text)) return { kind: 'open', href: r.href(item.id), label: r.label };
  return null;
}

/** The absolute console URL for an action, or null without a public https base. */
export function consoleUrl(base: string | null | undefined, action: AttentionAction | null): string | null {
  if (!action || typeof base !== 'string') return null;
  const b = base.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/.test(b)) return null; // never localhost or plain http: the phone cannot open it
  if (/^https:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(b)) return null;
  return `${b}/dashboard/console/${action.href}`;
}

export interface UnactionablePost {
  id: string;
  category: string;
  priority: string;
  title: string;
  reason: 'no-action' | 'no-public-url' | 'button-refused' | 'peer-action-invalid';
}

/** One line per hub post that reached the operator with nothing to tap, so the producer can be fixed. */
export function recordUnactionablePost(logsDir: string | undefined, entry: UnactionablePost): void {
  if (!logsDir) return;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry, title: entry.title.slice(0, 200) });
    fs.appendFileSync(path.join(logsDir, 'attention-unactionable.jsonl'), line + '\n');
  } catch (err) {
    // Not silent: the post itself already went out; the audit line failing is reported here.
    console.warn(`[attention] could not record an unactionable post for ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Bounded memory of peer refusals already logged, so a polled pool read writes one line per bad action, not one per poll. */
const loggedPeerRefusals = new Set<string>();

/**
 * The one tap for an attention item that came from ANOTHER machine (GET /attention?scope=pool).
 * A peer's `action` is that machine's claim and is re-checked with the same validator as a
 * local producer's: only a plain console hash path survives. A peer on older code (no
 * `action` key) is stamped from the same rules as a local item; an explicit null stays null;
 * anything else gets no tap and is recorded in logs/attention-unactionable.jsonl.
 */
export function peerItemAction(item: ItemLike & { priority?: string } | null | undefined, logsDir: string | undefined): AttentionAction | null {
  if (!item || typeof item !== 'object') return null;
  if (!('action' in item)) return attentionActionFor(item);
  const a = item.action;
  if (a === null || a === undefined) return null;
  if (validAction(a)) return { kind: 'open', href: a.href, label: a.label };
  const id = typeof item.id === 'string' ? item.id : '';
  const key = `${id}\u0000${JSON.stringify(a).slice(0, 300)}`;
  if (!loggedPeerRefusals.has(key)) {
    if (loggedPeerRefusals.size >= 500) loggedPeerRefusals.clear();
    loggedPeerRefusals.add(key);
    recordUnactionablePost(logsDir, {
      id, category: String(item.category || ''), priority: String(item.priority || ''), title: String(item.title || ''), reason: 'peer-action-invalid',
    });
  }
  return null;
}
