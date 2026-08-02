# Side-Effects Review — Cartographer Verified Root Authority

**Version / slug:** `cartographer-verified-root-authority`
**Date:** `2026-08-02`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `Plato (item11b1_second_pass) — concurred after fixes`

## Summary of the change

This change adds the inert first half of Item 11B: a typed Cartographer root selector and verifier, plus optional per-root Cartographer state isolation. It distinguishes agent home, active-project checkout, and Instar-source checkout; selects only from explicit provenance; derives canonical Git identity and exact revision; preserves zero-cost structural population when Git HEAD is unreadable; and withholds paid-authoring eligibility unless the selected project/source root is verified. `CartographerTree` keeps its legacy storage path unless a verified-root namespace is supplied. Live navigation, health, and sweep behavior are unchanged in this PR.

## Decision-point inventory

- `selectCartographerRootCandidate` — **add** — chooses a candidate from an explicit typed source; a standalone active-project request without a topic binding is refused instead of falling back to agent home.
- `CartographerRootAuthority.assess` — **add** — deterministically classifies a selected root as verified, structural-only, or refused from canonical filesystem and Git facts, and cannot return a result unless its required structured decision recorder accepts the evidence/rule/outcome row.
- `CartographerRootAuthority.revalidate` — **add** — checks that repository identity and revision still match immediately before a future trusted operation.
- `CartographerTree` state namespace validation — **add** — accepts only authority-shaped opaque namespaces and otherwise preserves the legacy singleton path.
- Live Cartographer routes and sweep startup — **pass-through** — unchanged and still use the existing singleton in this inert PR.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A standalone agent with a correct active project but no topic binding cannot select that project through this authority. This is intentional: accepting the server's agent-home directory as an implicit substitute is the observed failure mode. The corrective action is to establish provenance, not guess.
- A repository selected with an expected remote but with no readable configured remote becomes structural-only, so paid authoring is withheld even if the path is actually correct. This is a deliberate cost/trust floor; zero-cost hierarchy maintenance remains available.
- A selected subdirectory of a valid Git checkout is refused because it is not the checkout top level. Monorepo subproject roots therefore need a future explicit repository-subroot identity design rather than silently inheriting the parent checkout's identity.
- Agent home is never eligible for paid Cartographer authoring, even when agent home is itself a valid Git repository. This prevents the noisy-home sweep. Any future desire to semantically summarize agent-owned state needs a separately reviewed purpose and population contract.

No live request is blocked by this PR because the new authority is not wired to routes yet.

---

## 2. Under-block

**What failure modes does this still miss?**

- A full checkout at an older revision of the correct remote is still a verified identity at that exact revision unless the provenance source supplies an expected revision. The authority reports the revision honestly and supports an exact revision anchor; PR 11B-2 must revalidate before authoring and expose the selected revision. The known-present query is the semantic ground-truth control rather than treating remote identity as content correctness.
- Git remote identity is not a defense against a malicious local administrator rewriting repository configuration. This contract addresses accidental wrong-root and stale-lookalike selection, not host compromise.
- Repository identity does not establish that authored summaries are semantically correct. Summary validation and re-grounding remain separate Cartographer responsibilities.
- A non-Git directory can still receive a structural-only hierarchy. It cannot become trusted or authorize paid authoring, but its path inventory may still be noisy. PR 11B-2 must label that posture and avoid presenting it as verified knowledge.
- Remote normalization folds repository-path case only for `github.com`, where equivalent HTTPS/SSH/scp spellings require it. Unknown/self-hosted forges preserve path case, and non-default ports are identity-bearing. This may conservatively refuse two spellings that a particular forge treats as equivalent; it avoids the unsafe inverse of collapsing distinct repositories.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Candidate selection and repository verification live in a dedicated core authority rather than inside navigation scoring, route formatting, sweep polling, or a configuration directory knob. Existing topic-project bindings remain the provenance source; `SafeGitExecutor` remains the only Git subprocess funnel; `CartographerTree` receives only an opaque storage namespace and does not decide which root deserves it.

The authority is deliberately inert in 11B-1. This keeps root-verification correctness independently falsifiable before 11B-2 changes any live consumer. Reporting, reading, and authoring will be wired together in 11B-2 so the system cannot report one root while operating on another.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.
- [x] Yes — deterministic policy authority over enumerable structural invariants (constrained-domain exception).

None of those stock message-judgment boxes describes this constrained domain exactly. The change adds a deterministic authority over enumerable filesystem/Git invariants, which `docs/signal-vs-authority.md` permits for domains whose valid inputs can be enumerated. It never judges message meaning, user intent, or competing conversational signals. Canonical path, Git top level, configured remote, and exact revision are structured evidence; contradictory identity is refused, missing proof degrades to structural-only, and zero-cost structural observation remains separate from paid-authoring permission. The authority returns a structured trust status and reason for the future consumer to report.

The authority also requires a recorder dependency and emits, for every assessment or revalidation, the provenance-bearing candidate context, normalized expected and observed root signals, the applied rule, and the allow/degrade/refuse outcome. Recorder failure propagates before the outcome is returned. Because 11B-1 has no live consumer, it adds the required and tested contract; 11B-2 must bind it to the machine-local durable decision log at the single live construction seam.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

