# Convergence iteration log — grok-build-framework-integration

Body-hash-tracked external passes; per-round reviewer outcomes. DESIGN counts
are the convergence-relevant series (criterion: zero DESIGN findings for two
consecutive rounds).

| Round | Internal reviewers | External (codex) | DESIGN findings | PRECISION findings | Standards gate |
|---|---|---|---|---|---|
| 1 | 6/6 ran | ok (SERIOUS ISSUES, 5 findings) | ~28 | ~22 | ran, 0 flags |
| 2 | 6/6 ran | ok (MINOR ISSUES, 5 findings) | ~14 | ~11 | ran, 0 flags |
| 3 | 6/6 ran | ok (SERIOUS ISSUES, 5 findings) | ~10 | ~12 | ran (0 flags) |
| 4 | 6/6 ran | ok (SERIOUS ISSUES, 4 findings) | ~8 | ~9 | ran (0 flags) |
| 5 | 6/6 ran | ok (SERIOUS ISSUES, 4 findings — 3 stale-text consistency, 1 decided-policy justification) | 1 (ceilings-carrier micro-decision — decided same round) | ~8 | ran (0 flags) |
| 6 | 6/6 ran | ok (SERIOUS ISSUES — re-arguments + consistency) | non-quiet (detection-gate/dark-default + session-id resume hazard class; fixes folded same round) | several | ran (0 flags) |
| 7 | 6/6 ran | ok (SERIOUS ISSUES — re-arguments of decided points) | 1 (FOURTH load-path-gap instance: loadConfig never lifted the interactive dual-gate levers — tri-corroborated by security/adversarial/integration; fixed + file-load test tier) | ~4 | ran (0 flags) |
| 8 | 6/6 ran (scalability [], integration [], decision-summary only, lessons 1 PRECISION, security 1 PRECISION, adversarial 1 DESIGN + 1 PRECISION) | ok (SERIOUS ISSUES — 4 findings, all re-arguments of decided points / style; disposition in review-3) | 1 (FIFTH load-path-gap instance: wrapper script's config source was script-ROOT-relative — a path existing in NO real execution context; fixed with the §8 resolution ladder + resolvedConfigPath/inactive observability + wrapper-resolution test tier, verified LIVE) | 3 (drift substring→token equality + both-sides tests; dual-gate conjunction seam extracted + 3-case test; §4.3/§12 language reconciled) | ran (0 flags) |

| 9 | 6/6 ran (scalability [], integration 1 DESIGN, decision-completeness [], lessons 3 DESIGN + 1 PRECISION, security 1 DESIGN + 1 PRECISION, adversarial 3 DESIGN + 1 PRECISION) | ok (SERIOUS ISSUES — 5 findings: 3 verbatim re-arguments of round-8's decided points, 1 economics FRAMING (folded, §0.3), 1 config-authority boundary (folded as the §8 PRECISION boundary note)) | 8 (SIXTH + SEVENTH load-path-gap instances — the migrated wrapper's MODULE load was dead at its own delivery target, and `getEnabledFrameworks`'s runtime filter never returned grok so its migrations were unreachable; the §2.0 impersonation fence was applied at 2 of 3 sites; grok-build was not an expressible topic pin, so a "grok-pinned" topic silently spawned Claude; the drift canary's 4th inertness mode (a failed probe silenced it forever); the daily ceiling was keyed to $GROK_HOME, multiplying with Decision 9's blessed relocation; §6.1's placement bullet had no carrier; §7's rollback claim omitted pool unenrolment) | 4 (per-lane metered-key policy divergence; the authorship guard's boundary vs a hostile branch; ONE normative binary-resolution order — the spec stated 2 defaults, the code carried 3; the one-shot parity marker's later-opt-in gap) | ran (0 flags) |

| 10 | 6/6 ran (scalability 1 DESIGN, integration 2 DESIGN + 1 PRECISION, decision-completeness 2 DESIGN + 1 PRECISION, lessons 3 DESIGN + 1 PRECISION, security 1 DESIGN (already closed mid-round by an earlier round-10 fix) + 2 PRECISION, adversarial 2 DESIGN + 1 PRECISION) | ok (SERIOUS ISSUES — 5 findings: 3 verbatim re-arguments of decided points, 1 economics framing (folded), 1 session-lane billing reading (folded as a §4.3 correction — the lanes FORCE the vendor kill switch, they do not merely scrub)) | 9 (the FOURTH binary-resolution site — the launchability probe still inlined the pre-fence formula, so a grok pin on a grok-less machine probed the CLAUDE binary, reported launchable, fired NO fallback notice and left the user with silence; the two operator levers honoured by different consumers; the drift canary's FIFTH inertness mode — exit-0 empty stdout; `--spec`/`--context` still ROOT-relative so the installed wrapper could not read a spec at all; the SubscriptionPool runtime allowlist rejecting every grok enrolment (the round-9 predicate-outruns-filter defect in the sibling registry); the set-aware backfill marker re-running a full pass on EVERY deployed agent (a dark-ship break introduced BY a dark-ship fix); §11's third-migration claim overstated — no production parity rule declares grok; §6.0a still naming the legacy ledger path on a MONEY surface; the conversational alias table missing grok, leaving the lane the Topic Profile standard calls PRIMARY unable to say it) | 5 (the ledger's per-OS-user scope caveat; four surviving `$GROK_HOME` ledger references; the §12 parity-test claim certifying a stub rather than production delivery; the `/topic` one-word shorthand; the lessons-aware template lacking the FOUNDATION-AUDIT clause SKILL.md describes — added, plus a migrator carrier so existing agents stop running frozen templates) | ran (0 flags) |

| 11 | 6/6 ran (scalability 1 DESIGN + 1 PRECISION, integration 3 DESIGN + 1 PRECISION, decision-completeness 2 DESIGN + 1 PRECISION, lessons 4 DESIGN + 1 PRECISION, security 2 DESIGN + 1 PRECISION, adversarial 3 DESIGN + 2 PRECISION) | ok (MINOR ISSUES — verdict improved; all 5 folded rather than argued: scope clarity + readability produced the new "Current normative contract" section, §0.5's cost language tightened, the one-OS-user / no-parallel-orchestration launch invariants stated, session lanes declared unacceptable for cost-sensitive automated work until the policy preflight lands) PLUS the first LIVE grok-family review (grok-4.6, MINOR ISSUES — see review-6) | 15 (`resolveConfiguredFramework` could not return grok-build, so a Grok-PRIMARY agent silently resolved to CLAUDE — the deliverable's own defect; the pool's PROVIDER allowlist refused every grok enrolment (round-10's fix was one field short, exactly as that finding predicted); `frameworkBinaryPaths` was never read from config.json (SEVENTH load-path gap — §2.1's rung 2 had no load path); the launchability probe was blind to the interactive gate, so a grok pin bricked a topic with "unexpected start-up error" forever; the meta-replication projection silently dropped grok records under a comment claiming a parity test guarded it (no such test existed); grok fell through to the CLAUDE transcript path, making the age-kill liveness protection a no-op; the drift canary's FIFTH inertness mode (exit-0 empty stdout); the drift note interpolated unclamped multi-line CLI output into a reviewer finding; `--spec`/`--context` were still ROOT-relative in the installed wrapper; TWO more binary-resolution sites (boot registration + the reviewer door) inlined partial ladders; the phase-5 delivery chain was broken THREE ways (a module neither script could import, a script with no delivery entry, and a writer frozen since June behind a prior-hash gate); CMT-1299 — the carrier for ~15 deferrals and all 8 stall-matrix closePaths — turned out to be a USER-owned pre-work commitment whose criterion §0.0 declares unestablishable) | 7 (the migrator predicate still naming pi-cli; the shared-enum carrier needing a named test; the lessons-aware template's stale P1-P10 range; the dashboard's "no quota reading YET" for a permanent condition; the `/topic` one-word shorthand; §11's undeclared third migration; invariant 5's unqualified "byte-identical") | ran (0 flags) |

| 12 | 6/6 ran (scalability 1 DESIGN + 1 PRECISION, integration 2 DESIGN + 2 PRECISION, decision-completeness 3 DESIGN + 1 PRECISION, lessons 2 DESIGN + 2 PRECISION, security 3 DESIGN + 1 PRECISION, adversarial 4 DESIGN + 1 PRECISION) | ok (MINOR ISSUES, second consecutive — 5 findings: structure (decided), budget-lock (FOLDED — the accepted race is now closed), phase A/B split (FOLDED as explicit acceptance criteria), drift blocking-after-N (declined with reasoning), glossary (partially folded)) | 12 (the ELI16 companion gate REFUSED this spec and 16 others on a root-relative frontmatter path — the branch could not have passed its own commit gate, invisible until round-11's delivery fix made it reachable; `sessions.frameworkBinaryPaths` became HTTP-writable, so one Bearer call could redirect any framework's executable — a hole opened BY the round-11 rung-2 fix; grok enrolment set CLAUDE_CONFIG_DIR, a var grok ignores, so a second account would silently clobber the first; two reviewer templates shipped fleet-wide with absolute author-machine paths; the enrolment wizard's flow kind for xai handed the phone a URL with no device code; a grok-DEFAULT agent's every headless job would have thrown after the round-11 default-framework fix; the reviewer lane skipped §2.1 rung 2; subscriptionEnums unified 2 of its 4 sets, leaving the same drift class on the other two; CMT-1317 enumerated 7 of ~16 deferrals; §1 still carried the unqualified byte-identical claim the precedence rule makes govern; the CLAUDE.md note was an undeclared 4th fleet-wide surface; raw vendor stopReason interpolated into a flag string) | 8 (npm-prefix memo residual; the .bak once-only bound; §7's operator-vs-agent carrier scope; the §6.1 pool-vs-file contradiction; the eli16 refusal diagnostic's unusable path; the awareness note's pin condition; the enrolment PATH lane; the guard regex narrower than its claim) | ran (0 flags) |

| 13 | 6/6 ran (adversarial 3 DESIGN + 1 PRECISION, security 3 DESIGN, lessons 4 DESIGN + 2 PRECISION, integration 4 DESIGN + 2 PRECISION, scalability 1 DESIGN + 3 PRECISION, decision-completeness 3 DESIGN + 1 PRECISION) | ok (MINOR ISSUES, third consecutive — 5 findings: Phase A extraction (FOLDED as an acceptance section), "open questions: none" overstating closure (FOLDED — a known-unknowns table with 8 rows and their carriers), append-only ledger now (DECLINED, already the stated pre-growth requirement), tool-deny enumeration (DECIDED), terminology (partially folded)) | 18 (BOTH phase-5 structural gates refused the spec — the "(none — …)" prose parses as two open questions, so the convergence tag could not have been written; the budget-lock concurrency test COULD NOT FAIL (synchronous code driven through Promise.all) and its control failed for the wrong reason; the QuotaTracker null-weekly fix was framework-BLIND, changing job scheduling for every non-grok agent with no knob and no rollback; the config-API fence had a second door (the file editor writes .instar/config.json); the closed-lane fallback hardcoded claude-code with no availability check and contradicted three normative sections; the carrier split was recorded in prose and NOT applied — all 21 markers still said CMT-1317 and four items were carried by neither commitment; the auth-expiry attention item has no code raising it; two Standard-A machine-local markers were substantively wrong; the enrol route has no provider allowlist at all; a third unclamped vendor-text sink) | 9 (npm-prefix residual; the lock's two named residuals; the busy-wait precondition on the deferred ledger wiring; a truncating reviewer indistinguishable from an absent one; the .bak operator-facing line; the ledger's backup posture; Phase B's acceptance-vs-scope label; a test title claiming a check its body does not perform; a grok-specific reason string emitted for other frameworks' accounts) | ran (0 flags) |

| 14 | 6/6 ran (adversarial + security pending at log time; lessons 2 DESIGN, integration 2 PRECISION (MINOR ISSUES), decision-completeness CLEAN) | ok (SERIOUS ISSUES — 5 findings: 4 are the same structure/scope/minimize-surface complaint DECLINED across five rounds with reasons; 1 genuine and folded — the graduation bar promised the daily ceiling is "never silently exceeded" while §8 discloses per-machine + fail-open) | 3 (the closed-lane fallback's "binary genuinely present" check was satisfied by the CLAUDE binary, so a Grok-primary agent listing codex-cli without codex installed would have spawned Claude under a codex label — §2.0 impersonation one framework over, promoted from a dormant arm by round-13's own selector; the carrier pass was still TWO items short — a FOURTH instance; the stall matrix asserted an auth-expiry attention raise that no code performs) | 3 (both operator-ratified-exception markers cite an author deferral rather than an operator act — ratification is OWED; the third vendor-text sink; §8's degrades-signal carrier reference) | ran (0 flags) |

| 15 | 6/6 ran (adversarial 2 DESIGN, security 1 DESIGN + 1 PRECISION, lessons 1 DESIGN + 1 PRECISION, integration 1 DESIGN + 1 PRECISION, decision-completeness 1 DESIGN) | ok (MINOR ISSUES, fourth in five rounds — 4 of 5 findings are the structure/scope/ledger-storage set DECIDED across six rounds; 1 folded: §7's unqualified "nothing differs" while the scoping lives two sections away) | 6 (the round-14 impersonation guard closed one direction and left the INVERSE open — on a grok-primary agent `config.claudePath` holds the GROK binary, so label claude-code resolved onto grok and would have spawned it through the CLAUDE builder with NONE of the grok lane's billing/confinement controls, defeating invariant 1 on the deliverable's own shape; a bare command name was accepted as "present", pre-empting a working framework; §6.1's text described round-12 behaviour while the shipped code was framework-scoped, untested either way; the OWED-ratification obligation added in round 14 was itself uncarried — a FIFTH instance; §9 still asserted the auth-expiry raise the matrix had just declared unbuilt; a third `operator-ratified-exception` row still claimed the ratification was held) | 5 (a fourth vendor-text sink not on a proven durable path; the dangling "row above" pointer; an unvalidated framework string reaching the fallback; the lock control measured only ~25% sensitive; §9's missing marker) | ran (0 flags) |

Round 15 produced the most serious finding of the run, and it came from
reviewing round 14's own repair: closing an impersonation path in one direction
had opened the inverse, which bypassed every billing and confinement control on
exactly the configuration the spec exists to deliver. The fix replaces both
directional guards with one rule — a fallback may use only a framework's OWN
explicitly-keyed binary, present on disk — which also closed the bare-name and
unknown-string variants. Separately a security reviewer EXPLOITED the round-13
file-editor fence twice (case-insensitive filesystem; symlink checked against
the requested rather than the resolved path), writing to the real config file and
to a hook body — the latter breaking that deny list's stated invariant that a PIN
compromise must never yield code execution. Both closed with tests, the
case-fold verified against the unfixed comparison.

Round 14 is the first round whose DECISION-COMPLETENESS pass came back CLEAN,
and the first where the external verdict's findings were mostly a
five-rounds-decided disposition rather than new information. The carrier defect
recurred a FOURTH time, so it stopped being treated as a lesson and became a
structure: the spec now carries a marker→carrier TABLE a reviewer can check with
four API calls, replacing the prose assertion that failed three corrections in a
row. The impersonation finding is the one that mattered — it was created by the
previous round's fix, and the control run confirms the guard is what stops it.

Round 13 was the sharpest round on the AUTHOR's own work rather than the
design: the two most consequential findings were a test that could not fail
(with a control that failed for the wrong reason) and a fleet-wide behaviour
change hiding inside an additive-only spec. Both were mine, both from round-12
fixes. The lock's real control was re-run properly — 6/6 recorded with mutual
exclusion, 3/6 without — and that measured number replaced the false claim in
§8. The carrier defect recurred for the THIRD time and is now fixed item-by-item
against three commitments' live text rather than asserted in prose.

Round 12's shape repeated round 11's: most findings were defects in round-11
fixes or claims those fixes licensed, and the two most serious — a gate that
would have blocked this branch's own commit, and an HTTP-writable
executable-selection lever — were both consequences of earlier fixes rather
than of the original design. Two reviewers independently reported the
subscription-enums half-unification, and one reported a fix landing mid-review
(the tree changed under it) and correctly dropped the finding rather than
reporting stale state. Every fix carries both-sides tests; five were verified
against a control run with the fix reverted.

Round 11 was the largest DESIGN round since round 1 — and the reason is worth
recording: it was the first round in which reviewers were told to VERIFY the
previous round's fixes by execution rather than review the document again.
Nine of the fifteen findings were defects in round-9/10 fixes or in claims those
fixes licensed. The recurring shape is now named in the spec: a value the types
admit but a runtime set refuses, and a claim whose carrier does not exist.
Every fix carries both-sides tests; four were verified against a control run
with the fix reverted.

Round 10 was NOT quiet either: 9 DESIGN findings. Two are notable for what they
say about the review itself — one reviewer caught that a round-9 fix's own test
had a passing condition NARROWER than the claim it certified (`--detect-only`
returns before any spec file is read, so it could not fail on the very defect
that shipped), and another caught that a round-9 fix INTRODUCED a dark-ship
break. Every fix this round carries both-sides tests; the three that could be
falsified were verified against a control run with the fix reverted.

Round 9 was NOT quiet: 8 DESIGN findings, all confirmed against source or by
EXECUTING the artifact (never argued from the document), all fixed in-round
with both-sides tests — two of them verified by a control run with the fix
reverted. The convergence counter therefore restarts: two consecutive
zero-DESIGN rounds are still required.

Cross-model per-round outcomes (for aggregateRoundOutcomes): r1 ok, r2 ok,
r3 ok, r4 ok, r5 ok, r6 ok, r7 ok, r8 ok, r9 ok, r10 ok, r11 ok, r12 ok, r13 ok, r14 ok, r15 ok — the spec-level flag is
the clean `codex-cli:gpt-5.5`. Round 11 additionally carries the first LIVE
`grok-build:grok-4.6` pass (review-6), which is a THIRD family rather than a
replacement for either standing one.
gemini-cli: not authed on this host for every round (recorded; the
mandatory-check window shows codex active, so externals ran every round —
never skipped).

Per-round internal model disclosure (D7): all six internal reviewers ran as
Claude subagents on the authoring session's model (claude-opus-5) every
round; the external family is gpt-5.5 via the codex CLI door.

## Round 16 (external verdict SERIOUS ISSUES; 2 folded, 2 declined)

Code freeze held — no source file changed between round 15 and round 16, so the
external pass read a quiet tree.

**Folded (1):** the marker→carrier table was built so a reviewer could CHECK
deferral coverage rather than trust prose, but it depended on live
`GET /commitments/…` calls. A reviewer reading the spec cannot make those calls,
so the structural fix was unauditable in exactly the review protocol it was
written for. Commitment text is immutable, so the six carriers (CMT-1317, 1319,
1321, 1325, 1327, 1328) are now inlined verbatim as frozen refs — read live on
2026-08-15 and quoted, so the table is self-contained.

**Folded (2):** §0.5 rejected the API path partly on ECONOMICS while §0.0 says
the billing sink is unknown and every run is budgeted as metered. Those cannot
both stand. The rejection is now grounded on reviewer INDEPENDENCE (session
auth, no key, so the review door refuses key-based auth structurally rather than
by policy), on token caps we control locally rather than a vendor meter we
cannot read, and on the operator's actual goal — an agent that RUNS on grok,
which the API path cannot deliver at all. The 17% observation is retained as
evidence about the reported cost field, not as the reason.

**Declined (2):** phase scope (seventh round — the normative contract, the
Phase A acceptance section and the Phase B Scope relabel are the answer;
splitting the document would make it LESS accurate about what the branch holds)
and the unopted-agent surface (round 15 folded the §7 sentence; invariant 5
enumerates the four surfaces and §11 declares the migration).

Round 16 produced 2 DESIGN findings. The counter restarts: two consecutive
zero-DESIGN rounds are still required. Round 16 external: ok (codex-cli:gpt-5.5).

## Round 17 (the heaviest round; ~18 DESIGN findings — full detail in review-12)

Six internal reviewers + the external pass on a frozen tree. Unlike rounds
13-16 this round's findings are mostly in SHIPPED CODE, and three were live on
the operator's machines: a config file that was write-fenced but freely
readable (yielding the dashboard PIN and auth token to any Bearer holder), a
grok-only agent booting with NO intelligence provider at all (the outbound tone
gate — an always-on safety floor — silently inactive, reported as "no Claude
CLI available" on a machine where Claude is installed), and a fifth
impersonation site where the triage spawner would have run grok with Claude
argv and an unscrubbed XAI key.

Two of the round's findings are holes opened by ROUND 16's own fence. That
makes four consecutive rounds whose defects were concentrated in the previous
round's fixes.

Three results worth carrying forward beyond this spec:

- **Measured, not argued:** grok validates flag NAMES (unknown flag → exit 2,
  so a renamed safety flag fails the spawn closed in the argument parser) but
  NOT flag VALUES (a bogus tool name → exit 0, silently). A deny list is
  therefore open-by-default against vendor tool renames. The live lane moved to
  an empty ALLOW list, which removes the residual rather than bounding it.
- **A canary that could not fail, and what widening it found.** The drift test
  covered 3 of 5 frameworks with both self-guards inert (a tautology, and a
  `never` in a file tsc never sees because tsconfig excludes tests/). Deriving
  its list from the canonical one immediately surfaced a REAL defect: pi-cli
  fell through to the Claude transcript path — the exact defect round 11 fixed
  for grok, never swept to the neighbour it shared a root with.
- **An honest downgrade of our own remedy.** The marker→carrier table was called
  "the structural fix, since the lesson alone has failed four times". Running
  the gate proved otherwise: it is a regex, and a nonexistent id, a garbage
  token and a wrong-but-real carrier all pass. The table makes defects FINDABLE
  (three were found by reading it this round); it does not ENFORCE. Calling a
  readability aid a structural fix is the Structure > Willpower violation this
  project's own constitution names.

Round 17 external: ok (codex-cli:gpt-5.5), verdict SERIOUS ISSUES, 4 findings —
2 folded (carrier table unauditable without API access; the §0.5 economics
contradiction), 2 declined for the seventh time (phase split; unopted-agent
surface, which round 15 folded).

The convergence counter restarts. After seventeen rounds this document has not
produced a single zero-DESIGN round.

### Round 17 addendum — what driving the mentee cycle found (review-12 §19-22)

Reviewers read the branch; giving the mentee a real task is a different
instrument, and it found the worst defect of the seventeen rounds.

**The only live lane did not work.** grok's JSON envelope embeds RAW newlines
inside string values (109 raw / 0 escaped on a real run), so `JSON.parse` — and
therefore the adapter's `parseGrokEnvelope` — failed on EVERY multi-line
response. Repaired, both shapes asserted, fix verified failing when reverted.

**Why it survived a live proof — the lesson to carry:** the earlier end-to-end
verification asked grok to reply with one word. A one-line envelope has no raw
newline, parses cleanly, and certifies nothing about the shape the lane carries.
Running against a REAL binary with real tokens did NOT rescue it: the input
shape WAS the defect. **A live proof whose input is narrower than production is
exactly as blind as a unit test that cannot fail** — "we tested it for real" is
a property of the CASE, not the binary. This sits directly beside the
already-recorded "passing condition narrower than what it certifies" class and
should be read as its live-testing twin.

**The mentee corrected the matrix I wrote about his own framework.** Three
findings an outside enumeration structurally could not produce, including a
detection signal I had written that is not runtime-observable at all, and a
missing stop class (in-flight tool hang) now added to the CANONICAL taxonomy
with rows in all five framework matrices — all five validate.

**A false retraction.** I reported zero recorded cycles from the instance
record's inline empty field; cycles live in a separate collection and the cycle
was present. Scope a negative to the store actually queried. A wrong retraction
spends the same trust as a wrong claim, so it is recorded rather than quietly
fixed.

## Round 18 — VERSION ATTRIBUTION (a process error, recorded rather than smoothed over)

I edited the spec WHILE round-18 reviewers were reading it, folding the external
findings as they arrived. A reviewer noticed the document changing underneath it
(2268 → 2299 lines mid-read) and said so. That is the same defect as reading a
test suite's result while editing the tree — committed earlier the same night,
acknowledged, and then repeated on a different artifact within the hour.

So findings from this round are NOT all against one document, and the honest
attribution is:

- **CODE-reading reviewers were unaffected UP TO 04:24, and NOT after.**
  **CORRECTION (and this paragraph originally claimed the opposite):** I wrote
  "the source tree was frozen for the whole round" and then, within the hour,
  began editing `src/core/crossModelReviewer.ts`, `src/core/IdentityRenderer.ts`
  and their tests while reviewers were still running — because round-18 findings
  arrived and I started fixing them. A peer session watching the worktree caught
  it and produced the timestamps (04:24:37, 04:25:27, 04:26:48). The freeze claim
  was false from 04:24 onward.
  What IS true: reviewers that completed before 04:24 read a stable tree, and
  the scalability reviewer confirmed HEAD f16012d29 at its read time. Any
  code-derived line number in a round-18 report should be treated as accurate
  as-of that reviewer's read, not as-of now.
  **This is the third instance in one night of the same shape** — reading a
  test suite while editing the tree, folding spec findings while reviewers read
  the spec, and now claiming a freeze while breaking it. Each time the claim was
  written sincerely and was false within minutes, and each time an outside
  observer caught it rather than my own check. A freeze is a fact about
  behaviour over an interval, so it cannot be established at the moment of
  writing — only by not editing afterwards.
- **SPEC-reading findings** (decision-completeness, and the external pass) saw a
  moving target. The external pass ran FIRST, against the pre-fold document, so
  its five findings are against the version that existed before any round-18
  edit. Decision-completeness overlapped the folds.

The freeze snapshot for the rest of the round is `/tmp/spec-r18-frozen.md`
(2299 lines). Any round-18 spec finding that appears already-fixed should be
checked against that snapshot before being dismissed as stale.

**The generalizable point, now twice-earned in one night:** an artifact under
review is under review — test tree, spec, or anything else. "I'll just fold this
one finding while the others finish" is how a review round stops describing a
real object. The rule is the same one the frozen-tree test run taught: freeze,
then read, then edit.

## Round 18 — ~15 DESIGN findings (full detail in review-13)

The round that EXECUTED instead of reading, and the one where the mechanism
behind rounds 14-18 became unambiguous. Three separate reviewers independently
found round-17 fixes that did not do what they claimed, each of which had been
"verified" by a check satisfied identically by the working and the broken state:

- `--tools ''` as the confinement bound — verified by exit 0 + a valid envelope,
  which is byte-identical whether the flag confines or is discarded. Execution
  showed grok reading a scratch file under the EXACT production argv. Neither
  the empty allow list nor the deny list binds on 1.0.4; what held was grok's
  own approval default, never declared. Fixed with `--deny` rules, measured both
  directions.
- The shadow-file grouping — verified by a test driving `renderIdentity`
  directly, while production reaches it through a caller that passed a
  one-element list, making the grouping a no-op on the only path that runs.
- Reserve-then-settle — verified by typecheck and reasoning; 24 capacity sheds
  closed the ceiling at `runs: 0`.

Also: a grok-only agent has NO outbound LLM gate (found independently by two
reviewers — absent, not misconfigured); the metered-key scrub covered one of
four spawn sites; `pi-cli` fell through to the Claude transcript path (round
11's defect, never swept to its neighbour); vendor policy was unexamined after
eighteen rounds of technical probing; and invariant 5 contradicted §11 in the
section round 17 had just declared governing.

Four corrections to my own writeups are recorded in review-13: a gate credited
with a catch it cannot make, a "BUILT" that meant a file existed, spec
self-counts wrong in both directions, and a freeze I claimed and then broke.

Round 18 external: ok (codex-cli:gpt-5.5), verdict SERIOUS ISSUES, 5 findings —
3 folded (vendor policy, billing premise as non-normative, Phase A scope stated
in the problem statement), 2 declined for the eighth time (phase split, and the
over-complexity argument that follows from it).

The convergence counter restarts. Eighteen rounds, no zero-DESIGN round yet.

## Round 19 — ~25 DESIGN findings (detail in review-14), and an honest read on convergence

The first round whose freeze was ESTABLISHED rather than asserted: snapshot +
sha256 before launch, re-verified midway and at the end, identical throughout.
Contrast rounds 17 and 18, where I claimed a freeze and edited during it, caught
both times by an outside observer.

The mechanism behind rounds 14-19 is now unmistakable: **two round-18 fixes carry
a comment that states the failure class correctly and then commits it in the code
directly below.** The budget admission "fails CLOSED" with a comment recording the
motivating measurement — and the branch is unreachable. The scrub test's comment
says the method "needs no knowledge of which sites exist" — and its hardcoded
filename is that knowledge. A third: the drift canary's list moved to a shared
constant carrying the same subset-permitting annotation that was the original
defect, so the problem moved one indirection up and was reported closed.

Naming a failure class confers no protection against it. All three were caught by
someone RE-RUNNING THE MEASUREMENT against the fixed version — not by the
reasoning, the comment, or the test written alongside.

Ten DESIGN fixes landed, each with a control that fails without it; five spec
corrections including two residuals never previously recorded (`--deny` values
are unvalidated, so the round-18 bound inherits the drift it condemned; and grok
executes server-side X search under full production argv that no flag of ours can
reach). One process failure recorded in full: I edited the shared canonical tree,
reverted it by hand, and verified the reversion.

Round 19 external: ok (codex-cli:gpt-5.5), verdict SERIOUS ISSUES, 5 findings —
3 folded (Phase A acceptance ahead of its evidence, stale precedence sentence,
R0 as a graduation blocker), 2 declined for the ninth time (phase split, and the
coupling argument that follows from it), with the smaller form of the second
accepted: the Phase B blast radius is now an explicit Phase A acceptance risk.

**Convergence judgment, stated rather than deferred:** nineteen rounds, every one
producing DESIGN findings, most of them inside the previous round's fixes. Each
round genuinely improves the artifact and none has yet produced a quiet one. This
loop is not converging on its own, and continuing it unchanged is a decision the
operator should make knowingly rather than one I make by default.

## Round 20 — RE-MEASUREMENT, not another sweep. 5 refutations, 11 confirmations.

Deliberately a different shape, chosen from the evidence rather than the process:
rounds 14-19 concentrated their defects inside the previous round's fixes, and
three times a fix was reasoned from a correct measurement and never re-measured
against itself. So round 20 gave each reviewer ONE job — take a claim, construct
the state it denies, check — with a hard requirement that every claim carry a
control producing a DIFFERENT result, and a 4-call cap on live grok usage with
explicit permission to report "unverifiable within budget" rather than guess.

**It worked, and the refutations share one shape with their predecessors.**

REFUTED 1 — the round-19 "admission fails closed on an unacquired lock" was real
INSIDE the function and dropped at the next boundary: `review()` branched on
`corrupt` and `exhausted` only, so `lock-unavailable` fell through to the spawn
with no reservation held. Round 18 failed because a fact could not cross a
function boundary; round 19 carried it across correctly and dropped it one
boundary later. The test seam returned the verdict, so it passed while the only
caller ignored the value. **A verdict nothing consumes is not a refusal.**

REFUTED 2 — a SIXTH spawn site (`PipeSessionSpawner`), invisible to the round-19
membership test on two independent grounds: it builds a template string rather
than an argv array, and scrubs with shell `unset` rather than tmux `-e`. That
test's own comment names the failure class it was built to fix while its detector
reintroduced the same blindness one syntax over. Same file, same round.

REFUTED 3 — that spawner also computed `launchSpec.envOverrides` (the composed
billing invariant) and referenced it zero times.

REFUTED 4 — the carrier ledger directory was UNTRACKED, so in any fresh checkout
the existence check skipped SILENTLY and the fabricated-marker bypass it was
built to stop passed clean. The header claimed it was "checked in". A claim whose
carrier does not exist, inside the gate for claims whose carriers do not exist.

REFUTED 5 — the round-19 CI scoping INVERTED the failure: at the default checkout
depth a pull_request has no merge base, so the gate fails every PR unconditionally.
A vacuous pass traded for an unconditional red. Plus my own two round-19 checks
disagreed about a shared set: the ratchet filters to new markers, symmetry needs
all of them, and symmetry read the filtered set.

CONFIRMED (each with a control proved able to fail): `--deny` binds (canary
unreadable with real rules, leaked verbatim with bogus ones); the lane still
returns text; `--deny` VALUES are unvalidated and fail open silently; grok runs
model-native server-side X search under full production argv with zero client
tool round-trips; the structural `finally` closes the leak class per-return
handling could not (24 systematic throws leave the ceiling open); pre-spawn auth
refusals consume no slots while a genuine post-spawn failure does; settle-by-id
spares a foreign reservation; double-count could not be produced across four
outcome classes and 8 concurrent reviews; table↔marker symmetry in all three
states; the ratchet tolerates pre-existing markers; the membership scrub catches
the duplicate-scrub case a count-based check would pass; both directions of the
identity fix; the classification controls.

**Round 20 is the first round whose method matched the evidence** — and it found
in one pass what four broad sweeps had missed, because it asked "does this claim
survive re-measurement?" instead of "what else might be wrong?".

## Round 21 — ~30 findings, and one had been shipping to every agent for months

Same method as round 20 (take a claim, construct the state it denies), six
reviewers. Round 20 found 5 refutations this way; round 21 found roughly thirty,
and the largest was not about grok at all.

**THE INSTALLER'S FRAMEWORK LIST WAS A SUBSET OF ITS OWN TYPE.**
`KNOWN_FRAMEWORKS` in `src/commands/init.ts` was annotated
`ReadonlyArray<'claude-code'|'codex-cli'|'gemini-cli'|'pi-cli'>` and contained
three. TypeScript accepts a subset of a union silently, and exhaustiveness
checking never fires (it only helps a `switch` with no `default`). Both refresh
paths filter `enabledFrameworks` through `isKnownFramework` and fall back to
`['claude-code']` on an empty result — so an agent installed to run ONLY on grok
or ONLY on pi had `claudeEnabled` computed as true and a full Claude
`.claude/settings.json` written into it on **every update**. The comment directly
above the constant claimed it had been written to make exactly this "drift-proof
as new frameworks are added". It was the drift.

**Five more instances of the identical shape**, each found by constructing the
state its site claimed impossible:
- the enrollment wizard rejected `grok-build` as unknown while its sibling
  accepted it;
- a topic pinned to grok spawned grok correctly and then REPORTED `claude-code`;
- the user-facing "which engine is driving this" line said `Pi` for grok, because
  the final branch carried no guard;
- two independent readers of `INSTAR_FRAMEWORK` disagreed on precisely the two
  newest frameworks (fixed by giving both one shared alias table);
- `POST /sessions/spawn` rejected a `grok-build` spawn naming grok's OWN model
  with an enumeration of CLAUDE's model ids, and — inversely — ACCEPTED a Claude
  model id into a grok spawn.

**The lint, and the two versions that were not shippable.** v1 flagged 83 sites,
mostly sentences inside comments. v2 diffed every framework list against the
canonical union: 53 findings, most of them deliberate exclusions
(`grok-build` is kept OUT of the internal routing preference on purpose), which
would have needed a suppression marker on ~30 sites. A lint suppressed thirty
times teaches authors to reach for the marker, and the next real defect gets
marked too. The shipped version compares each list against its OWN annotation, so
a deliberate exclusion is written with a narrower annotation and is not a finding.
Its documented gap — a hand-written list with NO annotation — is recorded rather
than papered over. (Round 22 found two such sites by grep, exactly as predicted,
and a third shape the check could not see at all.)

**Token expiry was read from a sidecar, never from the token.** The task list
asked for the session token's expiry to be read from the token itself; the code
read the `expires_at` string sitting beside it and trusted it. Measured against
the live credential the two agree to within 198ms — so nothing was ever wrong —
but nobody had verified that, and a declared expiry that outlives the credential
it describes is the failure being guarded against. Now the JWT is decoded and the
EARLIER of the two wins (`min` is the only safe combinator here), with the
seconds-vs-milliseconds ambiguity handled explicitly rather than assumed: both
wrong readings are silent and opposite (one makes a session never expire, the
other always).

**The dark-ship scope claim went from six surfaces to thirteen**, corrected for
the third round running — four to six, then a count corrected without its list,
now six to thirteen. That recurrence IS the finding: an invariant maintained by
hand-enumeration decays every time the branch grows. The claim being defended
("nothing changes for agents that do not opt in") was retired in favour of one
that is true and checkable: **the grok adapter registers only on opt-in.**

## Round 22 — the round after the suite went green, run solo by re-measurement

No reviewer fan-out. Every finding below came from taking a round-21 claim and
checking it against what is on disk, plus reading the two failures a full suite
run produced. Twelve findings; the category split is the useful part.

**In the integration's own design — one live, one latent:**
- **A SIXTH impersonation site** (`src/commands/route.ts`). `resolveFramework`
  resolved flag → env → hardcoded `'claude-code'`, never consulting the agent's
  configured framework, and the call site paired that label with
  `config.sessions.claudePath` — a field which, on a grok-primary agent, HOLDS THE
  GROK BINARY (a documented back-compat carry set from the configured framework).
  So a bare `instar route "..."` on Groky's own machine built a Claude provider
  around grok's binary: Claude's argv against grok's CLI with none of the grok
  lane's controls. Rounds 15-17 closed five sites of this class; this is the sixth,
  reachable with no fallback and no unusual state. Fixed by falling back to
  `config.sessions.framework` and reading the binary from the canonical
  per-framework map. Scope stated honestly: a CODE-PATH finding, read from
  Config.ts's `claudePath` assignment and this call site, not executed.
- **`EscalationFramework` was a duplicate of the canonical union** reached through
  three `as EscalationFramework` casts, so a sixth framework added to
  `IntelligenceFramework` and forgotten there would compile clean and then have its
  models validated against CLAUDE's list at the spawn route — round 21's defect,
  restored by the copy. `KNOWN_MODEL_IDS`'s comment claimed exhaustiveness "over
  the union"; that was true of THAT union, which was not the one its callers used.
  Now an alias, so the omission is a compile error. Four spellings of this union
  exist; the other three drift VISIBLY (no casts hide them) and are left alone
  with that property recorded.

**In the apparatus built around it — ten:**
- **The round-21 lint was guarding an empty population.** It ran clean and printed
  `compared 0 literal-annotated framework list(s)`. Its self-test fires on a known
  stale list every run, so the detector was demonstrably alive — and inspecting
  nothing, because the fix for the defect it was built from DERIVED the list from
  the canonical union and thereby removed the only instance of the shape it can
  see. A self-test proves the detector can fire; only a population count proves
  anything was looked at. Extended to the named-type idiom (and to type ALIASES,
  after `ESCALATION_FRAMEWORKS: readonly EscalationFramework[]` walked past a
  detector keyed on the canonical name); population is now 5, and deliberate
  subsets are counted as such rather than vanishing.
- **The lint's self-test exercised a function the real scan did not call** — the
  file loop re-implemented the same matching inline. Proof attached to the copy
  that did no work. One implementation now.
- **The concurrency control was flaky, and I had cited it as evidence.** Its
  read→write window was microseconds while the release spread across 12 processes
  is milliseconds, so it observed over-admission on a quiet machine and failed
  during a full suite run — crying wolf under load, which is exactly when the race
  it models is most likely in production. The window is now held open explicitly:
  it widens an existing race rather than inventing one, at the cost that the two
  arms are no longer identical-but-for-the-lock, which is recorded in the file.
- **The scaffold-leak test covered gemini-only and codex-only** — two of the three
  frameworks the round-21 defect never touched. The two it DID touch, grok-only and
  pi-only, had no case. Added; then the pre-fix list was restored to check, and
  exactly the two new cases fail while all four old ones pass. The file had been
  demonstrating the fix on inputs that already worked.
- **The spec contradicted itself on the scope count** — thirteen at the definition,
  six at the site that quotes it. A count corrected without its citations, which is
  round 19's "count corrected without its list" one layer out.
- **The reassurance sentence under that list was false.** "None of the thirteen
  registers an adapter, spawns grok, or spends anything" was written when the list
  was six and carried over the seven that round 21 added. Entry 11 refutes the
  third clause. The first two survive and are now stated at the width the evidence
  supports, with the grok refusal verified in code (`HEADLESS_BUILDERS` dispatches
  `grok-build` to a builder whose body is comments and an unconditional throw).
- **Three alias tables where one belongs** — the canonical one, a hand-written copy
  in the conversational lane (COMPLETE, because round 10 had already caught it
  missing `grok`), and a three-name list in the `instar route` CLI. Correct-today is
  the state a duplicate is in immediately before it drifts. One table now.
- **A `/topic <framework>` shorthand** listing all five by hand, complete and
  unguarded; derived.
- **A `NON_CLAUDE_FRAMEWORKS` set listing three of four** — deleted rather than
  corrected, because nothing read it. A stale list with no consumer is harmless
  until it acquires one, and it acquires one by looking authoritative.
- **`PER_TOKEN_LANE_MODEL_IDS` named every framework but grok** — the one framework
  whose billing sink is UNKNOWN. Absent and empty behave identically; an entry
  states which of the two it is.

**Two process failures of my own, both recorded because they cost a run:**
regenerating a generated artifact and then editing source for five more minutes
before freezing the tree (regenerate LAST), and writing a source-text test whose
negative assertion matched the fix's own comment QUOTING the pre-fix code — caught
on its first execution, fixed by stripping comments before matching and adding a
control that the stripper still leaves executable code behind.

**The honest read on convergence, with the arithmetic rather than a verdict.** Of
round 22's twelve findings, ONE is a live defect in the integration's design and
one is latent. The other ten are in the checks, tests and prose built around it.
The rounds are not getting quieter, but the defects have moved out of the design
and into the scaffolding — and scaffolding is the kind of thing that can be
FINISHED rather than converged.

### Round 22, addendum — the auth-expiry DEADLOCK (found after the suite went green)

Found by checking a live fact rather than reading code, and it began as a false
alarm I nearly sent to the operator.

The stored grok session had expired 31 minutes earlier. `grok models` answered
"You are not authenticated". The message I was one step from sending said Groky
was offline and needed the operator to approve a sign-in. **One cheap real request
refuted it:** the completion succeeded, and the stored expiry advanced six hours
with no human involvement. The CLI holds a refresh token and renews LAZILY, on the
next command that actually needs auth. Confirmed three ways, not one — the
credential file's expiry moved forward, the status command flipped to "logged in",
and the request returned a correct answer.

**The real defect underneath.** `assertGrokAuthAllowed` refused every call on a
past expiry, and the adapter has no renewal path — the only mention of the refresh
credential anywhere in it was a sentence in a comment. So: session lapses → the
gate refuses → nothing invokes the CLI → the CLI never renews → the gate refuses
forever. The reviewer lane went dark after any ~6h idle gap and stayed dark until
a human ran a grok command by hand. **A refusal that blocks the recovery which
would clear it does not fail safe; it converts a transient state into a permanent
one.** Neither half is wrong alone — refusing on an expired credential is right,
renewing lazily is right — and no test of either half could see it, because the
defect exists only where they compose.

**Why admitting is not a billing hole, which is the objection this had to answer.**
The instinct that the expiry gate protects spend is wrong: it is a LIVENESS check
that resembled a safety one. Metered spend is held out by four independent
mechanisms, none of which reads that date — the forbidden-env sweep,
`buildGrokChildEnv`'s allowlist (which deletes every billing var and FORCES
`GROK_DISABLE_API_KEY_AUTH=1` per spawn regardless of which check passed), the
config-credential refusal, and login-policy verification. A failed renewal is
therefore a bounded auth error from a child that still cannot bill. Believing this
one check carried a guarantee that four other mechanisms were actually carrying is
precisely what let a self-sustaining outage look like caution.

**Shipped:** the refusal is narrowed to the terminal case (lapsed AND no renewal
credential on the WINNING auth entry — an older session's token says nothing about
the current one), with the terminal message now naming re-login as the reason.
Expiry and renewability come from ONE parse, because reading the file twice would
be two readers of one source free to disagree — the defect class this branch spent
the day removing. Eleven tests; the control restores the blanket refusal and
exactly the admission test fails while every "still refuses" assertion passes in
both states, which is what makes this a narrowing rather than a bypass. The
stall-coverage row that asserted "re-auth requires a human tap" is corrected in
both directions: it overstated the ordinary case AND missed the actual failure.

**THE FIX WAS REPORTED DONE WHILE HALF-DONE — the round-20 shape, committed by
the round-22 fix for a round-22 finding.** `assertGrokAuthAllowed` is the
transport preflight, and it is NOT the first expiry gate. `detectGrokReviewer`
carries its own, which runs EARLIER: detection refuses → the transport is never
reached → the CLI is never invoked → the session never renews. So the deadlock
survived the fix intact, in the one lane this feature exists for, and I had
already told the operator it was closed.

It was found by checking the SEVERITY claim ("the grok reviewer goes dark")
against the code instead of assuming the fix I had just written covered it. That is
the difference between verifying a fix's CORRECTNESS and verifying its REACH — the
preflight change was correct and insufficient, exactly as round 19's fact crossed
one boundary correctly and was dropped at the next. Both gates are now narrowed
identically, and a sweep of every consumer of the expiry reader confirms there is
no third: the only other reference is a re-export. Three more tests cover the
detection boundary, including a control that the opt-in gate still closes the door
regardless of renewability — an availability fix must not buy itself a dark-ship
break. The 96 pre-existing grok policy tests pass unchanged, because their fixtures
carry no renewal credential and are therefore terminal cases, which is the
compatibility evidence rather than an assumption about it.

**This also corrects a claim made earlier in round 22.** The convergence read
above — one live design defect, the rest scaffolding — was accurate arithmetic and
an over-confident conclusion, and it was refuted 40 minutes later by this, a
second design defect. One round is not a trend.

### Round 22, second addendum — the impersonation class, swept to zero

After fixing the sixth impersonation site (`instar route`) I applied the lesson
from the auth-deadlock's second boundary and asked the reach question instead of
assuming: **is this shape anywhere else?** It was, five more times.

**By hand:** `instar reflect` carried it twice — `frameworkFromEnv() ?? 'claude-code'`
paired with `config.sessions.claudePath` in the primary path, and an unconditional
`{ framework: 'claude-code', binaryPath: claudePath }` fallback with no framework
check at all. The server's relationships fallback carried it once, reachable on a
mixed config (grok primary WITH claude also enabled, so `isClaudeForbidden()` is
false).

**Then the hand-sweep proved insufficient, which is the finding.** I wrote
`tests/unit/claudepath-impersonation-sweep.test.ts` as a class-level check, and on
its FIRST run it found a TENTH site I had just swept past: the topic-summarizer
fallback. Ten sites, five rounds, every previous fix written for the site in front
of me and believed to be the last.

**The test's own two defects, both caught by its controls within a minute:**
- It deleted block comments to avoid matching the fixes that QUOTE the broken code
  — and thereby computed every line number against a shorter file, pointing at
  unrelated code. I read the wrong twelve lines before noticing. Comments are now
  blanked in place, with a control asserting line count is preserved.
- Its matcher required `claudePath` to follow `binaryPath:` IMMEDIATELY, so it
  caught the direct form and walked past the TERNARY form — which is five of the
  ten sites, including both fixed minutes earlier. Fixed by discriminating on what
  PRECEDES the identifier (a property key is preceded by `{` or `,`; a read is
  preceded by a dot), after a `(?!\s*:)` lookahead written to skip property keys
  also swallowed the ternary's else-colon. A detector narrower than the class it
  names, in the check written to close that class.

**One flagged site was a genuine false positive** (`server.ts` provider build:
`framework` is bound from `config.sessions?.framework`, so the ternary can only
pass claudePath when the agent really is claude-primary). It is routed through the
fence ANYWAY rather than exempted: an exemption's premise was a binding on the line
above, which a future edit could invalidate with nobody rechecking the argument.
Uniformity costs nothing in the safe case and leaves the class with **zero
exceptions**, which is a state a reader can verify at a glance.

**The generalisation worth keeping.** Nine of these were found by a human reading
code, across five rounds, each time incompletely. The tenth was found by a
mechanical check on its first run. "Fix the instance, leave the check unbuilt" has
now been the recurring failure of this branch by a wide margin — and the honest
counterweight is that the check I built was itself twice too narrow, so a
mechanical check is not automatically better than reading. It is better because it
runs every time and its controls can prove it still fires.

### Round 22, third addendum — one code change, six stale copies in prose

The auth-deadlock fix corrected the stall-coverage document and stopped there.
Sweeping for the same claim found it in FIVE more places: the spec's NORMATIVE
requirement (§3.1 item 3, which still demanded refusal on bare expiry — so the
shipped code contradicted its own binding contract), §3.1.1's description of the
reader, §9's stall-class paragraph repeating "re-auth requires a human tap by
construction", the plain-English overview, and a code comment above
`detectGrokReviewer` promising a NON-EXPIRED session.

Six copies of one fact, and the first pass updated one. **This is the duplication
class this branch spent a day removing from code — three alias tables, four
framework unions, ten binary-resolution sites — reappearing in prose, where it is
worse, because prose has no compiler and no test to notice.**

**Then the same defect fired twice more inside the fix for it.** Adding a
fourteenth entry to the dark-ship surface list instantly made four sentences
stale, including one I had corrected hours earlier whose text literally reads
"Do not restate the number here; cite the invariant." And while writing the rule
"the list IS the count", I wrote "None of the fourteen…" into the same edit.

So the count is no longer stated in prose anywhere, and
`tests/unit/grok-spec-surface-count-drift.test.ts` enforces it — the live claim
shapes (`N surfaces change`, `None of the N`) fail the build, while historical
narration ("the list was six and the true number is thirteen") is deliberately
exempt and stays, because that history is accurate and worth keeping. It caught
my own "None of the fourteen" on its first run.

Its scope is bounded honestly in its header: it catches the shapes that have
ACTUALLY recurred, not every conceivable restatement. That bound is the point —
five drifts, five instance-fixes, and the check is the first thing in this series
that runs without anyone remembering to.

**Also disclosed in the same change rather than discovered later (entry 14):**
`instar route` and `instar reflect` now honour the agent's own configured
framework instead of defaulting to claude-code. That is a fix — a codex-only
agent's `reflect` was running on CLAUDE — and simultaneously a behaviour change
for agents that opted into nothing, which is exactly what invariant 5 exists to
disclose. Three rounds corrected that enumeration after the fact; this entry was
written in the change that caused it, which is the only part of the pattern still
available to change.
