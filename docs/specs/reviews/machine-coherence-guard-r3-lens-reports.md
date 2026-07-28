# Machine-coherence guard — round-3 verification: landed lens reports

The round-3 orchestrating agent died at the 2026-07-03 03:37 PDT credit wall AFTER
committing the round-3 revision (7b8c99b5d) and spawning its verification lenses.
Three lens reports landed after its death and are transcribed here verbatim in
substance (recorded by the session orchestrator). Unknown whether the security /
scalability / decision-completeness lenses or the external (pi gpt-5.5 /
gemini-2.5-pro) passes ran — re-run any that left no artifact.

## Integration lens — CONVERGED (from its lens): 1 MINOR + 2 LOW

Grounding: all new §11 citations ground true, zero drift; 7 older spot-checks clean.
Fold table: R2-M2 FOLD-OK (coherenceAdvert on signed presence pull; carry-forward at
MachinePoolRegistry.recordHeartbeat:229-267 real; survivor pick reads only existing
inputs). R2-M3(iv) FOLD-OK (no mesh config-write verb exists; PATCH /config is
routes.ts:21323 local-only; v1 divergent-is-raiser local write implementable).
R2-N1 FOLD-OK (second enumeration at PeerPresencePuller.ts:254 + :172 confirmed
uncovered by the ratchet test).

1. [MINOR] §3.2/§9 — R2-N1 roundtrip test over-scoped: only 4 of 7
   SESSION_STATUS_ADVERT_FIELDS reach registry storage via recordHeartbeat
   (journalAdvert/commitmentsAdvert/preferencesAdvert flow via driveJournalDelta/
   driveCommitmentsSync/drivePreferencesSync instead). Scope the roundtrip
   assertion to the registry-bound subset (quotaState/guardPosture/
   seamlessnessFlags/servesChannels + new coherenceAdvert).
2. [LOW] §4.2.1(iv) — reachable-but-non-raiser fix-execution bridge unmechanized/
   untested. State v1 mechanizes only divergent-is-raiser + unreachable-holds;
   reachable-non-raiser is conversational/manual — or add the missing test row.
3. [LOW] §4.6 — pendingFix non-survival across corrupt-file re-baseline is implicit;
   add one sentence (fresh episodeId ⇒ pending approval needs re-proposal).

## Lessons-aware lens — NOT CONVERGED: 1 MAJOR + 2 MINOR + 1 LOW

Fold table: R2-M2 FOLD-OK; R2-N1 FOLD-OK; R2-L6 FOLD-OK (tracked marker present).

1. [MAJOR] §4.3 — suspend append is the one un-latched append source on the
   budget-exempt HIGH topic; suspend/resume flapping is per-flap unbounded (P17/P19).
   §4.5's flap-latch bounds close→reopen only; suspend never closes the episode.
   Under the spec's own M5 scenario (HTTP session-status flaps while git beats stay
   alive) the online/offline boundary crosses repeatedly — hundreds of appends
   overnight, no platform budget backstop. P17 requires the bound + a burst test.
   Fix: latch the suspend append (one per suspension episode, FailureEpisodeLatch
   shape) or fold suspend/resume churn into a latched-flapping mode mirroring §4.5;
   add a burst test driving a flapping participant.
2. [MINOR] §4.2.1(iv) — Structure>Willpower seam: reachable-divergent-but-NOT-raiser
   relies on "the agent's session ON that machine performs the write" with no named
   structural trigger. Mitigated (not eliminated) by fixVerifyTicks loud-failure.
   Fix: scope v1 to raiser-is-divergent (direct local) + HOLD all other cross-machine
   writes as pendingFix until that machine's own session acts — or name the trigger.
3. [MINOR] §4.2.1 — fix handles only the SIBLING half of the config-clobber hazard;
   concurrent-writer seam remains. PATCH /config funnel (routes.ts:21323) is raw
   readFileSync→merge→writeFileSync — not the writeConfigAtomic tmp+rename funnel,
   no lock/OCC. Concurrent writer can silently lose a write; non-atomic write can
   truncate config.json on crash. Fix: route the fix write through writeConfigAtomic
   (or a lock); state last-writer-wins residual; state PostUpdateMigrator interaction
   is add-missing-only (it is — existence-checked deep-merge).
4. [LOW] frontmatter — "2026-06-05 partial-config-PATCH clobber hazard" citation
   resolves to no catalogued lesson. Cite GUARD-POSTURE-ENDPOINT-SPEC.md:104
   (one-level-merge warning) or the correct incident.

Positive conformance confirmed: Agent-Proposes/Operator-Approves, Know Your
Principal (ScopeAccretionRatifier shape, authenticated uid vs TopicOperatorStore),
Signal vs Authority, P19 latch shapes — all held.

## Adversarial lens — NOT CONVERGED: 5 MAJOR + 4 MINOR + 1 LOW

Fold table: R2-M1 FOLD-FAIL, R2-M2 FOLD-FAIL, R2-N4 FOLD-FAIL (all three round-2
folds fail on degraded-view seams the folds themselves introduced).

