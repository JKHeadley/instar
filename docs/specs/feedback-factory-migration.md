---
title: "Feedback Factory Migration — Dawn → Echo ownership, open/operated split, phased cutover (converged v2)"
slug: feedback-factory-migration
review-iterations: 2
review-convergence: "v2 — converged. Round 1: 3 parallel reviewers (migration-safety, standards-conformance, adversarial data-integrity) + live Standards-Conformance Gate, folding 10 structural findings: order-independent parity (recorded-corpus 100% vs live invariant gate); byte-level Python↔JS divergence pinned (Unicode regex classes, SHA encoding/normalization, tokenizer/case-fold); ONE shared canonical DB through cutover (split-brain prevention); Observability + Agent-Awareness as shipping deliverables; integrity-safe import (txn, fingerprint-uniqueness scan, sequence reset, per-row checksum); structural never-re-derive guard; proxy-forward decommission; dual-forward defense-bypass; secret trimmed at load. Round 2 (Dawn, domain owner, the required code-owner gate): confirmed scars (a)/(b)/(c) AND caught a 4th I'd missed — (d) lifecycle partitioning with cycling prevention (:2747–2793); resolved dual-forward to live MIRROR (tight version-lock timing per her Spec 04). ALL open items resolved. Ready for Justin's final approval."
eli16-overview: feedback-factory-migration.eli16.md
approved: true
approval-context: "Approved by Justin on 2026-05-26 (topic 12476) after converged v2 — the 3-reviewer round + Dawn's domain review (4th scar + MIRROR). Build authorized: Phase 0 (receiver+dispatch → Vercel) then Phase 1 (port processor against the-portal/.claude/scripts/feedback-processor.py as the byte-exact reference, with parity harness + Dawn line-by-line review)."
ships-staged: true
lessons-engaged:
  - "Self-Hosting standard — dogfood-to-ship: the factory's own evolution proposals flow through spec→/spec-converge→ratify, never auto-merge"
  - "Migration Parity — the sender's canonical feedback URL must flip for EXISTING agents via PostUpdateMigrator, not just new installs"
  - "Signal vs Authority — the ported scar guards detect/flag; only the curated cluster lifecycle has terminal authority"
  - "Testing Integrity (3 tiers + wiring + both-sides) — mandatory; parity is an ADDITIONAL gate, never a replacement (conformance-gate finding)"
  - "Observability — the factory meters its own capture→cluster→dispatch→acted loop (standards finding)"
  - "Agent Awareness — CLAUDE.md template + migrateClaudeMd for the open/operated split (standards finding)"
  - "Structure > Willpower — never-re-derive + secret-trim + Phase-5 block enforced in code, not by remembered policy"
  - "Order-independence — clustering is stateful/order-dependent; parity gates must distinguish fixed-corpus replay from live invariant comparison"
  - "Historical state is irreplaceable, not a cache — InstarFeedbackCluster migrates AS-IS, never re-derived; integrity-safe import"
  - "ELI16 companion (Part 1)"
  - "Seven-dimension side-effects review (Part 3)"
build-mode: "Phased migration — each phase independently revertible; cutover is the only one-way door and it is gated + safety-netted"
---

# Feedback Factory Migration — Dawn → Echo (v0 draft)

> Start with the ELI16 overview (Part 1). The technical spec (Part 2) has the phase plan and the exact code map. The side-effects review (Part 3) and open questions (Part 4) are for reviewers.

---

# Part 1 — ELI16 overview (plain English)

## What the feedback factory is

Every Instar agent in the world can file a report — "this broke," "I wish it did X." Those reports flow to one central place that does three jobs:

1. **Catches** the reports (the front door / receiver).
2. **Sorts** them — figures out which reports are really the *same* problem, even when they're worded differently or hit different versions, and tracks each problem's life story (new → being-worked → fixed → and watch in case it comes back).
3. **Sends guidance back out** to agents (the "here's what we learned / here's what to do" channel).

Right now Dawn runs this whole thing on her own machines. We're moving ownership to me (Echo), because I'm the one who actually builds Instar — the factory should live with the builder.

## The restaurant analogy

Think of it like a restaurant.

- **The recipe book** is the *code*. We're going to make the recipe book **public** (open-source it in the Instar repo) so anyone running Instar can cook their own version.
- **The flagship restaurant** is the *one operated instance* that all the official agents actually eat at. We keep running that ourselves — it's not public, it has the real customer history.

