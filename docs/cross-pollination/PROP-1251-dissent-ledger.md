# PROP-1251 — Dissent ledger: a one-command way to record doubt about an inherited claim, with the check that would settle it

Filed by Dawn's `instar-feature-parity` job (AUT-001-wo, 2026-10-01). This is a docs-only hand-off. Land it through `/instar-dev` + `/spec-converge`.

## Problem

Instar already tells agents that handoff notes are claims to verify. `src/templates/hooks/compaction-recovery.sh:173` says: "Handoff notes and previous session logs are CLAIMS TO VERIFY, not facts." That covers the agent that *believes* a claim. It does nothing for the agent that *doubts* one.

A session that doubts an inherited claim has three moves today:

1. Repeat the claim. This is free.
2. Carry it forward as "reported X, unverified". This is also free, and it records nothing about the doubt.
3. Re-run the whole investigation to contradict it. This is expensive.

Agreeing is always the cheapest move, so the doubt never gets written down. The next session inherits the same claim with the same hedge. It doesn't learn that someone disbelieved it, or why, or what 30-second check would settle it. Dawn watched five sessions in a row converge on a false login diagnosis this way. Each one hedged the claim, and none of them recorded the doubt.

Dawn fixed this with PROP-1027 (`dissent-ledger.py`). It adds a fourth move that costs the same as agreeing: one call, with no investigation owed. The `check` field is mandatory. A doubt without a falsifier gives the next session no way to settle it. With one, settling costs one command instead of one investigation.

On `JKHeadley/main` (e302bfabc), `git grep -nE "Dissent|doubt.?ledger|recordDoubt" -- src` returns nothing.

## Proposed change

1. Add `src/core/DissentLedger.ts`. It is an append-only JSONL store in the agent's state dir, where the latest row per id wins and torn lines are skipped:
   - `doubt({claim, why, check})` throws if any of the three is empty. Referents (file paths, branches, PROP and issue ids, handles, kebab identifiers, backticked spans) are pulled from the claim and the check.
   - `settle(id, {verdict: confirmed|refuted|stale, evidence})` requires evidence. It refuses to overwrite an existing settlement unless `force` is set. `openedTs` is carried forward unchanged, so a doubt's age stays honest.
   - `matchText(text)` and `banner(text)` return the open doubts that share a **referent** with the text. They match on referents, not on string similarity: in Dawn's measurement over 1,500 real session pairs, matching on ordinary words produced only false positives.
   - `stats()` reports the share of settled doubts that were refuted. A 0% refute rate over many doubts means the channel is recording politeness, not disagreement.
2. **Wire a consumer so this isn't advisory-only.** `/instar-dev` should pick the exact hook. The natural one is `compaction-recovery.sh` and the session-start handoff surface: run `banner(handoffText)` and print the result right after the "CLAIMS TO VERIFY" line, so each doubt shows up beside the claim it's about. The output is empty when nothing matches.
3. Expose `doubt` / `settle` / `list` through the CLI or an HTTP route, so an agent can record a doubt in one command.
4. Optional second step, matching Dawn's enforcement: a report or handoff gate that blocks when a session *touched* a doubted referent, left the doubt open, and still asserts the claim.

### Patch — new file `src/core/DissentLedger.ts`

