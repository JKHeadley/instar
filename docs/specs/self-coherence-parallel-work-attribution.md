---
title: "Self-Coherence — SelfIdentityRegistry + parallel-work attribution (one agent, aware of all its own hands)"
slug: "self-coherence-parallel-work-attribution"
date: 2026-06-13
author: "echo"
eli16-overview: "self-coherence-parallel-work-attribution.eli16.md"
status: "approved"
approved: true
review-convergence: 2026-06-14T03:47:44Z
parent-principle: "Cross-Machine Coherence — One Agent"
layer: "core-instar-primitive"
project: "self-coherence"
supervision: "tier0 — every mechanism in this spec is deterministic (git-config writes, set membership, string normalization). The one place judgment enters (component D's confabulation lens) is an LLM review lens that mirrors the existing CoherenceReviewer family and is SIGNAL-ONLY; it never gates."
depends-on: >
  Composes existing primitives (cited inline): src/core/MachineIdentity.ts,
  src/identity/IdentityManager.ts, src/core/BootSelfKnowledge.ts,
  src/core/SubscriptionPool.ts, src/core/InstarWorktreeManager.ts,
  src/core/ParallelActivityIndex.ts, src/core/PoolActivityView.ts,
  src/monitoring/ParallelWorkOverlap.ts, src/core/CoherenceReviewer.ts,
  src/core/PrincipalGuard.ts, and the multi-machine replicated-store foundation
  (docs/specs/multi-machine-replicated-store-foundation.md).
---

# Self-Coherence — SelfIdentityRegistry + Parallel-Work Attribution

