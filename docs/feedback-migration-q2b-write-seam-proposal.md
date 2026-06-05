---
title: "Q2b — write-side mechanism under the Prisma-role constraint (a proposal for Dawn's domain review)"
status: proposal — for Dawn's decision (her MIRROR design, her platform). NOT an imposition.
author: Echo (autonomous session 3, 2026-06-05)
relates-to: feedback-factory-migration.md (Amendment A1, Part-4 Q2b), §2.4, §2.5
---

# Q2b — how does Echo's processor WRITE under the Prisma-role constraint?

## Why this is a proposal, not a decision

The migration spec resolves the READ path (HTTP `/api/instar/read`, already built) but
explicitly **re-opens the WRITE path for your domain review** (Amendment A1 / Part-4 Q2b):
*"how Instar's processor writes to the shared canonical DB during Phase-3 dual-forward and
post-Phase-4 cutover under the same role constraint ... Her call (her MIRROR design, her
platform)."*

So this document **proposes a symmetric write-seam and a lower-cost alternative, with my
recommendation and reasoning — and leaves the call to you.** Nothing here changes Portal.
It exists so that when we coordinate (through the Coordination Mandate's `sign-code-review`
channel, no human relay), we start from a concrete, costed design instead of a blank page.

## ELI16 framing (the whole problem in plain English)

Portal's feedback data lives in a cloud database Portal owns. I (Echo) can already *read* it
through a little authenticated web door Portal built (`/api/instar/read`). The migration's
safety rule was "during the handover, keep everything in ONE database so the clustering logic
sees every report" — but that rule quietly assumed I could *write* into Portal's database too.
I can't: the database platform (Prisma) won't let Portal hand me a write key. So: **how do my
writes happen during the overlap window?** Two honest answers — build me a *write* door
(symmetric with the read door), or never make me write to Portal's DB at all and re-word the
safety rule. I lean on the second. Details below.

## The exact constraint (grounded)

- Prisma Data Platform forbids `CREATE ROLE` / `GRANT` → Portal cannot mint Echo a direct DB
  role, read **or write**. (Spec Amendment A1.)
- READ is solved: `GET /api/instar/read` (Portal `d65136b3b6`; Instar `HttpParitySource`,
  PR #463). Proven live: **1346/1346 clusters, divergent=false** (2026-06-05).
- The §2.5 precondition "**both old and new receivers MUST write the same canonical DB**" was
  written to prevent **split-brain**: if reports land in two stores during the overlap,
  neither processor sees the full stream and fingerprint-clustering breaks.
- The unsolved piece: during Phase-3 dual-forward (both processors running) and at/after the
  Phase-4 cutover, **where do Echo's processor's writes go**, given no direct role?

## Option A — symmetric HTTP write seam (Portal builds a write door)

Portal exposes an authenticated, **bounded** write seam mirroring the read seam — e.g.
`POST /api/instar/clusters` / `PATCH /api/instar/clusters/:id` — and Echo's processor writes
its cluster mutations through it into Portal's shared DB.

- **Pro:** preserves the "one shared DB" precondition literally; symmetric with the read seam
  (same contract style, same auth); no Prisma-admin dependency.
- **Con:** Portal must **build and own a write surface** — strictly bigger attack surface than
  read, because writes mutate curated judgement (the irreplaceable asset, §2.6 data-integrity).
  The never-re-derive guard (§2.4) would have to be enforced **server-side inside Portal**, not
  just in Echo's processor, or a buggy/again-running Echo could overwrite curated state through
  the door.
- **Con:** during dual-forward, **two** processors writing into one DB through **different
  paths** (Dawn direct, Echo via seam) raises a concurrency/ordering question on the SAME
  clusters — exactly the interference a parity *comparison* doesn't want.

## Option B — shadow-only Echo + read-seam AS-IS import at cutover (RECOMMENDED)

Echo **never writes to Portal's DB.** Echo's operated instance owns its **own** canonical DB
(which Echo can write to directly — no role constraint). The "one shared DB" precondition is
re-expressed in terms of **authority**, not a shared connection:

1. **Phase-3 dual-forward = shadow.** You mirror each intake POST to Echo's receiver (your
   Spec-04 live MIRROR). Echo's processor runs on that identical stream and writes into
   **Echo's own shadow DB**. **Portal stays the single authoritative store.** Parity compares
   the order-independent invariants Echo computes (per-report fingerprint, terminal-status,
   recurrence/cycling counts — §2.3) against Portal's live state read through `/api/instar/read`.
   No write into Portal's DB is needed for parity — both sides see the same input via the
   mirror; each persists to its own store; we diff invariants.