This adds no static heuristic at a competing-signals judgment point. Root identity is a constrained invariant domain: a selected directory exists or does not, is or is not the Git top level, has a readable exact revision or does not, and matches an explicit repository anchor or contradicts it. Missing evidence degrades trust rather than being balanced against conversational context.

---

## 5. Interactions

- **Shadowing:** no live check is shadowed in 11B-1. Existing routes, population, health, inline refresh, and sweep startup still receive the legacy singleton tree.
- **Double-fire:** no background process or route is added. The authority is called only by tests in this PR.
- **Races:** namespaced state is opt-in and unused by live code. Future consumers must revalidate directly before paid authoring so a HEAD change between initial selection and use becomes a refusal.
- **Feedback loops:** none. The assessment reads filesystem/Git facts and writes no authority state.
- **Existing infrastructure:** Git reads use `SafeGitExecutor`'s closed source-tree read-tier allowance, so the authority can inspect an Instar checkout without weakening destructive source-tree protection. Fetch remotes are read with the allowlisted `git remote -v` rather than general Git-config access. Topic bindings are modeled as provenance inputs rather than duplicated in a new configuration store; omitted namespaces preserve the existing Cartographer storage location byte-for-byte.
- **Decision observability:** every authority outcome passes through one structured recorder chokepoint. Missing/broken recording fails the call instead of returning an unobservable trust decision; the live durable sink is deliberately deferred to the 11B-2 consumer seam because this PR has no runtime construction.
- **MAINTAIN clause:** an unreadable or unborn HEAD produces structural-only eligibility rather than refusal. Its repository-based namespace stays stable when the first HEAD becomes readable, preserving the every-boot hierarchy maintenance path that 11B-2 will exercise live.

---

## 6. External surfaces

There is no live external surface in 11B-1. No route response, dashboard, Telegram behavior, sweep setting, egress path, or user action changes. The new exported core types, required authority decision-recorder contract, and optional tree constructor field are internal developer surfaces. Persistent namespaced directories are created only in tests because no runtime caller supplies a namespace yet.

**Operator surface:** no operator-facing action is added. Topic bindings remain the existing operator provenance surface; 11B-1 neither adds nor changes its UI/API behavior.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** A Cartographer root assessment describes a checkout on one machine: canonical paths, Git worktree roots, configured remotes, and HEAD revisions can legitimately differ across machines. Each machine must resolve and verify its own root from the topic/project provenance available there. Cartographer indexes also mirror machine-local checkout contents and belong in per-machine state; moving a topic to another machine should cause that machine to select and populate its own verified root rather than replicate an index built against a different filesystem.

This PR emits no user-facing notices, creates no replicated durable records, and generates no URLs. The future pool-wide question is “which root did this machine use?”, answered by 11B-2's per-response identity reporting rather than by pretending all machines share a path or revision.

---

## 8. Rollback cost

- **Hot-fix release:** revert the new authority module and the optional namespace constructor support.
- **Data migration:** none in 11B-1; live callers never use the namespaced path.
- **Agent state repair:** none. Existing Cartographer state stays at the legacy location and remains untouched.
- **User visibility:** none during rollback because live behavior is unchanged.

---

## Conclusion

The review supports shipping 11B-1 as an inert substrate after independent review closes. It caused six hardenings before commit: agent-home remains ineligible for paid authoring even when Git-valid; an unreadable HEAD explicitly preserves structural-only maintenance; the tree accepts only authority-shaped state namespaces rather than an arbitrary directory label; Instar-source verification uses the Git funnel's closed read-tier allowance instead of being silently downgraded by the source-tree guard; non-default remote ports and unknown-forge path case remain identity-bearing; and every deterministic trust outcome requires structured decision recording. The known limitations are explicit: identity is not semantic correctness, older same-remote revisions require reporting/ground-truth controls, and monorepo subroots are intentionally not inferred.

---

## Second-pass review (if required)

**Reviewer:** Plato (`item11b1_second_pass`)
**Independent read of the artifact:** initial review found three blockers: real Instar source trees were silently downgraded by `SourceTreeGuard`; remote normalization collapsed distinct explicit ports and unknown-forge path case; and the authority had no required structured decision log. After the fixes, the reviewer concurred: the real Instar worktree verifies with exact revision and remote, port/case distinctions are preserved, and every authority result passes through fail-closed structured recording. The reviewer independently reran the focused suite (34/34) and typecheck.

---

## Evidence pointers

- Focused authority and legacy storage tests: 34/34 passing.
- Broader Cartographer unit suite: 121/121 passing after the final reviewer-fix delta.
- Full repository lint: passing.
- TypeScript build: passing.
- Real Git fixtures cover noisy agent home, stale remote-mismatched lookalike, explicit-port identity mismatch, source-guard-positive Instar checkout, missing HEAD, revision drift, namespace isolation, traversal-shaped namespace refusal, structured decision evidence, and recorder-failure fail-closed behavior.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
