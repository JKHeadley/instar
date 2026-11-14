/**
 * The first list of recommended services (docs/specs/recommended-services.md, Offers): which rows go in it,
 * the words, and the buttons. Pure, so every machine and every test reaches the same list from the same
 * facts. Sending and recording live in the routes.
 *
 * A row is offered when the service is available, the owner has made no choice, no legacy decline stands,
 * it has never been offered to this owner, and it is not already in use on this machine. Silence after an
 * offer is never a yes or a no: the row stays `offered` and is not sent again.
 */
import crypto from 'node:crypto';
import type { CatalogRow } from './catalog.js';
import { isServiceAvailable } from './catalog.js';
import type { EffectiveChoice, OfferState } from './RecommendedServicesLedger.js';

export interface OfferCandidateFacts {
  choice: EffectiveChoice;
  offer: OfferState;
  /** `verify` passed on this machine with the choice unset: a fact about this machine, never a choice. */
  inUse: boolean;
}

/** The rows that belong in the next list, in catalog order. */
export function offerCandidates(catalog: readonly CatalogRow[], facts: (row: CatalogRow) => OfferCandidateFacts): CatalogRow[] {
  return catalog.filter((row) => {
    if (!isServiceAvailable(row)) return false;
    const f = facts(row);
    return f.choice.choice === 'unset' && !f.choice.legacyDeclined && f.offer === 'none' && !f.inUse;
  });
}

/** callback_data: `rs:n:<nonce>` (a no: S-class, less action) and `rs:y:<nonce>` (a yes for an address service: owner-only, P-class). */
export const OFFER_TAP_RE = /^rs:([ny]):([0-9a-f]{32})$/;

export interface OfferTap {
  nonce: string;
  service: string;
  action: 'no' | 'yes';
  listId: string;
  expiresAt: number;
}

/** Taps stay valid this long. A list the person comes back to a month later still works from the dashboard. */
export const OFFER_TAP_TTL_MS = 30 * 24 * 60 * 60_000;

export function newOfferNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export interface RenderedOfferList {
  text: string;
  buttons: Array<{ text: string; data: string }>;
  taps: OfferTap[];
}

/**
 * One message. Each row: the name, the benefit, what leaves the machine, the cost, the account, and what the
 * agent falls back on without it. A yes goes through the confirm page (the PIN is the proof today), so the
 * message carries that link; the only yes button is for an address service, because an owner with no
 * address has no way to open a page (spec, Yes: "Reaching the page").
 */
export function renderOfferList(rows: readonly CatalogRow[], opts: { listId: string; linkBase: string | null; hasAddress: boolean; now: number }): RenderedOfferList {
  const lines: string[] = [
    rows.length === 1
      ? 'One outside service would help me do my job better. Here is what it involves, so you can decide. Nothing happens until you say yes.'
      : `${rows.length} outside services would help me do my job better. Here is what each involves, so you can decide. Nothing happens until you say yes.`,
    '',
  ];
  const buttons: RenderedOfferList['buttons'] = [];
  const taps: OfferTap[] = [];
  rows.forEach((row, i) => {
    lines.push(`${i + 1}. ${row.name}`);
    lines.push(`   What you get: ${row.benefit}`);
    lines.push(`   What leaves this machine: ${row.dataLeaves}`);
    lines.push(`   Cost: ${row.cost}`);
    lines.push(`   Account: ${row.account}`);
    if (row.backup) lines.push(`   If you say no: ${row.backup}`);
    if (opts.linkBase) lines.push(`   Yes: ${opts.linkBase}/dashboard/service-yes?service=${encodeURIComponent(row.id)} (your PIN)`);
    else if (row.wayIn) lines.push('   Yes: the button below. It needs you, not me.');
    else lines.push('   Yes: open my dashboard once you have an address for me, and say yes there with your PIN.');
    lines.push('');
    const no = newOfferNonce();
    taps.push({ nonce: no, service: row.id, action: 'no', listId: opts.listId, expiresAt: opts.now + OFFER_TAP_TTL_MS });
    buttons.push({ text: `No to ${row.name}`, data: `rs:n:${no}` });
    if (row.wayIn && !opts.hasAddress) {
      const yes = newOfferNonce();
      taps.push({ nonce: yes, service: row.id, action: 'yes', listId: opts.listId, expiresAt: opts.now + OFFER_TAP_TTL_MS });
      buttons.push({ text: `Yes to ${row.name}`, data: `rs:y:${yes}` });
    }
  });
  lines.push('A no is final until there is a real reason to ask again, and I will say what it is. Not answering is fine too: the list stays on my dashboard.');
  return { text: lines.join('\n'), buttons, taps };
}

export function newListId(): string {
  return crypto.randomBytes(16).toString('hex');
}