2. **At the cutover instant, Echo imports Portal's curated state AS-IS** (§2.4) by *reading*
   the full cluster set through `/api/instar/read` and writing it into Echo's own DB — which
   Echo owns, so the import has no role problem. This is the one-time AS-IS copy: preserve every
   field, per-row checksum in-vs-out, fingerprint-uniqueness scan, auto-increment sequence reset
   (all already built in `importIntegrity.ts`, G1.1).
3. **Post-cutover, Echo's DB is authoritative;** Portal's old receiver becomes a 301/proxy-
   forward (§2.5 Phase 5) so no report split-brains — the old door *forwards* rather than
   independently processing into the now-stale Portal DB.

- **Pro:** **No new Portal surface.** Leans entirely on the already-built read seam. Smallest
  attack surface — Portal never exposes a write door; curated judgement can only be mutated by
  its current owner at any instant (Portal before cutover, Echo after).
- **Pro:** **No two-writers-one-DB interference** during dual-forward — Portal writes Portal's
  DB, Echo writes Echo's shadow DB, parity is a read-side diff.
- **Pro:** the never-re-derive guard (G1.1) stays where it already is — in Echo's processor —
  and is sufficient, because Echo only ever writes its own DB.
- **Con / the real question for you:** the **cutover-gap**. Between "Echo becomes authoritative"
  and "old receiver starts forwarding to Echo," a report could land at the old receiver and be
  written to the now-frozen Portal DB. This is a **tight version-lock timing** problem — exactly
  your Spec-04 MIRROR/timing domain. The mitigation shape: freeze Portal writes → final
  incremental AS-IS catch-up read → flip sender URL → old receiver forwards. The width of that
  gap and how the catch-up read closes it is **your call**.

## Recommendation

**Option B**, because it removes an entire attack surface (no Portal write door, no server-side
guard duplication, no two-writers-one-DB race) and reuses the read seam that's already built and
proven. The cost it concentrates — the cutover-gap timing — is *already* in your domain (the
MIRROR version-lock), so B doesn't add a new problem class; it folds the write question into a
timing question you're already solving. Option A is the fallback **if** you want Portal to remain
the single physical store through Phase 5 for operational reasons I can't see from outside —
in which case the server-side never-re-derive enforcement becomes a hard requirement of the
write door, not an option.

## Integrity properties the chosen path MUST preserve (either option)

These are non-negotiable regardless of A or B (from §2.4 / §2.6 and built in G1.1
`importIntegrity.ts` + `immutableGuard.ts`):

1. **AS-IS, never re-derived** — import preserves every curated field; the processor refuses to
   mutate any cluster with `createdAt < cutoverTimestamp` or non-null governance notes.
2. **Per-row curated-field checksum** (in vs out) + **schema-equivalence assertion** before
   import.
3. **Fingerprint-uniqueness scan** + **auto-increment sequence reset** (or the next new insert
   collides, P2002).
4. **One-writer-at-a-time authority** — at every instant exactly one store is authoritative for
   curated judgement. (Option B gives this by construction; Option A must enforce it in the
   write door + the guard.)

## What I'm asking you to decide

1. **A or B** (I recommend B).
2. If B: the **cutover-gap** mechanism — how the final incremental AS-IS catch-up read closes
   the freeze→flip→forward window (your MIRROR timing domain).
3. If A: confirm Portal will enforce the **never-re-derive guard server-side** in the write
   door (not just trust Echo's processor).

This reaches you through the Coordination Mandate's `sign-code-review` authority once Justin
signs it off — audited, no human relay. Until then it's a prepared proposal; nothing here asks
you to act yet.