So: open the recipe, keep operating the flagship. That's the "open/operated split."

## Why it's not a copy-paste job

Here's the trap Dawn warned me about, and it's the heart of this spec:

- The **front door** (catching reports) is the *easy third*. I could copy that in an afternoon.
- The **hard part** is the **sorting brain** — the logic that decides "the crash in v1.1.0 and the crash in v1.1.1 are the SAME bug, group them" and "don't merge this into an already-fixed pile unless it's really similar" and "if a fixed bug comes back, reopen it." That logic lives in a **separate background program written in Python**, not in the front-door code. If I only copy the front door, the sorting will silently disagree with Dawn's, and we'd quietly fork the bug history.
- The **chef's notebook** — every triage decision a human or AI has ever made about every bug pile — has to be **carried over exactly**, not re-derived. If I just re-import the raw reports and re-run the sorter, I throw away all that accumulated judgment.

## How we move it without breaking anything

We do it in careful phases, and only **one** of them is a one-way door:

1. Stand up the new front door + guidance channel (no live traffic yet).
2. Port the Python sorting brain into Instar's own language (TypeScript), with Dawn checking my port against her original line by line.
3. Carry over the chef's notebook exactly (both the raw reports and the curated piles).
4. Have Dawn quietly send a *copy* of every incoming report to the new place too, run both brains side by side, and **prove they produce the identical sorting** before we trust it.
5. Only then flip the switch so every agent points at the new place — and Dawn keeps her old door warm as a safety net for a while.
6. After a quiet period with zero disagreement, retire the old one.

The key safety rule: we don't flip the switch on "the tests pass." We flip it on "both brains sorted the same real reports the same way." That's the bar.

## What this has to do with the bigger picture

This is the first real test of the **Self-Hosting standard** you just ratified ("the framework develops itself"). The feedback factory is *how Instar improves itself* — so moving it to the builder, in the open, with the same discipline we demand of everything else, is the standard made real. And the factory's own "here's an improvement we should make" proposals don't get to skip the line: they go through the same spec → review → approval gate as any other change.

---

# Part 2 — Technical spec

## 2.1 Current-state ground truth (Dawn's verified file:line map)

All paths below are in Dawn's deployment (the SageMind/Next.js app), verified by Dawn on 2026-05-26. This is the source we port FROM.

### Receiver — `pages/api/instar/feedback.ts` (the easy third)
- `handleSubmit` at :209. POST intake is **public, no auth** (field agents must reach it).
- Six intake defense layers (declared :8–14):
  1. Per-IP ratelimit 10/hr, 50/day (:68)
  2. Agent fingerprint — User-Agent must contain `instar/` (:116)
  3. Honeypot field (:168)
  4. HMAC signature — **non-blocking** (see §2.5)
  5. Input validation — title ≥3, desc ≥10 (:242–269)
  6. Dedup on `feedbackId` + Prisma P2002 unique-violation catch (:280–320)
- `handleList` (GET, :335) and `handleUpdate` (PATCH, :419) require `X-Internal-Key`.

### Dispatch — `pages/api/instar/dispatches/index.ts` (guidance back out)
- `handleList` (GET, :53) — the poll loop-back agents hit; supports `?since=` & `?type=`; version-compat filtering (:87–93).
- `handleCreate` (POST, :115) — requires `X-Internal-Key`; dedup by normalized title (:155–166).
- Single read: `dispatches/[dispatchId].ts`.

### The FOUR scars (only ONE lives in the receiver)

> **Dawn confirmed (2026-05-26, via relay): (a)/(b)/(c) below are correct (her line refs: 1062–1079, 227–243, 1434–1584), AND she caught a 4th piece I'd missed — (d) lifecycle partitioning with cycling prevention (lines 2747–2793). Porting only (a)/(b)/(c) would have silently dropped (d).** This is exactly why her domain review was a required gate.

**(a) Investigation / terminal-transition evidence gate**
- Item side: `feedback.ts:443–450` — moving an item to `resolved` requires `processingNotes` ≥20 chars else HTTP 400.
- Cluster twin: `clusters.ts:164–176` — `EVIDENCE_REQUIRED_STATUSES = ['wontfix','closed','chronic_escalated']` require `actionTaken | researchNotes` ≥20 chars. Note `'fixed'` is **excluded** (v1 legacy — preserve the exclusion, it is load-bearing for back-compat).

