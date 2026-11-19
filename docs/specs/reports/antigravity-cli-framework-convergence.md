# Convergence Report — Antigravity CLI framework and Gemini Enterprise seat provider

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI on every round (rounds 1–6,
plus extra passes on intermediate drafts in rounds 2 and 3, plus a post-cap fix-verification
pass): 10 external reads in total, every one `status: ok`. The Gemini family was
**unavailable** (`gemini-not-installed` on this machine; and Gemini CLI is refused under the
seat anyway, which is part of what this spec fixes). Grok was `grok-not-enabled`. The
clean-door Anthropic second read was not run.

**Reviewer-model disclosure (D7).** The six internal reviewers were requested on Fable 5.2 in
round 1 and every one failed immediately on the Fable usage limit (resets 2026-11-25); those
runs produced nothing and were discarded. All internal reviews that count — rounds 1–6 and
the fix-verification pass — ran on **claude-opus-5-5**, the authoring session's model.

## ELI10 Overview

Justin bought one Google "Gemini Enterprise" seat so Instar agents could use Google's Gemini
models on a subscription. We found that Instar's existing Gemini support does not work with
that seat (Google refuses it), but Google's newer tool, the Antigravity CLI, does. This spec
designs how Instar drives that tool safely.

Before designing, we read Google's rules. Google bans wrapping its tool inside other apps on
*personal* plans, and bans letting other software use its login. On a business seat,
automated use for the owner's own work is described in Google's own docs. So the design only
ever runs Google's own program, never touches its login token, never copies a login between
machines, and never switches Google accounts to get around a limit. One clause is ambiguous,
so the design treats Justin's informed approval as the gate for his own account and Google's
written answer as the gate for any second account.

The biggest practical finding: the seat includes only about $10 a month of Gemini usage,
released in weekly slices of about $2.50 and shared with Justin's own use. So the seat is a
ticket (licence, identity, business terms), not a big tank of capacity. Real capacity comes
from a capped pay-as-you-go top-up on the same account, which Justin has already been asked
about ($30/month cap). The first thing the design delivers is a locked-down mode for one-off
questions and Gemini-family spec reviews; full sessions that can edit files come later,
behind their own security review.

## Original vs Converged

- **Originally**, Instar would run the tool with the owner's login for every lane. **After
  review**, Google's headless docs were found to document exactly that (cached login), a brief
  detour through a second credential type (ADC) was tried and reverted because it created a
  general-purpose Google credential any job could read.
- **Originally**, the "pool is empty" signal, the spending budget, the recovery probe and the
  pay-as-you-go approval were going to be replicated across machines. Three rounds found every
  replicated version unsound (unfenced elections, cross-clock merges, hosts that move with the
  lease, claims that vanish on failover). **After review**, the increment is cut to ONE
  machine per Google project (the "slot host"), named on Justin's approval card and checked at
  every enrolment and launch, so all that state is plain local state. Spreading across machines
  is Phase C's own spec.
- **Originally**, the review budget read a ledger the review script never writes, used a lock
  that steals any lock older than 30 seconds, and had no first-pass seed (it would have refused
  every pass forever). **After review**, it extends Grok's reserve/settle store (per OS user,
  rolling 7 days, dollar reservations, crashed attempts charged at their estimate), runs under a
  real `flock` wrapper, and steps down to a cheaper Gemini model instead of deadlocking.
- **Originally**, a pay-as-you-go approval could be any message from Justin, and the agent could
  re-enable or set billing controls itself. **After review**, only a card tap or a direct reply
  to the existing $30 question counts, bound to the project and cap; the agent never changes the
  billing console on its own judgement, and any mismatch closes the lane.
- **Originally**, Phase A would run under Justin's account before he approved. **After review**,
  nothing touches Google under his account until he taps approve on a card that states the
  terms risk to his own admin account in plain words.
- **Originally**, tool lanes (jobs, interactive sessions) shared a home with the reviewer, had
  a command-name deny list, and could write their own config. **After review**, they get a
  separately signed-in home, a fixed-form allowlist, write-protected config and git hooks — and
  Phase B may not be built until its own security addendum converges.
- A required stall-coverage matrix (§9a) that the Grok precedent mandates was missing in the
  first five drafts and was added in round 5.

## Iteration Summary

| Iteration | Reviewers who flagged DESIGN | Design findings | Left behind (precision) | Spec changes |
|---|---|---|---|---|
| 1 | all six + codex | ~49 | ~20 | Full rewrite: two homes, wall carrier, factory API, identity enforcement, maturation plan, Problem reframed on the $2.50 finding |
| 2 | all six + codex ×2 | ~37 | ~15 | ADC added then reverted; config schema; prober from slot-holders; overage per project; identity at enrolment |
| 3 | all six + codex ×2 | ~31 | ~14 | Memory archive under lock; single reviewer host; dormant wall; observed-tier list; fixture-by-PR |
| 4 | all six + codex | 17 | ~12 | **Scope cut to one slot host per project**; pid lock; reviewer store reshaped; retention owned by adapter; plugin and workspace-config checks; interactive deny floor |
| 5 | security, scalability, integration, decision-completeness + codex (adversarial and lessons: 0) | 8 | ~10 | One agent per project; registry-based fail-closed read; flock supervisor; bound overage approval; model ladder; Phase C predicate; informed FD-4; §9a stall matrix |
| 6 (cap) | all six + codex (all narrow) | 15 | ~10 | flock wrapper; fixed-form grants; FD-16 live-action gate; authority-current check; crash accounting; enrolment lock |
| post-cap | fix-verification (opus) + codex | see verdict | — | Authority record bound to the card incl. slot host `machineId`; P1 per version; FD-11 after FD-4; $0 stop only if ticked; per-attempt reservations; unenrol keeps project decisions; relogin under lock; Phase B security gate |

