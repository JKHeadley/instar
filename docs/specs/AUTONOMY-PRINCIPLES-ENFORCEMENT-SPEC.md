---
title: "Autonomy Principles Enforcement — Blocker Ledger + Decision-Completeness Gate"
slug: "autonomy-principles-enforcement"
author: "echo"
status: "draft — convergence round 3 (round 1: 6 reviewers, ~30 findings; round 2: lessons-aware converged, adversarial found 3 more — all folded in)"
source-doc: "docs/AGENT-AUTONOMY-PRINCIPLES.md (PR #1050)"
source-topic: 23935
eli16-overview: "autonomy-principles-enforcement.eli16.md"
review-convergence: "2026-06-10T19:37:18.014Z"
review-iterations: 3
review-completed-at: "2026-06-10T19:37:18.014Z"
review-report: "docs/specs/reports/autonomy-principles-enforcement-convergence.md"
approved: true
approved-by: "Justin (uid:7812716706)"
approved-at: "2026-06-10T21:02:27.000Z"
parent-principle: "A Wall Is a Hypothesis"
---

# Autonomy Principles Enforcement

> Justin laid out two operating principles (PR #1050) and asked how to bake them into
> Instar's fundamentals. This spec is the structural answer. It deliberately does NOT
> rebuild what already exists — it COMPLETES Principle 1 and CLOSES the real gap that is
> Principle 2. This spec is also the first spec authored to be *provably single-run-
> completable*, dogfooding Principle 2 on itself.

## ELI16 version

Two rules Justin wants enforced, not just remembered:

1. **Almost every "I'm blocked" is a false blocker** — a judgment call, not a wall. Work it:
   do I have authority? does the user? get the access → dry-run → live-run → codify into a
   reusable playbook. Record *why* a blocker is genuinely true on the rare times it is, so
   it's never re-fought.
2. **Frontload all user decisions into the spec** so the agent finishes a spec in ONE
   autonomous run. Because agents build at 100–1000x behind dark/dry-run/read-only phases, a
   decision is cheaper to change *after* a completed run than to stop-and-wait mid-run for.

What I found auditing the codebase: **Principle 1 is ~80% already built; Principle 2 is the
real gap.** This spec adds exactly the two missing pieces — plus the cross-model-convergence
hardening Justin asked for — and nothing more.

**The single most important review finding (round 1, adversarial + lessons-aware + external,
all independently):** a naive Blocker Ledger would make the problem WORSE. A durable
"true-blocker, settled" record that future sessions read *instead of re-deciding* is exactly
the deferral-laundering the deferral-detector already refuses — it would convert a one-time
false blocker into permanent, citeable, re-litigation-suppressing memory. The entire §
"Anti-laundering design" below exists to invert that: the ledger must make false-blocker
avoidance *harder*, never easier. If it ever reads as "this wall is settled, stop trying,"
it has failed.

## What already exists (do NOT rebuild)

Principle 1's *detection + stance* layer is live:

- `deferral-detector.js` — PreToolUse hook that catches false-blocker framing ("I can't",
  "needs a human", "blocker", "can't proceed"), plus orphan-TODOs, time/fatigue deferral,
  and self-authored-PR merge-deferral. Injects a due-diligence checklist (signal only).
- Constitutional articles: **A Wall Is a Hypothesis**, **The Right to Stand Ground**,
  **Sovereignty**.
- Gates with real authority: **B16_UNVERIFIED_WALL**, **B17_FALSE_BLOCKER** in
  `MessagingToneGate` — can hold an outbound message that declares an untested wall.

So the agent already gets *caught* framing a false blocker. What's missing is the
**resolution workflow** and its **memory** — built so the memory can't become a laundromat.

## Proposed design

### Piece 1 — Blocker Ledger (completes Principle 1)

A durable record that turns "I hit a blocker" from a dead-end into a worked pipeline — with
structural evidence-of-work at every terminal so it can't be gamed.

#### Pipeline states (no state may be skipped)

`candidate` → `authority-checked` → `access-requested` → `dry-run` → `live-run` → terminal.

The states are a *gated* sequence, not a decorative list. `POST /blockers/:id/advance`
**refuses an illegal transition that skips a state** (unit-tested). The work-the-blocker
states are the point of the feature; bypassing them straight to a terminal is the exact
avoidance Principle 1 exists to kill (round-1 adversarial F2).

#### Terminal states — each requires verified evidence-of-work

- **`resolved`** — the path worked. Requires a *real, re-executable* codified output:
  - the named skill/playbook file must (a) exist on disk **within the agent's confined
    skill/playbook directory** (validated server-side — no arbitrary paths), (b) be newly
    created or carry a real diff *this session*, (c) reference the blocker id, and (d) link to
    the entry's `live-run` evidence that proves the path actually worked. **A `resolved` with
    no successful `live-run` in its history is refused** (round-1 adversarial F3, security
    LOW, gemini #2). Existence alone never satisfies it — a one-line stub playbook does not
    close the loop.

- **`true-blocker`** — genuinely the user's to do. This is the dangerous terminal, so it is
  the most gated. Requires ALL of:
  1. **A structured reason from a closed taxonomy**, NOT free prose. The only legitimate
     true-blocker kinds: `operator-only-secret` (a password/credential only the user holds),
     `operator-only-account` (an account only they can grant), `legal-billing-authorization`,
     `operator-judgment` (a decision that is genuinely theirs). A reason that doesn't match the
     taxonomy is refused and the entry stays `candidate` (round-1 adversarial F1, lessons F2).
  2. **A failed-attempt rebuttal — NO kind is exempt.** Round 2 (adversarial F-R2-1) caught
     that exempting the secret/account kinds from the attempt requirement reopened the
     laundering hole on the *most common* false-blocker shape ("I need credential X"). So every
     kind must record a real, failed work-attempt before it can settle; only the *form* of the
     attempt differs:
     - `operator-only-secret` / `operator-only-account` → a recorded **failed self-fetch
       attempt is mandatory** (vault miss via `secret-get.mjs`, `vercel env pull` empty, `gh`
       denied, decrypt-fail, or a session-boot self-knowledge block that does NOT name the
       secret). This is the structural enforcement of CLAUDE.md's standing mandate: an agent
       MUST first fetch a credential from its own accounts/vault and may treat it as
       operator-only ONLY when it genuinely cannot reach it itself (round-2 adversarial F-R2-2).
       "I need your password" is a true blocker only *after* the vault came up empty.
     - `legal-billing-authorization` / `operator-judgment` → a real failed `dry-run` (gemini #1).
     - In all cases the reason must also record why `authority-checked` found the agent lacks
       authority AND the user holds it.
  3. **Evidence of an actual `access-requested` outbound message to the user — AFTER the failed
     self-fetch/dry-run, never before.** The request to the user is the structural proof of
     "only the user can grant it," but it only counts once the agent has first tried (and failed)
     to reach the thing itself. Asking-instead-of-fetching does not settle a blocker (round-1
     adversarial F6, lessons F3, round-2 adversarial F-R2-2).
  4. **Passing the B17_FALSE_BLOCKER gate** before the entry is allowed to settle. The settle
     transition routes through a **Tier-1 LLM authority** (the B16 capability-inventory
     pattern) — not a presence-check on a text field. This is the fix for the Signal-vs-
     Authority gap: the ledger *records*, but the *settle judgment* goes through the intelligent
     gate, exactly as the constitution requires (round-1 lessons F3, security HIGH#2).

#### Anti-laundering design (the core of the feature)

- **A settled `true-blocker` is a decaying hypothesis, never suppressing authority.** It is
  stored and surfaced with explicit "hypothesis — last verified `<date>`" framing. It never
  reads as "settled, don't re-try." (round-1 lessons F2.)
- **Re-walk requires NEW evidence.** D6's slow job reopens a settled `true-blocker` to
  `candidate` on its `recheck-after` date. Re-settling REQUIRES fresh evidence (a new failed
  `dry-run` or a new `access-requested` round); **re-settling with the prior reason and no new
  attempt is refused** — the entry stays `candidate` until actually re-worked. Consecutive
  no-new-evidence re-settles are counted and **escalate to the user after N** (a wall
  re-stamped without ever being re-tested is itself an anomaly) (round-1 adversarial F7).
- **Every settle decision is audited** to an append-only log (`logs/blocker-decisions.jsonl`)
  with the authenticated origin (which session/operator advanced it) and the gate-decision
  hash that authorized it — the same pattern as the reaper/mandate audits.

#### Storage, concurrency, growth

- File-based JSON (`state/blocker-ledger.json`), per the file-state design decision (D1).
- **All mutations go through a single-writer/CAS path** (atomic temp-file + rename, reusing
  the `CommitmentTracker.mutate()` CAS pattern). The D6 re-test job serializes through the
  same path. File-JSON does not exempt the ledger from the concurrency safety the rest of
  instar enforces (round-1 scalability MED, integration MED).
- **Archival tier:** terminal entries older than a threshold move to
  `state/blocker-ledger-archive.json`; the hot file holds active/recent entries;
  `GET /blockers` paginates and reads the hot file by default; true-blocker reasons stay
  queryable in the archive. Prevents unbounded full-file read-modify-write growth (round-1
  scalability MED).
- **Multi-machine:** v1 scopes the ledger **single-machine**, with a named follow-up to <!-- tracked: CMT-1314 -->
  replicate it via the existing coherence-journal/working-set mechanism. The "never
  re-litigate a settled wall" guarantee is documented as per-machine in v1 so it is not
  silently assumed cross-handoff (round-1 integration MED).

#### Structural trigger (no willpower)

The ledger must NOT depend on the agent remembering to `POST /blockers` — that rebuilds the
"had the tool, never used it" methodology-drift failure (No Manual Work, 2026-05-23). When the
deferral-detector / B16 / B17 path fires on a false-blocker shape, it **auto-opens a
`candidate` ledger entry** (or injects a one-tap create with the detected text pre-filled).
A detected false blocker lands in the ledger without the agent choosing to (round-1 lessons F1).

#### Free-text safety

All ledger free-text (`evidence`, any note) is length-bounded and structurally validated at
the `/blockers` edge, treated as untrusted **data** — wrapped in a quoted/escaped envelope
(like the `<auto-learned-preference>` signal envelope) whenever surfaced to an LLM (the D6
re-walk re-feeds it into context), never concatenated as instructions, and HTML-escaped in the
dashboard. A test asserts an injection-payload reason does NOT alter reviewer/LLM behavior
(round-1 security HIGH#1).

#### Authority model

Signal-vs-Authority compliant: the ledger *records and structures*; it never *blocks* an
outbound message — B16/B17 keep that authority. The one judgment the ledger carries (the
`true-blocker` settle) is explicitly routed through the Tier-1 gate above, so it is not a
brittle filter masquerading as authority.

### Piece 2 — Decision-Completeness Gate (closes Principle 2)

A new convergence criterion in `spec-converge` that makes single-run-completability provable.

- **New reviewer: "Decision Completeness."** Runs in Phase 1 alongside the existing reviewers.
  Enumerates every point where the agent would have to **stop and ask the user** mid-run. Each
  must be either:
  1. **Frontloaded** — pulled into a `## Frontloaded Decisions` section (this spec included), or
  2. **Cheap-to-change-after** — tagged as a default safe to pick now and change post-run,
     *because* the work ships behind a named dark/dry-run/read-only phase.
- **The reviewer CONTESTS every cheap-to-change-after tag** — it does not merely check that a
  phase is named. It independently asserts reversibility, and a **closed non-cheap taxonomy**
  overrides any tag: anything touching **durable external side-effects, money, identity, or a
  published/user-visible interface is NEVER cheap**, regardless of a "ships dark" label. A
  contested tag the reviewer rejects is a **material finding that blocks convergence** — same
  authority as any other material issue (round-1 adversarial F4, gemini #3).
- **New convergence criterion.** A spec **cannot converge while any unresolved user-decision
  remains** in `## Open questions`. Open questions must reach zero. Additive to the existing
  "no material new issues" criterion.
- **The tag carries its evidence.** On convergence, frontmatter gains
  `single-run-completable: true` **plus** the counts: frontloaded-decisions, cheap-tags, and
  contested-then-cleared. A downstream reader (and an audit ratchet on the cheap-tag ratio
  across specs) can see WHAT was frontloaded, not just that a boolean is true — so the tag is
  earned, not minted (round-1 adversarial F8).
- **No blanket per-spec override.** A `disposition: override` escape hatch was considered
  (gemini #3) and rejected: it reopens the exact skip-hatch Principle 2 closes. The cost
  concern it addressed is instead handled by delta-gating in Piece 3 (below) and by the fact
  that the reviewer is one cheap parallel call.

### Piece 3 — Cross-Model Convergence: mandatory, dynamic, framework-aware

Justin's note: cross-model convergence has been getting skipped, and the model choices are
pinned. Both fold INTO spec-converge (the external reviewers already live in Phase 1). Round 1
found that the naive version of this rests on a **broken foundation**, so the scope is honestly
larger than "pure reuse" — see the in-scope work below.

- **Non-skippable, but delta-gated (not blindly every round).** The cost of mandatory externals
  on every round of every spec is real (round-1 scalability HIGH; the externals run N
  frameworks × many rounds). Resolution: externals run on **round 1 and on any round where the
  spec's reviewable body changed** since the last external pass (content hash); an unchanged
  round skips-with-logged-note. This keeps "non-skippable when there's something new to review"
  while killing redundant re-reviews of an unchanged spec in late rounds.
- **Activation is judged against a durable standing-framework baseline, not a just-in-time
  reading.** The escape hatch must not move from "abbreviated convergence" to "toggle frameworks
  off" (round-1 adversarial F5) — and round 2 (adversarial F-R2-3) caught that reading activation
  only at spec-START still lets an agent deactivate a framework *just before* converging and
  present as "genuinely single-framework." Resolution: the routing layer records a **durable
  framework-activation history** (it already tracks per-framework state for the circuit breaker);
  the externals pass is mandatory if a non-Claude framework was active **at any point in a
  lookback window** (default 7 days), not merely "right now." A deactivation within the lookback
  keeps externals mandatory for that spec; a mid-converge transition is additionally logged and
  fails report validation. The advisory floor is legitimate only for an agent that has been
  single-framework across the whole lookback — a recorded standing fact, not a 30-second-old flip.
- **Dynamic strongest-model selection — no pinning.** Enumerate the agent's activated frameworks
  and resolve the strongest tier (`'capable'`) per framework. BUT (round-1 integration HIGH#2,
  lessons F4): `resolveModelForFramework` **today only branches on `claude-code` and
  `codex-cli`** — `gemini-cli`/`pi-cli` fall through and return the literal string `'capable'`,
  which is not a model. So this is **real in-scope work, not reuse**: (a) extend
  `resolveModelForFramework` with `gemini-cli` and `pi-cli` tier→model branches, and (b) add a
  **loud canary** (per the fail-loud lesson) so any future fall-through to a non-model string
  fails validation instead of silently selecting a dead reviewer.
- **Configured ≠ available.** The dogfooding machine proves the case: config routes sentinels to
  `codex-cli` but the codex binary is ABSENT, while `gemini`/`pi` are present. An **availability
  probe** (CLI-on-PATH + the routing layer's existing per-framework circuit-breaker state) gates
  enumeration: a configured-but-unavailable framework degrades to the advisory "externals
  unavailable" note, never a dead reviewer or a hard-fail (round-1 integration HIGH#1).
- **Family diversity, not just framework count.** L4's lesson is that GPT *and* Gemini *and*
  Grok catch different failure classes; enumerating *frameworks* can silently drop below that
  floor (a claude-code + codex-cli agent yields Claude + GPT and zero Gemini). The spec
  **acknowledges coverage is bounded by activated frameworks** and selects **by family where
  possible**; a Claude-only agent's floor reaches a *different-family* model via the
  subscription-path/provider-registry fallback rather than skipping the external check entirely.
  If no external family is reachable at all, that surfaces as a **tracked gap** (a
  HumanAsDetector-style signal), not a quietly-logged note (round-1 lessons F5).
- **Provider allowlist (no spec egress to untrusted endpoints).** Dynamic resolution is
  constrained to an explicit **trusted first-party provider allowlist**; a framework resolving
  to a non-allowlisted or custom base-URL endpoint is excluded from the cross-model pass and
  logged advisory-unavailable — the full spec text is never sent to an attacker-controlled model
  (round-1 security MED×2). Cross-model selection inherits provider-registry trust constraints.
- **Fail semantics.** After the provider-fallback chain is exhausted for a family, a still-
  unreachable model degrades to the SAME advisory-logged note (not a hard round failure), with a
  bounded retry/timeout budget per round (round-1 scalability MED). *(Demonstrated live during
  this very convergence: the external Gemini reviewer's model-router hit retry-exhaustion and
  fell back — exactly the path this clause specifies.)*

## Frontloaded Decisions (Principle 2, applied to this spec)

- **D1 — Storage is file-based JSON, not SQLite.** Matches the file-state design decision; low
  volume. Cheap to migrate later (concurrency handled via CAS, see Piece 1).
- **D2 — Blocker Ledger ships dark + signal-only first**, behind `monitoring.blockerLedger.enabled`
  (503-when-dark contract, matching the integration test). No blocking authority ever. Dashboard
  read surface is Phase 1; the proactive "you have an open blocker" nudge is Phase 2 (tracked, not
  orphaned). <!-- tracked: CMT-1315 -->
- **D3 — Decision-Completeness is a reviewer added to spec-converge**, reusing the parallel-reviewer
  harness; one more reviewer, one more criterion.
- **D4 — "Work the Blocker" ships as an OPERATIONAL STANDARD under "A Wall Is a Hypothesis,"** not
  a new top-level article. (Q3 → Justin, 2026-06-10.) The principle is the stance; the ledger
  pipeline is its tactical *how*, hung beneath it with a clear parent link (no orphan rule), per
  the registry's "Two layers" model.
- **D5 — Maiden voyage is the in-flight Slack judgment-permission work.** Both pieces get their
  first real run there.
- **D6 — `true-blocker` reasons are re-tested on a slow cadence, not settled forever.** (Q1 →
  Justin, 2026-06-10.) Carries a `recheck-after` date; a real **`JobDefinition` with supervision
  `tier1`** (it re-runs the wall inventory — a judgment, per LLM-Supervised Execution) reopens a
  settled entry for one re-walk when due, capped `maxReapsPerPass` with jittered `recheck-after`
  so rechecks don't cluster (round-1 scalability LOW, lessons F9). Re-settle requires NEW evidence
  (see Anti-laundering).
- **D7 — Decision-Completeness applies to ALL specs through spec-converge**, not a size-gated
  subset. (Q2 → Justin, 2026-06-10.) Uniform; the cost concern is handled by Piece 3 delta-gating,
  not by exempting specs.
- **D8 — Cross-model convergence selects models DYNAMICALLY by tier/family, never by pinned name.**
  Strongest = the `'capable'` tier resolved per activated+available framework. Auto-tracks upgrades.
- **D9 — Cross-model convergence is folded INTO spec-converge**, non-skippable but delta-gated;
  mandatory whenever ≥1 non-Claude framework is active at spec-start; advisory-degraded only for a
  genuinely single-framework agent.
- **D10 — Q4 resolved: tie at the `'capable'` tier uses a deterministic tie-breaker** — a
  configurable per-family priority list, defaulting to alphabetical-by-framework — so reviewer
  selection is reproducible (round-1 gemini #4). Cheap-to-change-after (a config default behind the
  dark rollout).
- **D11 — Q5 resolved: NO per-spec `externals: required|advisory` override.** Uniform mandatory
  keeps the standard honest (matching D7); the cost it would have addressed is handled by Piece 3
  delta-gating. (Rejected gemini #3 / round-1 adversarial F5.)
- **D12 — Migration & Agent-Awareness ship IN this PR as v0.1 deliverables** (NON-NEGOTIABLE
  standards). See the Migration & Deployment section.
- **D13 — This spec converges under the CURRENT (pre-change) spec-converge.** The new
  Decision-Completeness reviewer/criterion do not exist on disk during this run; they bind only
  specs converged *after* this ships. The skill's documented bootstrap exception is extended in
  spirit to "a spec that modifies spec-converge runs under the old spec-converge" (round-1
  integration MED, lessons F8).

## Migration & Deployment (Migration Parity Standard — NON-NEGOTIABLE)

- **spec-converge skill content** (Pieces 2 & 3): `installBuiltinSkills` is install-if-missing and
  spec-converge is currently agent-private, so existing agents get NOTHING by default. Resolution:
  first decide scope — **promote spec-converge into the builtin skill set** (so the fleet has it) OR
  formally declare it agent-private and out of fleet scope. If promoted, add an idempotent
  `migrateSpecConvergeSkill()` in `PostUpdateMigrator` (Migration Parity case 5b) that overwrites the
  SKILL.md content for the default-skill allowlist.
- **deferral-detector change** (the auto-open trigger): a built-in hook → **always-overwritten** on
  migration (case 4).
- **Blocker Ledger config defaults**: `migrateConfig()` existence-checked additions for
  `monitoring.blockerLedger`.
- **Dashboard tab + `/blockers/*` routes**: ship via the standard dashboard-asset update path (not
  init-only).
- **Agent Awareness**: `generateClaudeMd()` gains a Blocker Ledger capability block — curl examples +
  the proactive trigger ("when you hit a blocker → it's auto-logged; work it through the ledger"). A
  ledger no agent knows about is the structural-trigger gap (F1) made permanent (round-1 integration
  HIGH#1 + LOW, lessons F6/F7).

## Decision points touched

- Adds two read APIs + one mutating API (`/blockers/*`) — Bearer-auth + `X-Instar-Request` on
  mutations + standard write rate-limit, like all instar mutating routes.
- Adds one reviewer + one convergence criterion to `spec-converge`; tightens *when* the cross-model
  pass may be skipped and makes its model selection dynamic — strengthens existing gates, removes no
  reviewer.
- Extends `resolveModelForFramework` (new `gemini-cli`/`pi-cli` branches + fail-loud canary) — real
  code, in scope.
- Adds one operational standard ("Work the Blocker") under "A Wall Is a Hypothesis" (D4) — requires
  operator ratification of the framing.
- The one judgment the ledger carries (the `true-blocker` settle) is routed through the existing
  Tier-1 B16/B17 authority; no existing gate's blocking authority changes (Signal vs Authority
  preserved).

## Open questions

> Per Principle 2 these must reach zero before convergence. **All round-1 open questions are now
> resolved into Frontloaded Decisions** (Q1→D6, Q2→D7, Q3→D4, Q4→D10, Q5→D11). None remain — this
> spec is, by its own Piece-2 criterion, single-run-completable.

*(none)*

## Testing (Testing Integrity Standard — all three tiers + the gamed-input tier)

- **Unit.** Ledger state machine: illegal/skip transitions refused; `resolved` without a
  live-run-linked, id-referencing, confined-path artifact refused; `true-blocker` without a
  taxonomy-matched reason + failed-attempt rebuttal + B17 pass refused; an `operator-only-secret`/
  `operator-only-account` settle WITHOUT a recorded failed self-fetch attempt refused (self-fetch-
  first mandate); an `access-requested` recorded BEFORE the failed self-fetch/dry-run does not count
  toward settle; re-settle with no new evidence refused; CAS write under concurrent mutation does not
  clobber.
- **Adversarial-input.** An injection-payload `reason` does not alter LLM/reviewer behavior; a stub
  one-line playbook does not satisfy `resolved`; a real blocker cannot reach `true-blocker` by
  skipping states.
- **Integration.** `/blockers/*` return 200 when alive, 503 when dark; the settle audit line is
  written with origin + gate hash.
- **E2E.** Production init instantiates the ledger; a blocker walked candidate→resolved persists and
  reappears after restart; Decision-Completeness refuses convergence on a spec with a live open
  user-decision and converges the same spec once frontloaded.
- **Cross-model (Piece 3).** With a non-Claude framework active, the externals pass is
  refused-skippable on a changed round and delta-skips (with logged note) on an unchanged one; a
  configured-but-absent framework (the codex case) degrades to the advisory note;
  `resolveModelForFramework` returns a real model for `gemini-cli`/`pi-cli` and the canary fails the
  build on a non-model fall-through; a non-allowlisted provider endpoint is excluded from the pass.

## Non-goals

- Not rebuilding the deferral-detector, B16, or B17 — they stay as the detection/authority layer (the
  ledger *feeds off* them via the auto-open trigger).
- Not giving the ledger blocking authority over messages.
- Not enforcing the dark/dry-run/read-only safety phases themselves — Piece 2 only requires decisions
  be frontloaded *or* tagged cheap-because-of-a-named-safety-phase (and contests the tag).
- Not building new model-selection/provider infrastructure beyond the named `resolveModelForFramework`
  extension — Piece 3 otherwise reuses the activated-framework config, intelligence-routing, and the
  subscription-path fallback.
- Not running a model family the agent has no activated+available framework for — that degrades to an
  advisory note / tracked gap (the agnostic floor), never a fabricated or pinned external reviewer.