```ts
/**
 * DissentLedger — a one-command way to record "I doubt this inherited claim",
 * together with the cheap check that would settle it.
 *
 * Why: a session that doubts a handoff claim has three moves today. It can
 * repeat the claim (free), carry it forward as "reported X, unverified" (free,
 * and records nothing about the doubt), or re-derive the investigation to
 * contradict it (expensive). Concurring is always cheapest, so doubt never
 * reaches the record, and the next session inherits the same claim with the
 * same hedge. This adds a fourth move at the price of concurring: one call, no
 * investigation owed — but `check` is mandatory, because a doubt without a
 * falsifier gives the next session no way to settle it.
 *
 * Consumers (so this is not advisory-only):
 *  - matchText(): given a handoff note or outgoing report, returns the open
 *    doubts that name the same referents (file, branch, PROP/issue id, handle),
 *    so a doubt surfaces BESIDE the claim it is about.
 *  - stats(): a 0% refuted share over many settled doubts means the channel is
 *    recording politeness, not disagreement.
 *
 * Storage: append-only JSONL, latest row per id wins. Append, not rewrite,
 * because a shared JSON file loses writes under many concurrent sessions, and a
 * doubt that silently vanishes reads as concurrence.
 *
 * Ported from Dawn's dissent-ledger.py (PROP-1027).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type DoubtVerdict = 'confirmed' | 'refuted' | 'stale';
export type DoubtStatus = 'open' | DoubtVerdict;
export const DOUBT_VERDICTS: readonly DoubtVerdict[] = ['confirmed', 'refuted', 'stale'] as const;

export interface DoubtSettlement {
  ts: string;
  verdict: DoubtVerdict;
  /** The command that was run and what it said. Required. */
  evidence: string;
  note?: string;
  sessionId?: string;
}

export interface DoubtRecord {
  id: string;
  /** Write time of this row; moves on settle. */
  ts: string;
  /** First-write time; carried forward unchanged so age stays honest. */
  openedTs: string;
  status: DoubtStatus;
  claim: string;
  why: string;
  /** The cheap check the doubting session did NOT run. */
  check: string;
  referents: string[];
  source: string;
  sessionId?: string;
  settled: DoubtSettlement | null;
}

export interface DoubtMatch extends DoubtRecord {
  sharedReferents: string[];
}

export interface DissentStats {
  total: number;
  byStatus: Record<string, number>;
  settleRate: number | null;
  refutedShareOfSettled: number | null;
  oldestOpen: string | null;
}

const REFERENT_PATTERNS: RegExp[] = [
  /\bPROP-\d+\b/g,
  /\b(?:feature|fix|chore|hotfix|agent|docs)\/[\w./-]+/g,
  /\b[\w./-]*\w+\.(?:py|ts|tsx|js|cjs|mjs|md|json|jsonl|sh|yml|yaml|sql)\b/g,
  /#\d{2,}\b/g,
  /@[A-Za-z_]\w{2,}/g,
  /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/g,
  /`([^`\n]{2,60})`/g,
];

/**
 * Distinctive referents in free text. Matching is by shared referent, never by
 * string similarity: ordinary English words only produce false positives.
 */
export function extractReferents(text: string): string[] {
  const out = new Set<string>();
  for (const rx of REFERENT_PATTERNS) {
    for (const m of text.matchAll(rx)) {
      const tok = (m[1] ?? m[0]).trim();
      if (tok.length >= 3) out.add(tok);
    }
  }
  return [...out].sort();
}

export class DissentLedger {
  private readonly file: string;

  constructor(stateDir: string, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(stateDir, 'dissent-ledger.jsonl');
  }

  /** Record a doubt. Throws if claim, why or check is empty. */
  doubt(input: {
    claim: string; why: string; check: string;
    referents?: string[]; source?: string; sessionId?: string;
  }): DoubtRecord {
    const claim = input.claim.trim();
    const why = input.why.trim();
    const check = input.check.trim();
    if (!claim) throw new Error('a doubt needs the claim it doubts');
    if (!why) throw new Error('why is required: what makes you doubt it');
    if (!check) {
      throw new Error('check is required: name the cheap check you did NOT run. '
        + 'A doubt without a falsifier gives the next session no way to settle it.');
    }
    const ts = this.now().toISOString();
    const refs = new Set([...extractReferents(`${claim} ${check}`), ...(input.referents ?? [])]);
    const rec: DoubtRecord = {
      id: 'dbt-' + crypto.createHash('sha256').update(`${claim}|${ts}`).digest('hex').slice(0, 10),
      ts, openedTs: ts, status: 'open', claim, why, check,
      referents: [...refs].sort(),
      source: input.source ?? 'manual',
      sessionId: input.sessionId,
      settled: null,
    };
    this.append(rec);
    return rec;
  }

  /** Settle an open doubt with evidence. `force` overwrites an earlier settlement. */
  settle(idOrPrefix: string, input: {
    verdict: DoubtVerdict; evidence: string; note?: string; sessionId?: string; force?: boolean;
  }): DoubtRecord {
    const rows = this.latest();
    const id = this.resolveId(idOrPrefix, rows);
    if (!id) throw new Error(`no single doubt matches '${idOrPrefix}'`);
    const cur = rows.get(id)!;
    if (cur.status !== 'open' && !input.force) {
      throw new Error(`${id} is already ${cur.status}`);
    }
    if (!DOUBT_VERDICTS.includes(input.verdict)) throw new Error(`bad verdict: ${input.verdict}`);
    const evidence = input.evidence.trim();
    if (!evidence) {
      throw new Error('evidence is required: the command you ran and what it said. '
        + 'Settling without evidence recreates the trap in the other direction.');
    }
    const ts = this.now().toISOString();
    const rec: DoubtRecord = {
      ...cur, ts, openedTs: cur.openedTs || cur.ts, status: input.verdict,
      settled: { ts, verdict: input.verdict, evidence, note: input.note?.trim() || undefined, sessionId: input.sessionId },
    };
    this.append(rec);
    return rec;
  }

  /** Latest row per id. Torn or malformed lines are skipped, never fatal. */
  latest(): Map<string, DoubtRecord> {
    const rows = new Map<string, DoubtRecord>();
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return rows; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as DoubtRecord;
        if (r && typeof r.id === 'string') rows.set(r.id, r);
      } catch { /* torn line from a concurrent writer */ }
    }
    return rows;
  }

  openDoubts(): DoubtRecord[] {
    return [...this.latest().values()].filter(r => r.status === 'open');
  }

  /** Open doubts that share at least one referent with `text`, oldest first. */
  matchText(text: string): DoubtMatch[] {
    const tRefs = new Set(extractReferents(text).map(r => r.toLowerCase()));
    if (tRefs.size === 0) return [];
    const hits: DoubtMatch[] = [];
    for (const d of this.openDoubts()) {
      const shared = d.referents.map(r => r.toLowerCase()).filter(r => tRefs.has(r));
      if (shared.length) hits.push({ ...d, sharedReferents: [...new Set(shared)].sort() });
    }
    return hits.sort((a, b) => a.openedTs.localeCompare(b.openedTs));
  }

  /** One block for a session-start / compaction-recovery hook. Empty string when nothing matches. */
  banner(text: string): string {
    const hits = this.matchText(text);
    if (!hits.length) return '';
    const lines = [`⚖️  ${hits.length} OPEN DOUBT(S) about claims in this handoff:`];
    for (const h of hits) {
      lines.push(`  ${h.id} — "${h.claim.slice(0, 140)}"`);
      lines.push(`    why:   ${h.why.slice(0, 140)}`);
      lines.push(`    check: ${h.check.slice(0, 140)}`);
    }
    lines.push('  Run the check and settle it (verdict + evidence) before repeating the claim.');
    return lines.join('\n');
  }

  stats(): DissentStats {
    const items = [...this.latest().values()];
    const byStatus: Record<string, number> = {};
    for (const r of items) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const settled = items.filter(r => r.settled).length;
    const open = items.filter(r => r.status === 'open').map(r => r.openedTs).sort();
    return {
      total: items.length,
      byStatus,
      settleRate: items.length ? Math.round((settled / items.length) * 1000) / 1000 : null,
      refutedShareOfSettled: settled ? Math.round(((byStatus.refuted ?? 0) / settled) * 1000) / 1000 : null,
      oldestOpen: open[0] ?? null,
    };
  }

  private resolveId(prefix: string, rows: Map<string, DoubtRecord>): string | null {
    if (rows.has(prefix)) return prefix;
    const c = [...rows.keys()].filter(k => k.startsWith(prefix));
    return c.length === 1 ? c[0] : null;
  }

  private append(rec: DoubtRecord): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
  }
}
```

### Patch — new file `tests/unit/dissent-ledger.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DissentLedger, extractReferents } from '../../src/core/DissentLedger.js';

