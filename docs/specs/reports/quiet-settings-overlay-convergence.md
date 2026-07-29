# Convergence Report — Quiet-Settings Follow the Agent (Replicated Operator-Settings Overlay)

## Cross-model review: codex-cli:gpt-5.5

RAN. A real GPT-tier external pass ran through the agent's codex CLI in **every round** (6/6 — rounds 1–6, all `status: ok`, no degraded rounds). Final external verdict: MINOR ISSUES (non-material; each remaining point was wording-precision and was folded into the spec before tagging). This is the clean-pass state.

**Per-round model disclosure (D7):** the internal reviewers ran as subagents of the authoring session (session model: `claude-fable-5`); the external pass ran on `codex-cli:gpt-5.5` every round; the Standards-Conformance Gate (code-backed) ran every round.

## ELI10 Overview

When the operator says "quiet these alerts," that decision today lands in one machine's settings file. A machine that was offline (like the Laptop on July 11) comes back with the old settings and re-floods the operator's phone with alerts they already turned off. This spec gives the agent one small shared "operator decisions" notebook that every machine syncs: quiet decisions go in the notebook, every machine lays it over its own settings on startup, and a machine that rejoins reads the notebook and comes back quiet (after its first sync and one quiet-moment restart — a bounded window of minutes, not the multi-day fork the incident showed).

Only "noise knobs" are allowed in the notebook — settings that change what the operator hears, never what the agent can do. The allowed list lives in code (changeable only by reviewed PR), every value has strict bounds, and "where alerts get sent" is explicitly banned until it can be authority-validated. The three riskiest switches (the ones that turn OFF detectors watching the system itself) got a stronger lock during review: the agent cannot flip them alone — the server itself asks the human for a yes/no, and only the human's authenticated reply commits the change. Every detector-off decision also posts one un-deletable notice, so nothing can ever be quieted invisibly.

The main trade: applying a change to an already-running machine needs a server restart (settings are read at startup), so changes land "at the next quiet moment," bounded by strict rate caps (max 4 overlay restarts per machine per day, never under live work). The feature ships dark, goes to the operator's machines first in observe-only mode, and the final proof is a literal replay of the original incident: quiet a setting with one machine offline, boot it, watch it come up quiet.

## Original vs Converged