1. [MAJOR] §3.4 — R2-M1 fallback: "raise-silent machines" subtraction set undefined
   and internally contradictory. 3-machine wedged-A walk: globally-consistent reading
   subtracts all → empty set → NOBODY steps up (permanent silence); self-excluding
   reading → B and C BOTH step up (dual-raise). Fix: define raise-silent = the
   priority-ordered elected raiser(s) advertising live yet emitting no covering
   marker past deadline; subtract only those (iteratively for cascades); fallback
   pick = deterministic election over remainder; a standby steps up IFF it is that
   pick (C defers to B by machineId ordering without needing B's marker).
2. [MAJOR] §3.4/§0(b) — R2-M2 reconciliation unresolvable on the blind side of the
   spec-named one-directional HTTP-degradation dual-open: blind non-survivor never
   observes the survivor's marker → orphan persists for the degradation's life.
   Fix: an open item whose other-holder marker cannot be freshly observed AND whose
   skew participant is advert-stale must SUSPEND (degrade to quiet) — or add the
   pool-scope attention merge as a secondary reconciliation-observation channel.
3. [MAJOR] §3.2 — rowsTruncated="covers ALL rows" is the wrong conservative
   direction: a legitimately-large or forged 1-row+truncated marker makes every
   standby defer pool-wide → unalarmed skews (false raise-silence, the §0 cardinal
   sin). Fix: for step-up-suppression, treat an UNLISTED row as NOT covered (fail
   toward raising; reconciliation collapses the duplicate); raise the per-row-hash
   clamp toward the manifest max (~1KB fits the 2KB bound); reserve rowsTruncated
   for genuine pathology and fail LOUD.
4. [MAJOR] §4.5/§4.1 — R2-N4: intra-episode row-join churn uncapped: a row flapping
   confirm/clear/re-confirm inside a still-open episode emits one "row joined"
   append per re-join (~20-40/hr) — per-day cap covers new ITEMS only, flap latch
   keys on reopens. Fix: extend the flapping latch to intra-episode row churn
   (latch a row after N joins in a rolling window → jsonl-only).
5. [MAJOR] §4.2.1 — duplicate/takeover items each carry their own machine-local
   pendingFix; nothing enforces one pendingFix per skew pool-wide. Owner-returns
   walk yields two pendingFixes → operator "fix it" on both topics → two config
   writes + two restarts of the same machine. Fix: reconciliation invalidates the
   non-survivor's pendingFix on superseded-close; fix execution idempotent +
   single-flight per (divergent machineId, key).
6. [MINOR] §3.2/§3.4 — coverage requires a fresh ADVERT but not a content-fresh
   MARKER: a fresh advert can assert coverage of rows the advertiser no longer
   confirms → genuine asymmetric skew suppressed. Fix: pin that a row leaves the
   episode's marker when it individually clears (marker = currently-confirmed rows).
7. [MINOR] §4.6 — disable-mid-episode: spec doesn't pin whether a dark machine keeps
   EMITTING its alarm marker; if dropped, its retained item goes coverage-invisible
   → un-reconcilable duplicate until re-enable. Fix: state a dark machine with a
   retained open episode continues to emit its marker (recompute is part of
   unconditional emission, reads the retained episode file).
8. [MINOR] §3.4 — takeover latched once per (row-identity set, lost owner) forever:
   a flapping owner's SECOND departure gets no takeover (silence). Fix: reset the
   takeover latch when the owner returns and its item reconciles, bounded by the
   finding-4 intra-episode latch.
9. [MINOR] §4.3 — suspend append per offline transition uncapped (same root as
   lessons MAJOR #1). Fold suspend/resume flapping into the intra-episode latch.
10. [LOW] §3.4 — reconciliation survivor pick computed from each holder's own lease
    view; during the lease transition both can compute "I am survivor" → bound is
    max(advertStaleMs, lease-view convergence), not advertStaleMs as implied — or
    break survivor ties purely by machineId (lease-view-independent).

Credit where folds held: fresh-advert requirements present both places;
partial-overlap clean walk loop-free (~3 appends); takeover appends latched;
per-day new-item cap bounds reconcile churn; fix-failure appends operator-gated;
"A recovers mid-fallback" converges to A; episode-reopen flap latch works for its
named path. Detection architecture, manifest/advert design, §5b redesign, episode
close-reason taxonomy drew no adversarial objection.

## Session-orchestrator synthesis

Round-3 verdict from these three lenses alone: NOT CONVERGED — 6 MAJOR total
(lessons 1 + adversarial 5; the lessons MAJOR and adversarial MINOR #9 share the
suspend-flap root), concentrated in §3.2/§3.4/§4.2.1/§4.3/§4.5. Round 4 must fold
these; note the adversarial report explicitly re-executed the round-2 fold WALKS
(round 2 verified citations; round 3 verified behavior) — round-4 verification
must re-execute the same walks against the round-4 text.