let dir: string;
let t: number;
const clock = () => new Date(t);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dissent-'));
  t = Date.parse('2026-10-01T12:00:00Z');
});

const sample = { claim: 'feature/prop-42 is merged', why: 'watchdog still lists it 3 ahead', check: 'git branch --merged main | grep prop-42' };

describe('DissentLedger', () => {
  it('records a doubt with referents from claim and check', () => {
    const d = new DissentLedger(dir, clock).doubt(sample);
    expect(d.status).toBe('open');
    expect(d.referents).toContain('feature/prop-42');
  });

  it('refuses a doubt with no check', () => {
    expect(() => new DissentLedger(dir, clock).doubt({ ...sample, check: '  ' })).toThrow(/check is required/);
  });

  it('refuses a doubt with no why', () => {
    expect(() => new DissentLedger(dir, clock).doubt({ ...sample, why: '' })).toThrow(/why is required/);
  });

  it('matches handoff text by shared referent, not by ordinary words', () => {
    const l = new DissentLedger(dir, clock);
    l.doubt(sample);
    expect(l.matchText('Handoff: feature/prop-42 landed yesterday.')).toHaveLength(1);
    expect(l.matchText('The branch is merged and everything landed.')).toHaveLength(0);
  });

  it('settled doubts stop surfacing and keep openedTs', () => {
    const l = new DissentLedger(dir, clock);
    const d = l.doubt(sample);
    t += 3_600_000;
    const s = l.settle(d.id.slice(0, 8), { verdict: 'refuted', evidence: 'git branch --merged main → no prop-42' });
    expect(s.openedTs).toBe(d.openedTs);
    expect(s.ts).not.toBe(d.ts);
    expect(l.matchText('feature/prop-42')).toHaveLength(0);
  });

  it('refuses to settle without evidence, or twice without force', () => {
    const l = new DissentLedger(dir, clock);
    const d = l.doubt(sample);
    expect(() => l.settle(d.id, { verdict: 'confirmed', evidence: '' })).toThrow(/evidence is required/);
    l.settle(d.id, { verdict: 'confirmed', evidence: 'ran it, merged' });
    expect(() => l.settle(d.id, { verdict: 'refuted', evidence: 'x' })).toThrow(/already confirmed/);
    expect(l.settle(d.id, { verdict: 'refuted', evidence: 'x', force: true }).status).toBe('refuted');
  });

  it('survives a torn line from a concurrent writer', () => {
    const l = new DissentLedger(dir, clock);
    l.doubt(sample);
    fs.appendFileSync(path.join(dir, 'dissent-ledger.jsonl'), '{"id":"dbt-torn');
    expect(l.openDoubts()).toHaveLength(1);
  });

  it('banner is empty when nothing matches and names the check when something does', () => {
    const l = new DissentLedger(dir, clock);
    expect(l.banner('feature/prop-42')).toBe('');
    l.doubt(sample);
    expect(l.banner('feature/prop-42 merged')).toContain('git branch --merged main');
  });

  it('stats reports refuted share of settled', () => {
    const l = new DissentLedger(dir, clock);
    const a = l.doubt(sample);
    t += 1000;
    l.doubt({ ...sample, claim: 'src/x.ts has no callers' });
    l.settle(a.id, { verdict: 'refuted', evidence: 'checked' });
    const s = l.stats();
    expect(s.total).toBe(2);
    expect(s.refutedShareOfSettled).toBe(1);
    expect(s.settleRate).toBe(0.5);
    expect(s.oldestOpen).not.toBeNull();
  });

  it('extractReferents ignores plain prose', () => {
    expect(extractReferents('the deploy is done and fine')).toEqual([]);
  });
});
```

## Test evidence

These ran in an isolated scratch tree with instar-main's `node_modules` symlinked in and a minimal vitest config. The repo's own globalSetup was not used, because its `tsc` step fails in that worktree.

- `vitest run tests/unit/dissent-ledger.test.ts` gave **10/10 pass**. The tests cover recording, refusing a doubt with no `check` or no `why`, matching by referent but not by prose, a settled doubt no longer surfacing with `openedTs` preserved, refusing to settle without evidence or to settle twice without `force`, tolerating torn lines, the banner being empty versus naming the check, stats, and referent extraction ignoring plain prose.
- **Can the suite fail?** I mutated the settle guard to `if (false)` and the run went to 1 failed / 9 passed (`refuses to settle without evidence, or twice without force`). Restoring it gave 10/10 again.
- `tsc --noEmit --strict --module nodenext --target es2022 --skipLibCheck --types node` on both files was **clean**, with exit 0 and no output.
- **Not run:** the hook wiring (step 2) and the CLI/route (step 3). Those are `/instar-dev`'s part.

## Files touched

- `src/core/DissentLedger.ts`: new. The ledger, referent extraction, matching, banner, and stats.
- `tests/unit/dissent-ledger.test.ts`: new. 10 unit tests.
- `src/templates/hooks/compaction-recovery.sh` (or the session-start handoff surface): print `banner()` beside "CLAIMS TO VERIFY". This is step 2, and the diff is left to `/instar-dev`.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "dissent ledger", citing this doc, and run `/spec-converge`. The open design question is which surface prints the banner, and whether the step-4 gate is in v1.
2. Apply the two new files above, then wire one consumer (step 2). Without a consumer this is a ledger nobody reads.
3. Run `/instar-dev` to produce the trace and side-effects artifact. The side effect is one new append-only file, `<stateDir>/dissent-ledger.jsonl`. It needs no migration.
4. Commit through the normal gate.
