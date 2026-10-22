/**
 * Migration parity for the homebase awareness card.
 *
 * New agents get the card from the template; EXISTING agents only ever get it through the
 * migration, so a card with no migration is a feature only new agents have. The specific trap
 * this pins: the card was first nested under the pool-read guard's sniff string, which meant an
 * agent that had already received THAT card could never receive this one — the defect is
 * invisible unless a test asserts the two are independent.
 */
import { describe, it, expect } from 'vitest';
import { peerHomebaseAwareness } from '../../src/core/peerHomebaseAwareness.js';
import { poolReadSelectionAwareness } from '../../src/core/poolReadAwareness.js';

const SNIFF = 'per-peer homebase topic';

describe('homebase awareness card', () => {
  it('contains the sniff string the migration guards on', () => {
    expect(peerHomebaseAwareness()).toContain(SNIFF);
  });

  it('tells the agent the three things it would otherwise get wrong', () => {
    const card = peerHomebaseAwareness();
    // 1. the topic may not exist — an agent that assumes it does will mis-route
    expect(card).toMatch(/not guaranteed to exist/i);
    // 2. an operator binding wins, and an UNKNOWN one is preserved
    expect(card).toMatch(/operator.*always wins|always wins/i);
    expect(card).toMatch(/preserved/i);
    // 3. a peer's request notifies — it is not housekeeping
    expect(card).toMatch(/notifies/i);
  });

  it('keeps the authority boundary explicit — a peer in its own topic grants nothing', () => {
    expect(peerHomebaseAwareness()).toMatch(/information, never authorization/i);
  });

  it('names the accepted limits rather than implying completeness', () => {
    const card = peerHomebaseAwareness();
    expect(card).toMatch(/CMT-014/);
    expect(card).toMatch(/duplicate|backfill/i);
  });

  it('is INDEPENDENT of the pool-read card — neither sniff string appears in the other', () => {
    // The parity trap: if this card contained 'cgnat-plaintext-unsupported', or the pool-read
    // card contained this card's sniff string, one guard would suppress the other and an
    // existing agent would silently miss a card.
    expect(peerHomebaseAwareness()).not.toContain('cgnat-plaintext-unsupported');
    expect(poolReadSelectionAwareness()).not.toContain(SNIFF);
  });
});

describe('the migration wiring itself', () => {
  const src = () => import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../src/core/PostUpdateMigrator.ts', import.meta.url), 'utf-8'));

  it('guards the card on its OWN sniff string, not the pool-read one', async () => {
    const s = await src();
    expect(s).toContain(`if (!content.includes('${SNIFF}'))`);
    // and the pool-read guard no longer appends this card
    const poolGuard = s.slice(s.indexOf("if (!content.includes('cgnat-plaintext-unsupported'))"));
    const block = poolGuard.slice(0, poolGuard.indexOf('}'));
    expect(block).not.toContain('peerHomebaseAwareness');
  });

  it('is also in the template, so new agents get it at install', async () => {
    const fs = await import('node:fs');
    const t = fs.readFileSync(new URL('../../src/scaffold/templates.ts', import.meta.url), 'utf-8');
    expect(t).toContain('peerHomebaseAwareness()');
  });
});