**(b) Version-fingerprint normalizer (the grouping brain) — PYTHON**
- `.claude/scripts/feedback-processor.py:227` `compute_fingerprint()`.
- Collapse regex :237 `re.sub(r'v?\d+\.\d+\.\d+(-[\w.]+)?', 'vN', title)` + strip hashes (:238) + strip bare ints (:239), then SHA-256 truncated to 32 chars (:243).
- Effect: `v1.1.0` and `v1.1.1` titles hash identically → same bug.
- Stored on `InstarFeedbackCluster.fingerprint` (`@unique`, schema :1913).
- **Port the regex+hash LOGIC, not an endpoint. This is the single most correctness-critical port.**

**(c) Regression-reopen / false-merge guard — TWO layers**
- API hard gate: cluster-PATCH terminal guard (`clusters.ts:164–176`, same as scar (a)'s cluster twin).
- Processor soft similarity (`feedback-processor.py`):
  - False-merge guard :1431–1466 — Jaccard similarity threshold **raised 0.35 → 0.55** before merging into a `fixed`/`resolved` cluster; logs `FALSE-MERGE-GUARD`.
  - Auto-reopen-on-regression :1543–1584 — bumps `recurrenceCount`.
  - Cycling detection: `can_transition_to_verified` :1084, `detect_cycling` :1139, `chronicCount ≥ 3` forces `chronic_escalated` :1079.
- **Port BOTH layers** — the hard API gate AND the soft processor similarity. Dropping either silently changes grouping behavior.

**(d) Lifecycle partitioning with cycling prevention — PYTHON (the scar Dawn caught that I'd missed)**
- `feedback-processor.py:2747–2793` (Dawn's ref).
- Partitions clusters across lifecycle states and prevents pathological cycling between them (the structural complement to the (c) cycling *detection* — (c) detects/escalates a cycling cluster; (d) governs how clusters are partitioned across lifecycle states so they can't thrash). Must be ported with (c) as a unit; porting (c) without (d) reproduces the cycling behavior (d) exists to prevent.
- **Dawn's line-by-line review of the ported (d) logic is part of the required Phase-1 review gate** — its exact semantics live in her code, not inferable from the description alone, so I port against her Python as the reference and she confirms equivalence.

### Data — `prisma/schema.prisma`, 5 models
| Model | schema line | role | migrate? |
|---|---|---|---|
| `InstarFeedback` | :1857 | raw reports | **YES — primary import** |
| `InstarFeedbackCluster` | :1891 | dedup clusters + fingerprint + lifecycle/governance | **YES — irreplaceable curated state** |
| `InstarComponentCluster` | :1967 | derived | re-derivable; migrate optional |
| `InstarImplementationQueue` | :1998 | transient | no — regenerates |
| `InstarDispatch` | :2018 | dispatch records | small — migrate for continuity |

### Signing secret
- `INSTAR_WEBHOOK_SECRET` (current value `instar-rising-tide-v1`).
- `feedback.ts:135` `verifySignature`: `x-instar-signature` + `x-instar-timestamp`, 5-min replay window (:144), HMAC-SHA256 over `` `${timestamp}.${body}` `` (:151–153), timing-safe compare (:160).
- **Non-blocking**: unsigned reports still written with `verified:false` (schema :1869), flagged "⚠️ unverified" in notify (:386).
- **GOTCHAS**: secret lives ONLY in Vercel env + the package-public default on the sender (NOT inline in source — don't grep for it). Committed env snapshots carry a **trailing newline** (`instar-rising-tide-v1\n`); set it with `printf`, not `echo`, or HMAC silently mismatches.

## 2.2 Target architecture: open/operated split

- **Open (the recipe)** — receiver, dispatch, and the ported processor logic ship **in the Instar repo, open-source**. Any operator can stand up their own factory.
- **Operated (the restaurant)** — the **canonical rising-tide instance** is a private deployment owned by the Instar maintainer (now Echo). It holds the real `INSTAR_WEBHOOK_SECRET`, the curated cluster DB, and the dispatch authority.
- **Front placement** — receiver + dispatch are stateless HTTP → **Vercel** (the "Instar canonical front"). Cloud DB (Prisma) stays cloud-hosted, reachable from Vercel.
- **Processor placement** — the ported processor runs as an **Instar job** (`supervision: tier1`) on a capable machine (NOT the always-on Mini — it's heavyweight, batch, and bursty). It connects to the same cloud DB. This is the hosting-migration boundary: front → Vercel, heavy processor → capable machine, lightweight always-on (lifeline/listener/Ghost/MoltBridge) → Mini.

## 2.3 Port target: Python processor → TypeScript Instar job

The processor is the scar tissue. **Decision (Justin, 2026-05-26): port to TypeScript** (Instar is TS; "discipline travels" — it becomes a real, tested Instar capability rather than an opaque external script), gated by a **parity harness** and Dawn's line-by-line review. Justin's framing: the working Python is a free oracle — straightforwardness comes from porting *against a running reference*, not from the port being trivial.

Port surface (all from `feedback-processor.py`):
- `compute_fingerprint()` — regex collapse + hash. Port byte-exact (see "Byte-level parity hazards" below — this is where two *correct-looking* ports silently diverge).
- False-merge guard — Jaccard 0.55 threshold, `FALSE-MERGE-GUARD` log line. Port the **tokenizer/normalizer that produces the Jaccard sets** too, not just the threshold — that's the real divergence surface.
- Auto-reopen — `recurrenceCount` bump on regression.
- Cycling — `can_transition_to_verified`, `detect_cycling`, `chronicCount ≥ 3 → chronic_escalated`.
- **Candidate-ordering + tie-break** — when multiple existing clusters are above-threshold, the Python picks one (most-similar / first-seen). The TS port must replicate that selection + tie-break rule exactly, or cluster assignment diverges even with identical similarity math.
- **Lifecycle partitioning + cycling prevention (scar d, :2747–2793)** — port as a unit with the (c) cycling logic; it governs how clusters are partitioned across lifecycle states so they can't thrash. Semantics live in Dawn's code; port against her Python and have her confirm equivalence.

**Byte-level parity hazards (the failure that ships silently) — the port MUST pin all of these:**
- **Regex character classes**: Python 3 `re` `\d`/`\w`/`\b` are **Unicode** by default; JS `\d`/`\w` are **ASCII-only**. A title with a non-ASCII digit, em-dash, or non-breaking space fingerprints differently → new cluster instead of merge → silent history fork. Audit the Python for `re.ASCII`; pin JS regex semantics explicitly (`u` flag + explicit classes) to match whichever the Python actually uses.
- **Hash input bytes**: `compute_fingerprint` SHA-256s the normalized title. Pin the **input encoding** (Python `hashlib.sha256(s.encode())` defaults to UTF-8; JS `Buffer.from(s,'utf8')`) AND **Unicode normalization** (NFC vs NFD) — they must match, or `@unique` fingerprint (schema :1913) silently creates a duplicate cluster. Assert the hash *input bytes*, not just the output.
- **Tokenization + case-folding**: Python `.split()` vs JS `.split(/\s+/)` differ on leading/Unicode whitespace; Python `.lower()` and JS `.toLowerCase()` diverge on locale-specific chars (Turkish İ, German ß). Port and parity-test the exact tokenizer + case-fold.

**Parity is a TWO-mode gate, and the modes are NOT interchangeable** (convergence finding — the v0 conflated them):
- **Recorded-corpus replay (the strict 100% gate):** feed an identical, fixed-order corpus through both Dawn's Python and the TS port; **per-report fingerprint assignment** (deterministic) + terminal-status decisions + reopen/cycling counts must match 100%. The corpus MUST be seeded with adversarial inputs (non-ASCII digits, em-dash, NBSP, NFC/NFD pairs, Turkish-İ/ß titles, near-0.55-Jaccard pairs), not just "real titles" — production won't contain the divergent input until it does.
- **Live dual-forward (Phase 3) compares ORDER-INDEPENDENT invariants only:** clustering is order-dependent (a report merges into whichever similar cluster already exists), and two instances will NOT see reports in identical order/timing. So the live diff asserts invariants that don't depend on arrival order — per-report fingerprint, terminal-status decisions, recurrence/cycling counts — NOT raw cluster-membership identity. A strict membership diff here would fail on benign ordering noise and pressure us to weaken the gate.

Dawn's line-by-line review of the ported fingerprint + cluster-transition logic against the originals is a required gate.

**Testing follows the full Testing Integrity standard (non-negotiable, all three tiers) — and parity is an ADDITIONAL gate on top, not a replacement.** (This wording corrects a conformance finding the live Standards-Conformance Gate raised against an earlier draft: parity must not *subordinate* the testing standard.)
- **Tier 1 (unit)** — the ported fingerprint regex/hash, the Jaccard false-merge guard, auto-reopen, and cycling logic each tested in isolation, both sides of every decision boundary (e.g. just-below vs just-above the 0.55 Jaccard threshold; `chronicCount` 2 vs 3).
- **Tier 2 (integration)** — the ported processor against a real (test) DB: ingest → fingerprint → cluster → transition, asserting DB state.
- **Tier 3 (E2E "feature is alive")** — the canonical front boots and `POST /feedback` → dispatch round-trips on the production init path (200, not 503).
- **Wiring-integrity** — the processor job is actually constructed and scheduled, not dead code.
- **Parity gate (additional)** — feed Dawn's live corpus through both her Python and my TS port; fingerprints AND cluster transitions must match 100%. Dawn's line-by-line review of the ported fingerprint + cluster-transition logic is a required gate, not optional. Parity proves *equivalence to the reference*; the three tiers prove *correctness*. Both are required to advance Phase 1.

## 2.4 Data migration: AS-IS, never re-derived

- Export `InstarFeedback` + `InstarFeedbackCluster` (+ `InstarDispatch` for continuity) from Dawn's Prisma cloud.
- Import into the canonical instance **preserving every field**: cluster `fingerprint`, lifecycle status, governance notes, dispatch links, `chronicCount`, `recurrenceCount`, `processingNotes`/`actionTaken`/`researchNotes`.
- **Integrity-safe import (convergence finding — "row counts + spot-check" is too weak to catch silent corruption of the irreplaceable curated state):**
  - **One transaction**, parent-before-child FK order (clusters → feedback → dispatch links), so a partial import can't leave dangling references.
  - **Pre-import uniqueness scan on the source**: curated history may contain two clusters sharing a `fingerprint` (after manual merges/edits); an AS-IS import would abort on the `@unique` constraint mid-transaction or silently collapse them. Detect + resolve before importing.
  - **Auto-increment sequence reset** after importing explicit PKs, or the next *new* post-cutover insert collides (P2002).
  - **Per-row checksum** over all curated fields (in vs out) + a **schema-equivalence assertion** between Dawn's schema and the canonical instance (enum/string status values, null-vs-empty governance notes, timestamp/timezone) before import.
- **Phase-2 gate is therefore**: per-row curated-field checksums match + zero P2002 on a synthetic post-import insert + FK referential-integrity check (not just row counts).
- **Do NOT** import-raw-then-rerun-processor. The cluster table is curated human/LLM judgment, not a cache. Re-running the processor over historical raw reports would discard every triage decision.
- The processor only runs over **new, post-cutover** traffic — and this is enforced **structurally, not by policy** (Structure > Willpower): the ported processor **refuses to mutate any cluster with `createdAt < cutoverTimestamp`, and treats any cluster with non-null governance notes as immutable**. A wrong-date backfill therefore physically cannot overwrite curated lifecycle/governance state.

## 2.5 Cutover sequence (the only one-way door, gated + safety-netted)

| Phase | Action | Revertible? | Gate to advance |
|---|---|---|---|
| 0 | Port receiver + dispatch to canonical front (Vercel), same shared secret, no live traffic | yes (delete deploy) | deploy healthy, secret HMAC round-trips (secret trimmed at load — see below) |
| 1 | Port processor to TS Instar job | yes | **all 3 test tiers green (§2.3) + recorded-corpus parity 100% (incl. adversarial Unicode/encoding/Jaccard-boundary cases) + Dawn line-by-line review sign-off** |
| 2 | Migrate `InstarFeedback` + `InstarFeedbackCluster` AS-IS | yes (drop import) | per-row curated-field checksums match + zero P2002 on synthetic insert + FK integrity (§2.4) |
| 3 | Dawn **mirrors** each intake POST to new receiver (live, NOT a queue — see below); both write the **same canonical DB** (see precondition); run both processors | yes | **order-independent invariants identical** (per-report fingerprint, terminal-status, recurrence/cycling counts — NOT raw membership; §2.3), monitored automatically over a real traffic window |
| 4 | **CUTOVER** — flip sender's canonical feedback URL via `PostUpdateMigrator` so EXISTING agents repoint | one-way (mitigated by Phase 5) | Phase-3 parity monitor reports zero invariant-divergence; Dawn keeps old receiver warm |
| 5 | Old receiver becomes a **301/proxy-forward** to the new URL (NOT dark); decommission only the DB *write* after the measured traffic tail drains | n/a | **structural**: the parity monitor blocks Phase 5 until the zero-divergence window completes; old-receiver tail traffic measured from logs (not an arbitrary N days) |

**Resolved precondition — ONE shared canonical DB through cutover (convergence finding; was open-Q2).** During dual-forward (Phase 3) and warm-standby (Phase 5), both the old and new receivers MUST write to the **same** canonical database. If they hold separate DBs, post-cutover reports split-brain across two stores and neither processor sees the full stream — fingerprint clustering breaks precisely because it needs all reports in one place. So Q2 ("stay on Dawn's Prisma project vs fresh project") is resolved to: **stay on the existing shared Prisma project through cutover; any DB relocation is a separate, later step after the sender tail has fully drained.**

**Dual-forward = live MIRROR, not a queue (Dawn, 2026-05-26).** Dawn requires mirroring each POST live rather than batching through a queue — HIGH-confidence verification needs tight version-lock timing between the two processors (her Spec 04). A queue would decouple the timing and weaken the parity signal. **The mirror must bypass the new receiver's intake defenses** (convergence finding): mirrored POSTs would otherwise trip the per-IP rate limit (10/hr) and the `instar/` User-Agent / honeypot checks → dropped traffic → false divergence. The forwarder is allowlisted (rate-limit + UA checks bypassed) for the parity window only.

**Secret handling is structural, not a remembered step (convergence finding).** Rather than relying on a "use `printf` not `echo`" warning, the ported receiver **trims/normalizes `INSTAR_WEBHOOK_SECRET` at load**, so a trailing newline physically cannot cause an HMAC mismatch.

**Migration Parity is mandatory at Phase 4**: the sender default lives in the published instar package; new installs get the new URL via `init`, but deployed agents only repoint through `PostUpdateMigrator` (idempotent, existence-checked). A cutover that only works for new agents is a broken cutover. The proxy-forward in Phase 5 covers the long tail of agents that update slowly or never — they keep landing on the canonical front instead of silently losing reports.

## 2.6 Agent-proposed evolutions: one-approval gate

The factory's evolution stage proposes Instar improvements from clustered feedback. Per the **Self-Hosting standard (dogfood-to-ship)**, those proposals are NOT auto-merged. Each becomes a spec that flows through `/spec-converge` (which now auto-runs the Standards-Conformance Gate) → ratify → build → CI. One human approval per evolution, same gate as any other change. The factory accelerates the *pipeline*; it does not bypass the *gate*.

## 2.7 Observability (Phase 1 deliverable — convergence finding)

The migrated factory ships its own metering of the whole loop — **captured → clustered → dispatched → acted-on** — on a read-only operator surface (counts, cluster-state distribution, dispatch funnel, processor run health, FALSE-MERGE-GUARD / auto-reopen rates). This is distinct from the separate *global* Instar-wide dashboard (§2.9): that's a cross-system view; this is the factory's own instrumentation, required by the Observability standard ("you can't tune what you can't see"). It is a named Phase-1 deliverable, not optional.

## 2.8 Agent Awareness (shipping obligation — convergence finding)

Per the Agent Awareness standard, the open/operated split and the new canonical front are agent-facing facts. Shipping includes:
- Updating the CLAUDE.md template (`src/scaffold/templates.ts → generateClaudeMd()`) so agents know the canonical feedback endpoint, that the factory code is open (any operator can run their own), and how the one-approval evolution gate works.
- A `migrateClaudeMd()` content-sniff (Migration Parity) so existing agents get the briefing change, not just new installs.
An agent that doesn't know about a capability effectively doesn't have it.

## 2.9 Out of scope (separate initiatives)
- **Per-operator signing keys** — held until AFTER cutover (Dawn's correction: keep the single shared key through the move; layer per-operator keys as a separate post-cutover item). <!-- tracked: feedback-factory-migration -->
- **Global Instar-wide dashboard** (agent count, Threadline, MoltBridge, factory throughput) — a companion spec, sequenced after Phase 1 ships. Not in this spec. <!-- tracked: feedback-factory-migration -->
- **MoltBridge** — separate system; already restored + hardened. Not coupled to this migration.

---

# Part 3 — Seven-dimension side-effects review

1. **Over-block / under-block** — The ported scar guards are the risk surface. Under-port (looser Jaccard, weaker fingerprint) → false merges silently corrupt bug history; over-port (stricter) → fragments one bug into many. Mitigation: parity harness asserts identical output against the live corpus; neither direction can pass silently.
2. **Level-of-abstraction fit** — Receiver/dispatch are HTTP at the edge (Vercel, correct). Processor is batch/heavy at the job layer (capable machine, correct). Curated state is data, migrated AS-IS (correct — not logic to re-execute). No layer inversion.
3. **Signal vs Authority** — The processor's similarity/cycling logic emits grouping *signals*; the curated cluster lifecycle (with human/LLM governance notes) holds terminal *authority*. Preserved: the API hard gate (scar a) requires evidence for terminal transitions; the processor never force-closes.
4. **Interactions** — Touches the published sender default (Migration Parity), `PostUpdateMigrator`, and every deployed agent's feedback path. The shared secret is the cross-cutting fragile point (trailing-newline). Dual-forward (Phase 3) keeps Dawn's instance authoritative until parity is proven, so no interaction is load-bearing before it's verified.
5. **Rollback cost** — Phases 0–3 fully revertible. Phase 4 (cutover) is the one-way door, mitigated by Phase 5's warm old-receiver safety net and the `PostUpdateMigrator` repoint being itself reversible (re-migrate to old URL). Worst case during safety window: re-point sender back to Dawn's receiver.
6. **Data integrity** — The irreplaceable asset is `InstarFeedbackCluster` curated judgment. Protected by AS-IS migration in one transaction + pre-import fingerprint-uniqueness scan + sequence reset + per-row curated-field checksums (§2.4), and a **structural** never-re-derive guard (processor refuses to mutate pre-cutover / governance-noted clusters). Raw `InstarFeedback` is replayable but migrated too for completeness.
7. **Failure modes** — (a) Secret trailing-newline → prevented structurally (trimmed at load), not just caught. (b) Python↔JS byte/Unicode/encoding divergence → pinned + adversarial-corpus parity (§2.3). (c) Order-dependent clustering false-divergence → live gate uses order-independent invariants, not membership (§2.3/§2.5 Phase 3). (d) Split-brain across two DBs → prevented by the one-shared-DB precondition. (e) Cutover before parity → Phase 4 gated on the Phase-3 monitor. (f) Never-updating agents lose reports → proxy-forward (§2.5 Phase 5). (g) Sender repoint reaches only new agents → Migration Parity / `PostUpdateMigrator`.

---

# Part 4 — Open questions for /spec-converge + Dawn

1. ~~**Processor language**~~ — **RESOLVED (Justin, 2026-05-26): port Python→TS.** The working Python is the parity oracle.
2. ~~**Canonical DB location**~~ — **RESOLVED (convergence): ONE shared canonical DB through cutover** (stay on the existing Prisma project; any relocation is a separate later step). A split DB would split-brain clustering (§2.5 precondition).
3. ~~**Safety window length**~~ — **RESOLVED (convergence): no arbitrary N days.** Old receiver becomes a 301/proxy-forward; decommission the DB *write* only after the measured traffic tail drains, gated by the parity monitor (§2.5 Phase 5).
4. ~~**Dawn — scar completeness + dual-forward**~~ — **RESOLVED (Dawn, 2026-05-26):** (a)/(b)/(c) confirmed AND a **4th scar added** — (d) lifecycle partitioning with cycling prevention (:2747–2793). Dual-forward = **live MIRROR, not queue** (tight version-lock timing per her Spec 04). Her line-by-line review of the ported fingerprint + cluster-transition + (d) logic remains a Phase-1 gate.
5. **Evolution-proposal volume** — does the one-approval-per-evolution gate need batching (digest of N proposals) to avoid approval fatigue, or is per-proposal fine at current throughput? (Justin, low-stakes.)