**Standards-Conformance Gate, every round:** round 1 ran (5 flags); round 2 ran whole-spec
(3 flags — later found truncated at the gate's ~24k read limit); rounds 3–6 ran split on
headings into 4–6 parts (round 3: 33 flags; round 4: 46 flags, one part degraded; round 5: 41
flags; round 6: 45 flags). The gate is signal-only. Its flags were engaged every round by the
lessons-aware reviewer; the recurring themes (fixed numbers under Judgment Within Floors,
deferred multi-machine state, archive retention, maturation wording) are listed under Left
behind with reasons.

## Proportion

Tier 2 (new framework, money and identity, security-sensitive). Spec ~100 KB / ~1,200 lines.
Six rounds used of the six-round cap, plus one post-cap fix-verification pass. The surface is
large for a reason (a new external vendor, a paid seat, the operator's own account), but the
first three rounds' churn came mostly from cross-machine state this increment did not need —
the round-4 scope cut is where the finding count fell sharply. ⚠ Six rounds on one spec is at
the cap; the lesson recorded for next time is to ask "does this increment need multi-machine
state at all?" in round 1.

## Left behind

Precision items not iterated (one line each), and design items accepted at the cap with a
reason:

- Judgment-Within-Floors flags on specific numbers (30 s retry, 1 h→24 h backoff, 14-day
  breaker, 14-day archive, 1 h probe cache, +30 s kill, current+one binaries, 30-day vendor
  silence): each is stated as a default with a basis or an arbiter; the gate's demand for a
  derivation of every boundary is accepted as long-tail.
- Gate "Multi-machine entity" flags on the single slot host: deliberate, defended in §3.1/§10
  and deferred to Phase C's own spec.
- Gate "Archiving may never mean deleting" on the 14-day run archive: classified as telemetry
  (outputs held by callers); accepted.
- Gate "Maturation path" wording (capability-staged vs role-staged): the Maturation plan uses the
  required fields and a throwaway-agent → dev-agent → Phase C ladder; accepted.
- Gate "Documents stand on their own": a symptom of the split check feeding the gate partial
  sections; not a spec defect.
- Reviewer mislabel when a Gemini-authored spec is reviewed (Instar specs are Claude-authored).
- Reviewer store per OS user: agents under different OS users on one machine each get a share
  (the Mama PC has one user).
- Phase C silence-window wording when Google's reply is non-committal (Phase C has its own spec).
- macOS lock / process checks (macOS is refused until P2).
- Interactive "Home busy" refusals of headless jobs are expected outcomes, not stalls (§9a).
- Archive size bound (age-only pruning; idle slots prune on the daily probe).
- Phase B items routed to the **Phase B security addendum** rather than iterated here: child
  processes of allowlisted forms escaping the permission layer; `--sandbox` confinement of
  descendants; symlink resolution in path denies; allowlist binding of interactive grants;
  `pane_pid`-based injectability under the `flock` wrapper. These are security items; they do
  not affect Phase A (tool-less only), and Phase B may not be built until that addendum
  converges (spec §4.2).
- Considered and declined (with reasons in the spec): gating the first live run on Google's
  written answer (replaced by Justin's informed approval); replicated project state, remote
  reviewer passes and a lease-holder identity service for this increment; ADC.

## Full Findings Catalog

Findings are cited inline in the spec as "(round N, <lens> <id>)" at the text each one changed,
which is the durable record of finding → resolution. The per-round reviewer outputs are
summarised in the Iteration Summary above. Key resolutions by lens:

- **Security:** read-side and web confinement unmeasured → P7 canary with positive control,
  plus a canary inside the home (r1–r2); shared home lets tool lanes poison reviewer → two homes
  plus memory archive under lock (r1–r3); ADC reachable by tools → ADC removed (r2); plugins and
  skills unchecked → `builtin/` hash pin (r3); workspace config → schema check plus write-deny
  (r3–r4); interactive deny floor and allowlist auto-resolver (r3–r4); interpreter blocklist →
  fixed-form allowlist, `.git` hooks write-deny (r5); lock inheritance → `flock -o` plus
  process-group kill (r6).
- **Scalability:** reviewer budget read an unwritten ledger → reserve/settle store (r1–r2);
  in-memory mutex → long-hold lock → flock wrapper (r2–r5); lift prober on a slot-less lease
  holder → slot host (r2–r4); Disk Steward carrier did not exist → adapter-owned retention (r3).
- **Adversarial:** no carrier for the pool wall → slot-host local state (r1–r4); unsound merge
  rule → removed (r3–r4); overage per slot and re-application → per project, never changed by
  the agent (r2–r3); identity claims not durable → registry-checked enrolment, card-bound slot
  host (r3–r6); authority record unbound → card-tap-only writer (r6).
- **Integration:** factual errors about replication, status enum, credential paths in the
  git-synced tree, login isolation, enrolment oracle, awareness single-voice, boot-time
  throttle (r1); dual journal registry, skill migration pattern, pool-read URL gap,
  travelBlocker carrier, login pane env (r2–r5); relogin under lock (r6).
- **Decision-completeness:** FD-4 identity consent, overage-ON branch, FD-11 route, undefined
  "high-cadence" limit, contested numbers (r1–r2); support-plan money route, first-pass
  deadlock, spend-limit scope (r2); other project spend (r3–r4); FD-16 against live probes (r5);
  FD-11 and the $0 stop against FD-16 (r6).
- **Lessons-aware:** retry bound mismatched the source, `ownerAgent` tautology, Phase A under
  Justin's identity, burst half undelivered and the $2.50 reframing, maturation plan missing
  (r1); repeat ask (the $30 question already outstanding in message 145713) (r2); approval
  scope for Phase B, overage widening the review share (r3); vendor-gate decline resting on an
  unevidenced acceptance (r4); the agent setting billing controls on its own (r6).
- **Codex (GPT):** mixed-framework configs losing the outbound gate; replay of side-effecting
  work; transient limits walling the project; replication tests passable locally; one owner
  with many identities (r1); OAuth vs ADC, spend-cap enforcement evidence, replay after an
  ambiguous exit, canary proof, stranded walls (r2); hard stop at the approved cap,
  per-machine reservations, scrub crash window, classifier on response text (r3); project
  state per agent, unverified billing states, the lock owner, a single Phase C predicate (r4);
  approval expiry, crash accounting, local enrolment race, the billing gap (r5); slot host
  binding, per-attempt reservations, descendant confinement, unenrolment deleting decisions (r6).

## Experience fit

Source: Justin, topic 145625, message 145637 — "I would like us to move forward with what the
best option is to leverage gemini with a subscription within Instar." His ordinary journey
under the converged design: one approval card (identity, scope, risk stated, slot host,
optional $0 stop), plus the pay-as-you-go question he has already been asked — mirrored as a
card only if still unanswered, never re-asked with a new number. Everything else (sign-in,
probes, the Google support case, the build) is the agent's. Contrasting cases checked: approval
for spec reviews does not stretch to spending (separate card); a loose "yes" in chat does not
approve spending; a second Google account needs its own holder's card. Limit stated honestly:
the Phase A benefit is small without pay-as-you-go (Gemini-family spec reviews inside roughly
$1.25 a week), and the number of passes a week is measured in L3, not assumed.

## Convergence verdict

**Converged at the round-6 cap on the 80/20 basis.** Rounds fell from ~49 design findings to
8 in round 5; round 6's 15 were narrow and each was either fixed in a post-cap edit (verified by
a separate fix-verification read and a final GPT pass, recorded below) or — for the five Phase B
tool-lane security items — routed into a Phase B security addendum that must itself converge
before Phase B is built. No unresolved safety, security or data-loss finding applies to Phase A.
Open questions: none. Ready for the build lane to build **Phase A** (tool-less lanes); the
build ends "merged dark, live checks pending the operator's FD-4 approval".

### Post-cap fix verification

Two independent reads checked the post-cap edits:

- **Fix-verification read (opus):** of ten fixes, seven were consistent; it found two DESIGN
  problems the fixes themselves introduced — the authority record's writer sat on the wrong
  machine (Work Board taps land on the board's host, the record lives on the slot host), and
  the optional "$0 stop" line understated a project-wide hard stop. Both were corrected: the
  slot host pulls and verifies the tap once and writes its own snapshot, checked locally at
  launch; the $0 stop option was removed (the billing gap is disclosed instead). Two
  inconsistencies (relogin waiting on an interactive session; pane liveness under the `flock`
  wrapper being Phase-A-relevant) were also fixed.
- **Final GPT read:** four further DESIGN items inside the fixes — the lock could release
  before cleanup finished; a first-call billing gap; a replacement slot host could reset the
  reviewer budget; a chat "yes" could suppress the FD-4 card. All four were applied as
  concrete rules (the wrapper itself holds the lock and closes it in children; a successful
  OFF observation before any live call; a seven-day reviewer hold on host replacement; the
  card is always presented). Plus one wording fix (the card's chronology on asking Google).

**Honest residual:** the corrections from these two reads were not themselves re-reviewed.
Each read found only smaller items inside the previous fixes, never a new structural problem;
that is the 80/20 point, and review stops here by judgement, not because a round came back
empty. The builder should treat §3.1 (lock), §3.2 step 6 (authority) and §6.4 (billing gate)
as the areas most worth a careful second look during implementation review.