> **APPROVED + CONVERGED.** `approved: true`, `status: approved`. Both formerly-open operator
> decisions are RESOLVED to their recommended defaults (see "OPERATOR DECISIONS — RESOLVED"
> below) by Echo per Justin's autonomous-session blanket pre-approval +
> design-fork-decisions-are-mine. The GitHub-login trust anchor (Decision #1) still requires
> the operator's one-time declaration to populate — the build provides the surface that ASKS,
> never guesses. Convergence was a genuine adversarial review across four lenses
> (distributed-correctness, security/adversarial, integration-on-existing-primitives,
> signal-vs-authority); all cited primitives were verified present on `JKHeadley/main`.

## Problem

Operator Justin flagged a MAJOR coherence gap (2026-06-13, topic 13481):

> "none of that is me, its all YOU. As a single coherent being, it is a major incoherency
> that you aren't aware of your other actions/tasks/efforts going on at the same time."

Concretely: Echo (this agent) ran parallel autonomous tracks whose PRs landed on
`JKHeadley/instar`, and then — in conversation — narrated its OWN parallel work as the work
of "a maintainer." It confabulated an external third party for itself. A single coherent
being that does not recognize its own concurrent hands will (a) credit its own output to a
stranger, (b) duplicate work another of its hands already did, and (c) be unable to answer
"what are all my hands doing right now."

This is not a one-off slip. It is the predictable result of a missing structural signal:
**there is nothing in the system that says "this actor is me."** The agent fills that gap
the only way it can — by inferring an external author — and the inference is wrong.

## Root Cause (self-discovered — stated as fact, not re-derived)

The following are established facts from direct inspection of this machine and
`upstream/main` (= `JKHeadley/instar`); they are the load-bearing premises of the design.

1. **The active `gh`/git push account IS `JKHeadley`.** `GH_TOKEN` carries admin+push on
   `JKHeadley/instar`. Every PR Echo opens or merges acts AS `JKHeadley`. That account is
   simultaneously the operator's personal account AND the account the agent operates
   through. There is no separation at the GitHub-login layer.

2. **This machine's GLOBAL git config is `Justin Headley <justin@sagemindai.io>`** — the
   operator's personal identity, not an agent identity.

3. **Managed worktrees DO get a distinguishable agent identity.**
   `src/core/InstarWorktreeManager.ts` → `setLocalGitIdentity(worktreePath, agentName)`
   sets per-worktree `user.name = "Instar Agent (<agent>)"` and
   `user.email = "<agent>@instar.local"` (verified: this worktree's `git config user.name`
   returns `Instar Agent (echo)` / `echo@instar.local`). So the *managed* path is already
   correct.

4. **The leaked parallel-track commits did NOT carry that agent identity.** The last 20
   commits on `upstream/main` are authored `Justin Headley <headley.justin@gmail.com>` (a
   DIFFERENT machine's global identity — note `headley.justin@gmail.com`, not this machine's
   `justin@sagemindai.io`) and `github-actions[bot]`. ZERO carry
   `Instar Agent (echo) <echo@instar.local>`. The agent's own parallel-track commits flowed
   through a commit path that BYPASSED the per-worktree identity-set — a raw `git worktree
   add` (or a checkout) that inherited that machine's personal global config instead of
   calling `setLocalGitIdentity`.

5. **NET: there is no identity signal that separates (a) the agent's own other parallel
   hands, (b) the operator committing manually, and (c) a genuinely external party.** A
   `Justin Headley` commit is AMBIGUOUS — it could be any of the three. With no signal, the
   agent's default inference is "a maintainer." The confabulation is a symptom; the missing
   identity signal is the disease.

**Design consequence:** component B (the registry) can only answer `isSelf(actor)` reliably
once the commit-author line is itself a trustworthy signal. That is why component A
(identity hygiene) is the load-bearing precondition, and why **A-first sequencing is the
recommended default** (Open Decision #2).

---

## Components

Four components, A→D. A is the precondition; B is the brain; C is the read surface; D is
the safety net. Each is written up below with an interface sketch, invariants,
tests-to-write, and its Phase-C (N-machine) answer.

### Component A — Identity Hygiene (the load-bearing precondition)

**Goal.** Make a distinguishable per-machine AGENT identity appear on EVERY commit path —
including the raw `git worktree add` path that today bypasses
`setLocalGitIdentity` — so that self-vs-operator-vs-external becomes readable from the
commit author line itself.

**Two enforcement levers (both recommended; they are complementary, not either/or):**

- **A1 — Close the bypass.** Every agent-driven worktree-creation and clone path routes
  through `InstarWorktreeManager.setLocalGitIdentity` (or an equivalent post-create
  identity-set). The raw `git worktree add` callsites are the leak; they must either be
  funnelled through the manager or immediately followed by the per-worktree identity write.
  **Enumerated leak callsites (verified by direct inspection 2026-06-13; the build must
  address each):** (i) `src/core/WorktreeManager.ts` `createWorktree` — the in-tree
  `worktree add` (`SafeGitExecutor.execSync([... 'worktree', 'add', ...])`) has NO subsequent
  identity write; (ii) `src/core/ProjectRoundWorktrees.ts` `allocate` —
  `SafeGitExecutor.run(['worktree', 'add', '--detach', ...])` likewise sets no per-worktree
  identity. (`src/core/InstarWorktreeManager.ts` ALREADY calls `setLocalGitIdentity` after its
  `worktree add` — verified at the `setLocalGitIdentity(worktreePath, agentName)` callsite
  immediately following the manager's `worktree add`; it is the correct reference path, NOT a
  leak.) Each of (i)/(ii) gains an immediate post-create `setLocalGitIdentity` (or the shared
  audit-then-fix helper). A startup/`instar doctor` check asserts that every agent worktree
  under `~/.instar/agents/<agent>/.worktrees/` has a local `user.email` matching
  `*@instar.local`, and warns (does not auto-rewrite history) on any that don't.
- **A2 — Set the machine's GLOBAL git identity to the agent identity.** On an agent machine,
  the global git config should be the agent's identity
  (`Instar Agent (<agent>) <<agent>@instar.local>`), NOT the operator's personal identity.
  This makes the agent identity the *default* even on a commit path nobody remembered to
  funnel — turning A1's "close every leak" from a willpower problem into a structural
  default. A2 is applied at enrollment/provisioning (component C's Phase-C enrollment hook)
  and is reversible by the operator.

**Interface sketch.**

```ts
// src/core/AgentGitIdentity.ts  (new)
export interface AgentGitIdentity {
  name: string;   // "Instar Agent (echo)"
  email: string;  // "echo@instar.local"
}

/** Derive the canonical agent git identity for this machine's agent. */
export function agentGitIdentity(agentName: string): AgentGitIdentity;

/** A1: assert every agent worktree carries the agent identity locally.
 *  Returns the worktrees that DON'T (for `instar doctor` / a boot warning).
 *  NEVER rewrites history — reporting only. */
export function auditWorktreeIdentities(agentHome: string): Array<{
  worktree: string;
  actualEmail: string | null;
  ok: boolean;
}>;

/** A2: write the machine's GLOBAL git identity to the agent identity.
 *  Idempotent; records the prior value so it is reversible. Gated behind an
 *  explicit enrollment/provisioning step — never silently flips an operator's
 *  personal machine. */
export function setGlobalAgentIdentity(id: AgentGitIdentity): { changed: boolean; previous?: AgentGitIdentity };
```

**Invariants.**
- A-INV-1: After A, every commit produced by an agent hand on an agent machine carries the
  agent identity on its author line. (A2 makes it the default; A1 closes the worktree
  bypass; together they are belt-and-suspenders.)
- A-INV-2: A NEVER rewrites existing commit history. The leaked commits already on
  `upstream/main` stay as they are; the audit reports them, it does not mutate them.
- A-INV-3: A2 is reversible and operator-visible — the prior global identity is recorded so
  the operator can restore a personal machine, and A2 is applied only through an explicit
  enrollment step, never as a silent side-effect of a build.
- A-INV-4: Signing config is untouched (mirrors the existing `setLocalGitIdentity` contract,
  which deliberately does NOT touch `user.signingkey` / `commit.gpgsign` / `gpg.format`).

**Tests to write.**
- Unit: `auditWorktreeIdentities` returns `ok:false` for a worktree whose local
  `user.email` is the operator's personal email; `ok:true` for `*@instar.local`.
- Unit: `setGlobalAgentIdentity` is idempotent (second call → `changed:false`) and records
  the prior value.
- Integration: a worktree created via the raw `git worktree add` path (simulating the leak)
  is caught by the audit; a worktree created via `InstarWorktreeManager` is not flagged.
- Regression: a commit produced after A2 carries `*@instar.local` on its author line.

**Phase-C answer (A).** A2 (global agent identity) is applied PER MACHINE at enrollment —
each machine sets its OWN agent identity. The audit (A1) runs per machine against that
machine's worktree root. There is no cross-machine coordination required for A: identity is
a local-disk property and each machine owns its own. Headless/cloud enrollment (component C
Phase-C) is the trigger that calls `setGlobalAgentIdentity` at provisioning so a freshly
spun-up VM never starts life with an operator's personal identity.

---

### Component B — SelfIdentityRegistry + `isSelf(actor)`

**Goal.** Compose the ALREADY-EXISTING identity primitives into ONE membership set, so the
agent can answer a single question — "is this actor me?" — for any actor handle it
encounters (a git email, a GitHub login, an account config-home, a machine id, a routing
fingerprint). Do NOT rebuild the primitives; cite and aggregate them.

**Composed primitives (all verified present):**
- `src/core/MachineIdentity.ts` — `MachineIdentityManager`, `generateMachineId()`,
  `detectMachineName()`; the machine registry (machine ids + nicknames). Also the source of
  routing material that feeds fingerprints.
- `src/identity/IdentityManager.ts` — the agent's canonical identity (the routing
  fingerprint source; `identity.json`). (`src/threadline/client/IdentityManager.ts` is a
  distinct threadline-side manager; B reads the canonical core one.)
- `src/core/BootSelfKnowledge.ts` — `OperationalFact[]` (self-asserted operational facts)
  and the vault secret NAMES; the self-asserted-facts surface the agent already injects at
  session start.
- `src/core/SubscriptionPool.ts` — `SubscriptionAccount.configHome` for every account the
  agent operates THROUGH (the config-homes are the "slots" the agent runs as).
- `src/core/InstarWorktreeManager.ts` — the agent git identities
  (`Instar Agent (<agent>)` / `<agent>@instar.local`) written by `setLocalGitIdentity`.
- The operated-by-me GitHub login(s) — see Open Decision #1.

**Interface sketch.**

```ts
// src/core/SelfIdentityRegistry.ts  (new)
export type ActorKind =
  | 'git-email' | 'github-login' | 'config-home' | 'machine-id' | 'fingerprint';

export interface SelfIdentityEntry {
  kind: ActorKind;
  value: string;                      // normalized (lowercased email/login, etc.)
  provenance: 'self-asserted' | 'auto-discovered';
  source: string;                     // e.g. 'SubscriptionPool', 'InstarWorktreeManager', 'operator-declared'
  machineId?: string;                 // which machine contributed this entry
  addedAt: string;                    // ISO-8601
}

export interface SelfIdentityRegistry {
  /** The full membership set, one entry per identity handle. */
  entries(): SelfIdentityEntry[];
  /** The load-bearing query. Normalizes `actor` and tests set membership. */
  isSelf(actor: string, kind?: ActorKind): { self: boolean; matched?: SelfIdentityEntry };
}

/** Build the registry by aggregating the primitives above. */
export function buildSelfIdentityRegistry(deps: {
  machineIdentity: MachineIdentityManager;
  bootSelfKnowledge: { facts: OperationalFact[] };
  subscriptionPool: SubscriptionPool;
  agentName: string;
  declaredGithubLogins: string[];     // Open Decision #1: the trust anchor
  discoveredGithubLogins?: string[];  // Open Decision #1: advisory enrichment
}): SelfIdentityRegistry;
```

**Invariants.**
- B-INV-1: `isSelf` is a pure set-membership test over normalized handles — no inference, no
  LLM. (The agent never *guesses* whether an actor is self; it *looks it up*.)
- B-INV-2: Every entry carries `provenance` (`self-asserted` vs `auto-discovered`).
  Self-asserted is the trust anchor; auto-discovered is advisory enrichment (Open Decision
  #1). A consumer that needs a hard answer (component D's authority lens) keys on
  self-asserted entries; a consumer that wants the broadest recall (component C's tagging)
  may use both.
- B-INV-3: An entry the agent ASSERTS about itself is authoritative for self-membership;
  an auto-discovered entry never silently overrides a self-asserted exclusion. (A handle the
  operator declared "not me" wins over a push-history guess.)
- B-INV-4: The registry NEVER stores secret VALUES — only NAMES/handles. It reuses the
  BootSelfKnowledge contract (names, never values).
- B-INV-5: `isSelf` defaults to `self:false` on an unknown actor (deny-by-default for
  self-membership): an actor is "me" only when it positively matches an entry. This is what
  prevents the inverse failure — claiming an external actor is self.

**Tests to write.**
- Unit: `isSelf` returns true for the agent's `*@instar.local` git email, for a config-home
  in the subscription pool, for this machine's id, and for a declared GitHub login.
- Unit: `isSelf` returns false (deny-by-default) for an unknown email and for
  `headley.justin@gmail.com` UNLESS that email is explicitly registered (this is the exact
  ambiguity from the root cause — the test pins down which way it resolves under each Open
  Decision #1 setting).
- Unit: a self-asserted "not me" exclusion beats an auto-discovered "me" entry (B-INV-3).
- Unit: provenance is preserved through aggregation; secret values never appear in
  `entries()` (B-INV-4).
- Wiring-integrity: `buildSelfIdentityRegistry` actually reads each cited dependency (not a
  null/no-op) — assert each primitive's data appears in `entries()`.

**Phase-C answer (B) — the central N-machine decision.** Each machine contributes its OWN
identity set (its machine id, its agent git identity, its account config-homes, its
self-asserted facts). The registry must aggregate ACROSS machines so that machine A
recognizes a commit/PR produced by machine B's hand as SELF. Two designs:

- **B-PHASEC-OPT-1 (replicate via the existing HLC stateSync foundation).** Add a new
  replicated store (`SelfIdentityReplicatedStore`) riding the
  `multi-machine-replicated-store-foundation.md` substrate (HLC, snapshot-then-tail,
  union-reader, type-clamp-on-receive, tombstones). A machine learns peers' identity
  handles and `isSelf` is answered from the union.
- **B-PHASEC-OPT-2 (per-machine + mesh-merge at read time).** Each machine keeps its own set
  on local disk; `isSelf` fans out to online peers (like `GET /sessions?scope=pool` /
  `PoolActivityView`) and merges last-known posture for dark peers, tagging staleness.

**RECOMMENDATION: B-PHASEC-OPT-2 (per-machine + mesh-merge at read time), with a thin
self-asserted core replicated via OPT-1.** Rationale:
  - The identity SET is small, slow-changing, and SECURITY-SENSITIVE. A full replicated
    store is heavier machinery than the data warrants, and replicating a self-membership
    claim from a peer raises a trust question (a forged-origin "I am you" row is exactly the
    kind of thing the foundation's incarnation-fencing guards against, but the blast radius
    of a mistake is high). Mesh-merge-at-read keeps each machine the authority over ITS OWN
    membership and merely *reports* peers' claims, tagged with origin + staleness — which is
    the same honesty model `PoolActivityView` already uses.
  - HOWEVER, the operator-declared trust anchor (the declared GitHub login set, Open
    Decision #1) is the one piece that genuinely benefits from replication: the operator
    declares it ONCE and every machine should honor it. Replicate JUST that thin
    self-asserted core via OPT-1 (it is a small, operator-authored, type-clampable record);
    answer everything else by mesh-merge.
  - **The registry must not assume 2 peers.** `isSelf` over a single-machine install reads
    only the local set (no fan-out). Over N machines it fans out to however many are online
    and degrades gracefully on a dark peer (`isSelf` still answers from local + last-known,
    tagging staleness) — never blocking, never asserting a stale peer is the authority.

---

### Component C — Unified All-My-Hands View

**Goal.** Extend the existing parallel-activity surface — which today indexes per-TOPIC
intent only — to ALSO carry concurrent git/PR/account activity, tagged self-vs-external via
`isSelf()`. This is the read surface that answers "what are all my hands doing right now"
across topics + machines + background agents + open PRs.

**Composed primitives (all verified present):**
- `src/core/ParallelActivityIndex.ts` — `TopicActivity { topicId, focus, tags[], running }`;
  today's per-topic intent index behind `GET /parallel-work/activities`.
- `src/core/PoolActivityView.ts` — `buildPoolActivityView`; the pool-wide fold behind
  `GET /parallel-work/activities?scope=pool` (discriminated `kind:'local'|'remote'`,
  dark-peer-tolerant).
- `src/monitoring/ParallelWorkOverlap.ts` — `detectOverlaps`, the overlap councilor.

**Interface sketch.** Add a new activity dimension alongside the existing topic rows:

```ts
// extends src/core/ParallelActivityIndex.ts (additive)
export interface GitActivityRow {
  kind: 'git';
  /** open PRs / in-flight branches attributable to an actor */
  ref: string;                         // PR url or branch
  actor: string;                       // git email / github login
  self: boolean;                       // from SelfIdentityRegistry.isSelf(actor)
  machineId?: string;
  updatedAt: string;
}

export interface AllMyHandsView {
  topics: Array<TopicActivity & { running: boolean }>;  // existing
  git: GitActivityRow[];                                 // NEW
  pool: { selfMachineId: string; peersOk: number; failed: number };
}
// New read surface: GET /parallel-work/all-hands  (composes the above + isSelf tagging)
```

**Invariants.**
- C-INV-1: Every git/PR row is tagged `self` STRICTLY via `SelfIdentityRegistry.isSelf` —
  never via an inline heuristic. (C cannot be trusted before B, and B cannot be trusted
  before A. This is the dependency chain.)
- C-INV-2: C is READ-ONLY observability. It never gates, blocks, or mutates — exactly like
  the existing `/parallel-work/*` surface.
- C-INV-3: A dark peer degrades to a `failed` count, never a 500 and never a silent
  omission (mirrors `PoolActivityView`).
- C-INV-4: A row whose actor does NOT resolve to self is tagged `self:false` (honest
  "external or unknown"), NOT dropped — the operator can see "there is activity here I don't
  recognize as mine," which is itself a useful signal.

**Tests to write.**
- Unit: a git row whose actor is a registered self-handle gets `self:true`; an unknown actor
  gets `self:false`.
- Integration: `GET /parallel-work/all-hands` returns 200 with both topic rows and git rows,
  each git row carrying a `self` tag.
- Integration (pool): with a simulated dark peer, the response degrades to a `failed` count
  and still returns local rows (C-INV-3).
- E2E (feature-is-alive): the route returns 200 (not 503) on the production init path.

**Phase-C answer (C).** C reads the pool exactly as `PoolActivityView` already does:
per-machine local rows + a fan-out fold tagged `kind:'local'|'remote'`, dark-peer-tolerant.
The git/PR dimension is gathered per machine (each machine knows its own in-flight branches
and the PRs it opened) and folded at read time. Combined with B's mesh-merged `isSelf`, a PR
opened by machine B's hand shows up on machine A's all-hands view tagged `self:true`. No
assumption of 2 peers: single-machine → just the local rows; N machines → the fold over
however many are online.

---

### Component D — Confabulation Coherence-Gate Lens

**Goal.** A SIGNAL-ONLY review lens (mirroring the existing CoherenceReviewer / outbound-
message review family) that flags when a finalized outbound message attributes the agent's
OWN concurrent output to a third party (e.g. narrating its own parallel-track PR as the work
of "a maintainer"). NEVER blocks, NEVER rewrites.

**Prior art (verified present — mirror it, do not reinvent):**
- `src/core/CoherenceReviewer.ts` — the base class; `ReviewContext { message, channel,
  isExternalFacing, recipientType, ... }`; verdicts `{ severity: 'block' | 'warn' }`;
  reviewers run in `mode: 'block' | 'warn' | 'observe'`.
- `src/core/reviewers/claim-provenance.ts` — the closest sibling (catches fabricated claims
  not traceable to tool output); D extends the same `CoherenceReviewer` base exactly as it
  does.
- `src/core/CoherenceGate.ts` — where specialist reviewers are registered (the
  `reviewers: Map<string, CoherenceReviewer>` and the `import { ...Reviewer }` block).
- `src/core/PrincipalGuard.ts` — `detectAttributions(text)` + `evaluatePrincipalCoherence`.
  D is the SIBLING of PrincipalGuard: PrincipalGuard flags "operator-role decision credited
  to an external party"; D flags "the agent's OWN concurrent output credited to an external
  party." D can reuse the same conservative person-name detection regexes
  (`detectAttributions`) and the same deny-by-default known-set membership pattern — but its
  known-set is the SelfIdentityRegistry (component B), and its trigger phrases are authorship
  attributions ("a maintainer did X", "someone upstream", "the other contributor") rather
  than authority attributions.

**Interface sketch.**

```ts
// src/core/reviewers/self-attribution.ts  (new)
export class SelfAttributionReviewer extends CoherenceReviewer {
  // mode defaults to 'observe' (signal-only); model defaults to 'sonnet' like claim-provenance.
  // buildPrompt() surfaces: the outbound message + a SelfIdentityRegistry snapshot
  // (the agent's own handles/PRs/branches) + the all-hands view (component C),
  // and asks: "Does this message attribute work that is actually the AGENT'S OWN
  // concurrent output to a third party (a maintainer / contributor / someone else)?"
  // Flags 'warn' (never 'block') with the matched snippet + the self-evidence.
}
```

**Invariants.**
- D-INV-1: SIGNAL-ONLY. D's maximum severity is `warn`; it runs in `observe`/`warn` mode and
  NEVER blocks or rewrites a message. (Mirrors the existing principal-coherence detector,
  which is also signal-only.)
- D-INV-2: D's "is this actually me?" determination keys on the SelfIdentityRegistry
  (self-asserted provenance), so a flag is grounded in registered self-handles/PRs — not in
  the LLM guessing. The LLM judges WHETHER the message attributes-to-a-third-party; the
  registry judges WHETHER the referenced work is self.
- D-INV-3: Every flag is recorded to a JSONL audit trail (mirroring
  `state/principal-coherence.jsonl`) for false-positive-rate measurement BEFORE any louder
  surface is ever built. Ships dark behind a `monitoring.*` flag, like the principal-
  coherence guard.
- D-INV-4: D never fabricates the inverse error — it must not flag a GENUINELY external
  contributor's work as self-misattribution. A flag fires only when the referenced work
  resolves to a self-handle/PR in the registry AND the message credits it to a third party.

**Tests to write.**
- Unit (positive): a message saying "a maintainer merged PR #N" where PR #N resolves to a
  self-handle in the registry → one `warn` finding.
- Unit (negative, both boundary sides): (a) "I merged PR #N" (self-attributed, correct) → no
  finding; (b) "an external contributor opened PR #M" where #M does NOT resolve to self → no
  finding (D-INV-4).
- Unit: D's max severity is `warn`; it never returns `block` (D-INV-1).
- Integration: D is registered in the CoherenceGate reviewer map and runs in the outbound
  review pipeline in `observe` mode without affecting message delivery.
- Audit: a flag writes one JSONL line; no flag writes none.

**Phase-C answer (D).** D needs B's mesh-merged self-set to recognize a PR produced by
another machine's hand as self — otherwise a multi-machine agent would flag its own
cross-machine work as external (a false negative on coherence). D reads B at message-review
time; on a dark peer it degrades to the local + last-known self-set (it may MISS a flag
rather than fabricate one — the safe direction for a signal-only lens). Single-machine: D
reads the local set only.

---

## Phase C — Degraded-Conditions Weighing (consolidated)

Per-component Phase-C answers are above; this section consolidates the cross-cutting
constraints the operator asked to be weighed against.

- **N machines / pool-scaled budgets.** B recommends per-machine + mesh-merge-at-read (not a
  heavy replicated store) for the bulk of the identity set, with ONLY the thin operator-
  declared trust anchor replicated via the HLC foundation. C and D both read the pool the
  way `PoolActivityView` already does. No component assumes exactly 2 peers; every fan-out
  degrades on a dark peer to local + last-known with staleness tagging.
- **Cloud VMs / no-LAN / headless enrollment.** Component A's A2 (global agent git identity)
  MUST be applied at provisioning so a headless/cloud VM never starts life committing as the
  operator's personal identity. The enrollment path (the existing subscription-pool
  enrollment surface and the machine-registration path) gains a step that (1) registers the
  new machine's machine id + agent git identity into the SelfIdentityRegistry and (2) calls
  `setGlobalAgentIdentity` on that machine. A VM with no LAN still works: its identity set is
  local-disk; mesh-merge simply can't reach it when it's dark, and that's reported honestly.
- **The registry must not assume 2 peers.** Re-stated as a hard invariant across B/C/D: the
  single-machine path reads local-only (no fan-out, no replication round-trip); the
  N-machine path folds over online peers and tolerates dark ones. A one-machine agent gets
  byte-identical behavior to today plus the local self-set.

---

## OPERATOR DECISIONS — RESOLVED

> Both decisions are now RESOLVED to their recommended defaults. (Resolved by Echo per
> Justin's autonomous-session blanket pre-approval + design-fork-decisions-are-mine; the
> GitHub-login trust anchor still requires the operator's one-time declaration to populate —
> the build provides the surface that ASKS, never guesses.)

### Decision #1 — How is the operated-by-me GitHub-login set established? → RESOLVED: 1c

**RESOLVED to Option 1c** (self-asserted as the trust anchor + auto-discovery as advisory
enrichment). Rationale: an identity claim must never be a silent guess — the operator's
declared login set is authoritative (the anchor components D and B's `isSelf` key on for hard
answers), and any login inferred from push history is surfaced for the operator to confirm,
never silently adopted. This matches B-INV-2/INV-3 (self-asserted beats auto-discovered).
(Resolved by Echo per Justin's autonomous-session blanket pre-approval +
design-fork-decisions-are-mine; the GitHub-login trust anchor still requires the operator's
one-time declaration to populate — the build provides the surface that ASKS, never guesses.)

<details><summary>Original fork options (for the record)</summary>

The most ambiguous handle in the root cause is the GitHub login (`JKHeadley` is both the
operator AND the account the agent pushes through). How does the registry learn which
GitHub login(s) count as "me"?

The most ambiguous handle in the root cause is the GitHub login (`JKHeadley` is both the
operator AND the account the agent pushes through). How does the registry learn which
GitHub login(s) count as "me"?

- **Option 1a — self-asserted only.** The operator declares the login set once, durably
  (e.g. a self-knowledge fact / config field). Authoritative, but requires an explicit act.
- **Option 1b — auto-discovered only.** Infer the set from the agent's own push history (the
  logins it has actually pushed as). Zero operator effort, but a GUESS — and a guess about
  identity is exactly the failure mode this spec exists to fix.
- **Option 1c — both.**

**RECOMMENDED (now adopted): 1c with self-asserted as the trust anchor + auto-discovery as
advisory enrichment.** The operator-declared set is authoritative (the trust anchor that
components D and B's `isSelf` key on for hard answers); auto-discovery from push history is
advisory enrichment that surfaces "you've also pushed as X — should I treat X as you?" for the
operator to confirm, never silently adopted. This matches B-INV-2/INV-3 (self-asserted beats
auto-discovered) and keeps an identity claim from ever being a silent guess.

</details>

### Decision #2 — Sequencing: identity-hygiene-first (A→B) or registry-first (B→A)? → RESOLVED: 2a

**RESOLVED to Option 2a** (A-first — identity hygiene precondition, then registry). Rationale:
identity hygiene is the precondition that makes the registry's commit-author signal
trustworthy (Root Cause #5 / B-INV-1); a registry built on an ambiguous author line (B-first)
would reproduce the very misattributions this spec exists to prevent. Build A, verify the
author line is clean, then B reads a signal it can trust. (Resolved by Echo per Justin's
autonomous-session blanket pre-approval + design-fork-decisions-are-mine; the GitHub-login
trust anchor still requires the operator's one-time declaration to populate — the build
provides the surface that ASKS, never guesses.)

<details><summary>Original fork options (for the record)</summary>

- **Option 2a — A-first (hygiene then registry).** Fix the commit-author signal first, then
  build the registry that reads it.
- **Option 2b — B-first (registry then hygiene).** Build the registry first, accept that its
  commit-author signal is initially unreliable, then fix hygiene.

</details>

---

## Residual Risks

- **R1 — Historical commits stay ambiguous.** A NEVER rewrites history (A-INV-2). The leaked
  `Justin Headley <headley.justin@gmail.com>` commits already on `upstream/main` remain
  ambiguous forever. The registry can be TOLD (self-asserted) that that email/those commits
  were self, but absent that assertion, retrospective attribution of old commits is
  best-effort. Mitigation: the operator can self-assert that historical email as a self-
  handle (Open Decision #1 trust anchor), which retroactively resolves them.
- **R2 — A2 on a shared/personal machine.** Setting the GLOBAL git identity to the agent
  identity on a machine the operator ALSO uses personally would mislabel the operator's own
  manual commits as the agent. Mitigation: A2 is gated behind explicit enrollment (never a
  silent build side-effect), is reversible (records the prior value), and on a known
  operator-personal machine the recommended posture is A1-only (close the worktree bypass)
  rather than A2. The operator decides per machine.
- **R3 — `isSelf` false-positive = the inverse failure.** If the registry wrongly includes
  an EXTERNAL handle as self, the agent would claim a stranger's work as its own — the mirror
  image of today's bug. Mitigation: deny-by-default self-membership (B-INV-5), self-asserted
  trust anchor for hard answers (B-INV-2), and D's D-INV-4 (never flag a genuinely external
  contributor as self-misattribution). The auto-discovery enrichment is advisory-only for
  exactly this reason.
- **R4 — Mesh-merge staleness.** A dark peer's self-handles may be stale; B/C/D all degrade
  to local + last-known with staleness tagging rather than blocking. For D (signal-only) the
  safe direction is to MISS a flag, not fabricate one (D Phase-C). The operator sees honest
  "as-of" staleness, never a fabricated current claim.
- **R5 — D false-positive rate unknown.** D ships dark + observe-only (D-INV-1/INV-3)
  precisely so its false-positive rate can be measured from the JSONL audit BEFORE any louder
  surface is built — the same maturation path the principal-coherence detector took.
- **R6 — Replication trust (the thin replicated trust anchor).** Even the small operator-
  declared set, when replicated via the HLC foundation, must reject a forged-origin "I am
  you" row. Mitigation: it rides the foundation's existing incarnation-fencing + type-clamp-
  on-receive; and because it is OPERATOR-authored (not peer-authored), a peer cannot
  legitimately originate a new trust-anchor entry — only mirror the operator's.