- **Alert-routing keys were removed from scope.** The original allowlist included "which topic do alerts go to" keys. Review showed a redirected alert topic is an information-flow change an attacker could abuse (send alerts somewhere the operator doesn't read). Those keys are out until target-topic authority validation exists.
- **The riskiest writes gained a structural human gate.** Originally all writes were single-step with a conversational confirmation. Five reviewers (internal security + adversarial, the constitution gate, the lessons reviewer, and codex) independently converged on the same hole: a misbehaving agent session could quiet the alarms about its own misbehavior. The converged design commits a detector-disabling write only after the SERVER prompts the human operator and matches their authenticated reply against a closed grammar — there is no API path by which the agent can confirm its own request.
- **The confirm flow itself was then hardened through two more rounds:** one open pending per (topic, key) so a stale confirmation can never block an urgent one; a hard cap of 3 pendings per topic and attempt-counted rate caps so prompts and outcome lines cannot flood; message EDITS can never flip a "no" into a "yes"; the operator's identity is re-verified at reply time, not just at request time; and an unconfirmed change always reports back ("nothing was changed") instead of dying silently.
- **Restart behavior got governance.** Originally "the machine restarts at a clean window." Converged: writes coalesce into one level-based marker, minimum 15 minutes between overlay restarts, max 4 per day per machine, the clean-window check re-verified at fire time, and a 24-hour ceiling after which a stuck pending state is surfaced — with the dry-run rung observing pending-only behavior before any auto-restart ever fires.
- **The sync/boot race was designed out.** Boot reads only the local durable store (never waits on the network); a running machine persists incoming records immediately; two named generations (durable vs running-applied) plus a canonical value-hash make every machine's state classifiable as synced / waiting-for-restart / genuinely-buggy — "behind and unaware" cannot exist.
- **Honesty additions:** the first-rejoin window is named exactly (eventual quiet: first sync + one fast-path restart), deletion is documented as "return to each machine's own file" (with a per-machine preview and the SET-a-value alternative when files diverge), conflict overwrites are flagged with both values and writers, and a boot drift canary catches resolution bugs self-vs-self.

## Iteration Summary

| Round | Standards-Conformance Gate | Reviewers who flagged material | Material findings | Key spec changes |
|---|---|---|---|---|
| 1 | ran (1 flag: Testing Integrity) | security, scalability, adversarial, decision-completeness, lessons (+codex minor) | ~19 | Topic-id keys removed; single validation funnel; suppression class + non-recallable notices; restart governance; boot-seam invariant; store path/format; application state machine; generation defined; corrupt-store handling; Test-as-Self tier; boot drift canary; DELETE preview; canonical hash; dashboard out-of-scope |
| 2 | ran (2 flags: Migration Parity, Structure>Willpower) | security, scalability, adversarial, integration, lessons (+codex minor) | ~14 | **Server-driven operator confirm gate for suppression class**; notice delivery non-recallable + persisted dedupe; churn caps + writeCount24h; pending-stale dedupe key; single-applier persistence; generation monotonicity; migrateClaudeMd parity; posture-section cleanup; absent-field peer handling; Standard-B scope note |
| 3 | ran (1 flag: Framework-Agnostic) | security+adversarial, lessons+decision (+codex minor) | 5 | Closed deterministic reply grammar; principal re-verified at reply; explicit no-HTTP-confirm invariant; expiry/decline outcome line; durableGeneration/runningAppliedGeneration naming split; write authority model; effective-suppression clamp tightening; bundle-record rejection rationale; framework-shadow propagation |
| 4 | ran (1 flag: Migration Parity — repeat, judged false-raise; P3 verified PASS by three reviewers) | security+adversarial (lessons+decision: NO MATERIAL) (+codex minor) | 4 | Per-(topic,keyPath) pending scope; 3-open-pendings cap; attempt-counted caps; one-reminder-per-pending; edit-immunity; FD-8 naming; marker-list location; config namespace; overwrite remediation path; DELETE-vs-SET distinction; dry-run rung honesty; attenuation residual named |
| 5 | ran (3 flags: the formalized S>W exemption, No-Manual-Work → structural-floor anchor added, Migration Parity repeat false-raise) | **internal: NO MATERIAL FINDINGS** (+codex minor) | 0 internal | One write-attempt counter (naming); first-rejoin transient window named + rejoin fast-path |
| 6 | — (wording-only round) | (converged; codex wording points folded as polish) | 0 | Bearer capability stated plainly; eventual-quiet phrasing; HLC-uniqueness note; reply-to-independent grammar note |

Externals were delta-gated correctly: every round's body hash changed, so codex ran on all six rounds (never skipped).

## Full Findings Catalog

**Round 1 — Security (3 material):** topic-id redirection as exfil channel (RESOLVED: keys removed from allowlist); HLC clock-skew conflict abuse (RESOLVED: bounded-drift quarantine + suppression notices + threat-model bound); receive-path allowlist bypass (RESOLVED: single shared funnel + whole-record quarantine); DELETE principal unspecified (RESOLVED: topicId + verified principal on DELETE). Minors: census recon leak (declined with rationale — Bearer already grants full API), canary remediation (RESOLVED round 2/4), notice dedupe window (RESOLVED round 4).

**Round 1 — Scalability (2 material):** boot-seam race with journal replay (RESOLVED: boot reads local store only); restart-burst coalescing unbounded (RESOLVED: level-marker coalescing + dwell + daily cap). Minors: pool fan-out (rides shared pool-cache), boot cost, store bounds rationale (all RESOLVED).

**Round 1 — Adversarial (5 material):** restart DOS (RESOLVED: governance bounds); audit-trail staleness under principal change (RESOLVED: setBy = historical fact, authority live-resolved); self-quieting misbehavior (RESOLVED: suppression class → server confirm + non-recallable notice); overlayGeneration undefined / behind-and-unaware (RESOLVED: generation semantics + immediate persist + 3-way classification); single-machine local-write bypass (RESOLVED: one funnel, all paths).

**Round 1 — Integration (0 material).** Minors: advert field wiring named as build work; dashboard scoped out; forward-compat sentence; rollback story (all RESOLVED).

**Round 1 — Decision-completeness (6 material + 1 contested tag):** overlayGeneration mechanics, store path/format, clean-window threshold, state-machine transitions, autoRestartToApply bootstrapping, corruption detection (ALL RESOLVED as Frontloaded Decisions); dashboard cheap-tag CONTESTED-REJECTED (RESOLVED: converted to explicit out-of-scope, not cheap).

**Round 1 — Lessons-aware (3 material):** missing Test-as-Self tier (RESOLVED: fourth testing tier + live-pair incident replay); LOW-tier conflict integration unverified (RESOLVED: UnionReader verified in code + stable-value-across-boots test); missing drift canary (RESOLVED: boot self-vs-self canary).

**Round 1 — Codex (minor):** restart coalescing/locality; tombstone divergence consequence; deterministic intent map; hash canonicalization; topic-id typing; partition E2E cases (ALL folded).

**Round 2 — Security (4 material):** notice filterable by agent (RESOLVED: delivered-at-raise, non-recallable); coalescing hides bursts (RESOLVED: journal audit + writeCount24h + per-key cap); DELETE preview secret exposure (RESOLVED: deleted-key-only, clamped types by construction); suppression-class conversational-only gate (RESOLVED: the server-confirm gate). Minors: census suppression-column exposure (declined with rationale), canary hash-update semantics (RESOLVED), notice dedupe window (RESOLVED).

**Round 2 — Scalability (3 material):** pending-stale dedupe key (RESOLVED: explicit stable-id); immediate-persist amplification (RESOLVED: single-applier batching); generation monotonicity semantics (RESOLVED: applied-only max-HLC, monotone). Minors: canary cost, tombstone-generation interaction, watcher-tick naming, receive-path rate-cap semantics (ALL RESOLVED).

**Round 2 — Adversarial (3 material):** notice dedupe across restarts (RESOLVED: persisted dedupe state); DELETE preview dark peers (RESOLVED: honest "unknown" rows); suppression confirm gate (RESOLVED as above). Minors: canary false-positive ceiling, census recon, quarantined-records-in-generation (RESOLVED: excluded).

**Round 2 — Integration (2 material):** migrateClaudeMd missing (RESOLVED: named with content-sniff guard); operator-ratified-exception ref not machine-verifiable (RESOLVED: surface removed legitimately — a config key inside the already-declared machine-local file is not an independent posture surface; observability noted). Minors: Standard-B scope note, absent-field peers (RESOLVED).

**Round 2 — Decision-completeness: CLEAN** (cosmetic notice-text convention — RESOLVED).

**Round 2 — Lessons (2 material):** Migration Parity (RESOLVED) and Structure>Willpower formalization (RESOLVED: structural gate for suppression class + frontmatter `principal-deferral-approval` for the argued non-suppression exemption). Minors: Test-as-Self verification artifact (RESOLVED: /guards + census artifacts named), context-bloat (RESOLVED: census carries the full list, briefing stays tight).

**Round 3 — Security+Adversarial (3 material):** reply-matching ambiguity, principal-verification timing, "by construction" vagueness (ALL RESOLVED round 4: closed grammar, re-verify at reply, explicit no-route invariant). **Round 3 — Lessons+Decision (2 material):** reply interpretation not frontloaded, post-expiry visibility (RESOLVED: FD 17, FD 18). **Round 3 — Scalability+Integration:** raised "feature not implemented" findings — recorded honestly as out-of-scope category error for a pre-build spec review; its valid items (shadow-marker build-checklist note, autoRestartToApply contest) were folded. **Round 3 — Codex (minor):** generation naming split, authority model, effective-suppression clamps, bundle rationale, glossary (ALL folded).

**Round 4 — Security+Adversarial (2 material + 2 clarifications):** 409 lock-out via one-per-topic pendings (RESOLVED: per-(topic,keyPath) scope); concurrent-pending outcome flood (RESOLVED: 3-per-topic cap + attempt-counted caps); reminder scoping + edit reversal (RESOLVED explicitly). **Round 4 — Lessons+Decision: NO MATERIAL** (3 doc-precision items, ALL applied). **Round 4 — Codex (minor):** attenuation-class confirm suggestion (DECLINED with rationale: clamps keep detectors functional, the operator explicitly approved auto-apply for the noise class, and both internal panels held material=0 here — recorded as external-suggestion-declined); auto-restart first-rollout default (RESOLVED via dry-run-rung honesty); overwrite remediation, DELETE-vs-SET, glossary (folded).

**Round 5 — internal final verification: NO MATERIAL FINDINGS** (5 cosmetic items noted, none blocking). **Round 5 — Codex (minor):** write-cap naming (RESOLVED: one counter, named), first-rejoin window (RESOLVED: named exactly + rejoin fast-path), attenuation re-raise (declined as above), HLC-uniqueness note + reply-to independence (RESOLVED round 6).

**Round 6 — wording polish only;** no new material findings possible surface: Bearer-capability phrasing, eventual-quiet phrasing, HLC uniqueness note, reply-to-independent grammar note.

## Convergence verdict

Converged at iteration 6. The final internal verification round produced zero material findings; the external (codex gpt-5.5) pass ran on every round and its final verdicts were non-material, with each remaining wording-level point folded into the spec before tagging. Zero open questions remain (`## Open questions: none` — all 18 decisions frontloaded). The one deliberate decline (server-side confirm for attenuation-direction non-suppression writes) is recorded above with its rationale and rides the operator-approved `principal-deferral-approval` exemption. Spec is ready for operator review and approval.
