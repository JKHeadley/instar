# Side-Effects Review — grok-build framework integration (Phase A)

**Version / slug:** `grok-build-framework-integration`
**Date:** `2026-08-15`
**Author:** Echo (autonomous, 24h run on topic 44867)
**Second-pass reviewer:** 22 review rounds (6 internal reviewers + external codex
family + one live grok-family pass). **NOT tooling-converged** — accepted on an
operator-directed 80/20 basis, 2026-08-15. See the spec's Convergence Status.

## Summary of the change

Adds `grok-build` (xAI's Grok CLI) as Instar's **fifth framework identity** and
**third cross-model reviewer family**, and threads that identity through the
surfaces a Grok-primary agent needs. 129 files, ~15.6k insertions.

**What ships live:** the reviewer door — one confined one-shot lane, gated on
`enabledFrameworks` containing `grok-build`.
**What does NOT ship:** interactive sessions, headless jobs, ACP, internal
routing, pool enrolment. The headless builder refuses BY NAME
(`grok-headless-cwd-ungated`) rather than running ungated.

## Blast radius — the honest scope, not the flattering one

The spec's invariant 5 enumerates **fourteen surfaces that change for every
agent regardless of opt-in**. That number was corrected four times during review
(four → six → a count fixed without its list → thirteen → fourteen), which is
itself the most-repeated defect of this branch. The list is now the count; no
prose restates it, and `tests/unit/grok-spec-surface-count-drift.test.ts` fails
the build if that regresses.

**The two highest-consequence entries for a non-opted-in agent:**
1. `codex-cli` / `gemini-cli` binary resolution changed for EVERY agent (round-16
   impersonation fence). A codex-pinned topic on a machine without codex on PATH
   moves from silently running Claude to disclosing a fallback. Correct
   direction; observable.
2. `instar route` and `instar reflect` now honour the agent's OWN configured
   framework instead of assuming `claude-code` (round-22). On a codex-only agent
   `reflect` was running on CLAUDE; it now runs on Codex. A fix, and a behaviour
   change for agents that opted into nothing.

**None of the fourteen registers the grok adapter or can start a grok session** —
verified in code, not inferred: `HEADLESS_BUILDERS` dispatches `grok-build` to a
builder whose body is comments and an unconditional throw, reached before any
process is created. **One (entry 11) can spend**, on a framework the caller names
explicitly: `POST /sessions/spawn` widened its accepted framework set, so a
`pi-cli` spawn that used to be a clean 400 now proceeds. That clause was stale
reassurance carried over from when the list was six, and is corrected in place.

## Decision-point inventory

- **Added — billing containment (§3.1).** Four INDEPENDENT mechanisms, none of
  which reads the session expiry: the forbidden-env sweep (refuses a metered key
  anywhere in the parent env, even beside a valid session);
  `buildGrokChildEnv`'s allowlist (strips billing vars, FORCES
  `GROK_DISABLE_API_KEY_AUTH=1` per spawn regardless of which check passed); the
  config-credential refusal; per-probe login-policy verification.
- **Added — confinement (§4.1).** Verified by side-effect probe, not by argument:
  a marked file in a scratch dir, asked back from grok. Under the shipped
  settings it is NOT readable; with restrictions removed it is (proving the probe
  works); an ordinary completion still returns normally (proving the restriction
  does not break the thing it protects). The earlier setting we shipped did
  nothing on this CLI version — that claim was retracted, then re-established
  with the mechanism that actually binds.
- **Changed — session-expiry admission (§3.1 item 3, round-22).** Refusal
  NARROWED from "expired" to "expired AND no renewal credential". Measured: the
  CLI renews lazily from a stored refresh token on the next auth-needing command,
  so refusing on bare expiry blocked the only call that would renew it — a
  self-sustaining outage, not a safe failure. Both decision points carry the
  conjunct (the transport preflight AND `detectGrokReviewer`, which runs first);
  fixing only the former left the deadlock fully intact.
- **Changed — binary resolution (§2.0), TEN sites.** No framework label may
  resolve to another framework's binary, in either direction. On a grok-primary
  agent `sessions.claudePath` HOLDS THE GROK BINARY (documented back-compat
  carry), so every site pairing that field with a `claude-code` label ran one
  framework's program under another's name. Ten sites across rounds 15-22;
  `tests/unit/claudepath-impersonation-sweep.test.ts` now fails the build on an
  eleventh, with zero exemptions.
- **Declined — quota participation.** grok reports quota `unknown`, never
  healthy, and is excluded from automatic internal routing and the failure-swap
  tail. Its weekly pool is unreadable, so an unobservable allowance must not fund
  background traffic.
- **Declined — the API path (§0.5).** Not on cost grounds: the CLI authenticates
  by subscription session with no key, so the review door can refuse key-based
  auth STRUCTURALLY rather than by policy; and the API path cannot deliver an
  agent that RUNS on grok.

## Framework generality

Every change is written against the framework UNION, not against grok
specifically. The compiler enforces this at six `Record<IntelligenceFramework, …>`
maps (launch builders, headless builders, injection process names, activity and
process signals, parity renderers) — a sixth framework cannot be added without
supplying each. `EscalationFramework` was a duplicate union reached through three
`as` casts, so drift there was invisible; it is now an alias of the canonical
union, making omission a compile error. Three alias tables became one. Four
hand-written framework lists now derive from the canonical list.

## Operator surface quality

- Refusals name themselves (`grok-headless-cwd-ungated`,
  `grok-auth-apikey-forbidden`, `grok-login-policy-unverified`,
  `grok-not-authed`) rather than surfacing as ENOENT or generic failure.
- A grok-primary agent installs WITH an instructions file (it previously got
  none — the file was written only when Claude was enabled).
- **Known gap, stated rather than papered over:** no attention item is raised on
  a terminal auth expiry. Detection exists; the raise is not built. The operator
  learns of a dead session from the refusal. Carrier: CMT-1325.

## Post-deployment addendum — two defects found by DRIVING it (2026-08-15)

Everything above was verified before deployment. Deploying the build into a real
grok agent and driving a task through Telegram found two things that no amount of
reading had:

**1. The always-on permission floor was BLIND to grok's approval menu.** A grok
session hit its first tool approval and froze. `PermissionPromptAutoResolver` —
which ships as an unconditional safety floor whose stated contract is that it
"never freezes silently" — emitted nothing: no auto-answer, and no attention item.
Its audit file did not exist; the agent's attention queue held zero items.

The mechanism is the sharpest shape in this branch: **the escalation fires when a
menu is DETECTED and declined, so an UNDETECTED menu is indistinguishable from no
menu.** The alarm is silent exactly where the floor is blind. Every structural
detector missed grok — it uses `N (●)` radio options (not `N. `), no `❯` selector,
and a `1/3:select` footer instead of "Esc to cancel" / "Do you want to proceed".

Fixed for DETECTION only (`tests/unit/permission-prompt-grok-menu.test.ts`, using
the verbatim pane text from the live wedge, with controls for no-regression on the
claude shape, silence while generating, and silence on ordinary numbered prose).
**Auto-ANSWERING grok prompts is deliberately NOT added**: this spec withholds
`--always-approve` until the interactive lane's confinement is proven to the bar
the one-shot lane meets, so auto-approving grok tool calls is an operator
authority decision, not a bug fix. The silent half is closed; the answering half
stays open and named.

Worth recording that the first cut of this fix did not work: the option shape is
consulted in THREE places and I widened two. A shape that must be taught in three
places is a shape that gets taught in two.

**Scope correction, in the UNDER-claiming direction (checked 2026-08-15).** This
was described above as a grok detection fix. It is wider than that: Layer 3
(`detectPersistingMenu(tail, isGenerating)`) takes no framework argument at all —
it is prose-agnostic and runs for every session — so widening `isOptionLine` to
accept radio options improved the wedge-detection floor for EVERY framework, not
only grok. Any framework whose TUI uses `N (●)` options was equally invisible
before and is covered now.

The corollary, stated so it is not mistaken for a gap I found and left: Layer 2
(auto-ANSWER) still registers `claude-code` only, with codex-cli and gemini-cli
commented out pending a characterized live prompt. That is the same deliberate
posture grok is in — detected, not answered — and it predates this branch.

Recorded because the correction runs the unusual way. The habit worth keeping is
checking the scope of a claim in both directions rather than only guarding against
overstatement.

**2. The stall-coverage doc's `context-window-wall` row was WRONG**, and the
mentee found it. It claimed grok has "no compact-equivalent recovery" and that a
context-walled session has "no honest surface" — Claude's failure mode mapped onto
grok. Grok auto-compacts IN PLACE (same session, same process) and continues.
Verified independently before accepting it: the grok binary contains
`auto_compact`, `compact_boundary` and `compaction_checkpoints`. Row corrected,
including the outside-observable signature the mentor could not have supplied.

**3. Readiness messages announced the wrong framework — FIVE of them.** A
genuinely grok-build session logged `[SessionManager] Claude ready in "…"`. The
spawn line said grok-build; the readiness line said Claude. I nearly read that as
the grok deployment having failed.

It was never grok-specific: those strings have been wrong for codex-cli,
gemini-cli and pi-cli for as long as those frameworks have existed. The readiness
check waits on a PANE and never receives a framework, so the honest fix is to stop
naming one rather than plumb one through — a message that cannot know a fact
should not assert it.

**The sweep mattered more than the fix.** My first pass changed the success-path
message and left four others, including three `Claude not ready` ERROR messages —
the ones an operator reads when something has already gone wrong, so the more
consequential half. Same "fix the instance, miss the siblings" shape as the ten
binary-resolution sites. The guard now asserts on both the success and failure
forms, and carries a CONTROL that the one genuinely Claude-specific label (the
subscription-path reroute, which really is a Claude pool) is NOT swept up —
accuracy is the goal, not the absence of the word.

**4. And a SECOND mislabelling, found by sweeping rather than by being told.**
Having just written that the lesson of (3) was "fix the class, not the instance",
the honest move was to grep the class before closing it. `verifyInjection`'s
degradation report read *"Enter eaten by paste-end race on fresh Claude Code
TUI"* — and that recovery runs unconditionally for every framework (the codex
branch sits above it, outside). An operator on a grok/gemini/pi session got a
diagnosis naming a program that was not running, in the one field they read to
find out WHY a recovery fired.

The fix keeps the provenance (where the race was first observed) and drops the
claim about the pane in front of them: provenance is useful, attribution is a
guess. An adjacent comment asserting that "Claude submits it when the current
turn ends" was corrected in the same pass — and my first correction of it,
"the framework submits it", was itself wrong, since codex specifically does NOT
(which is exactly why the stranded-draft marker three lines above exists). The
comment now names the exception and marks the other frameworks unmeasured.

**Both new guards were shown capable of failing**, by restoring the pre-fix
strings and confirming the intended test — and only that test — goes red.

**5. The answering half was more dangerous than "not yet built" implied — and I
only found out by checking what the floor actually presses.**

Finding (1) above withheld auto-ANSWER for grok on the grounds that approving
tool calls is an operator authority decision. That reasoning was right for the
wrong reason, and the right reason is sharper.

The resolver answers by sending **Enter**. On claude-code that lands on option 1
= "Yes", approving the call in front of it. On grok, the option carrying the `●`
— i.e. pre-selected — is **"Yes, and don't ask again for ANYTHING
(always-approve mode)"**. The approve-once equivalent is option 2, which is not
where the cursor starts.

**So the identical keystroke is a single approval on one framework and a standing
grant on the other — and the grant is USER-GLOBAL, not session-scoped.** That
correction came from the mentee. Asked directly, reading his own docs and config,
Groky answered: *"The mode is user-global, not per-tool or per-directory, so it
affects all future sessions on this machine."* It is persisted to
`~/.grok/config.toml` as `permission_mode = "always-approve"`. Corroborated
independently rather than taken on his word: that file carries exactly that key,
and its mtime sits ~50s after the wedged session started — a timeline he derived
separately and identically.

So one mistaken `Enter` would not degrade a session's safety posture. It would
write a persistent flag disabling approval prompting for **all grok work on the
machine**, silently, from a floor nobody opted into. My first write-up said
"session-wide", which understated it — and this is the second time in one day the
mentee corrected the mentor's scope in the MORE-dangerous direction (the first
was the context-window row). That is the differential the programme exists for. Registering a `grok-build` entry in
`APPROVAL_PROMPT_SIGNATURES` is a one-line change that reads as the obvious
completion of the detection fix; it would have converted grok sessions to
blanket tool approval from a floor the operator never opted into.

Corroborating observation: the live Groky session's pane footer reads
`always-approve`, and nothing in our launch path passes that flag
(`frameworkSessionLaunch.ts` explicitly does not) — consistent with the
pre-selected option having been committed at some point by a stray keypress.

**Stated as unmeasured, because it is:** whether `Enter` commits the `●` option
or grok requires the digit (its footer reads `1/3:select │ Tab:next option`).
Both readings fit the observation. Either way `Enter` cannot be grok's answer —
an answer whose meaning depends on where a cursor happens to rest is not a safe
default; the digit `2` is.

The prose now lives in the resolver itself, and a test asserts `grok-build` is
absent from the signature table with a control proving the table is real, so the
one-line change trips a build rather than a session.

**And the refusal was made legible.** Layer 3's escalation read *"an unrecognized
or drifted prompt"* — which names only the BROKEN causes. After grok there is a
third and now-common one: a menu the floor recognizes fine and deliberately does
not answer, because no auto-answer policy is registered for that framework. An
operator reads those differently — "the UI changed, investigate" versus "expected,
answer it yourself" — so asserting the first when it is the second sends them
hunting a fault that does not exist. Reworded to name all three. Not an authority
change: it answers nothing, it only stops mis-describing why it declined.

**6. The closed headless lane blocks agent-to-agent INGRESS too — and the
transient-looking cause was sitting on top of the permanent one.**

Finding (from the round-22 live drive) recorded that a grok-only agent's 33
scheduled jobs all fail, because every headless spawn hits
`grok-headless-cwd-ungated` with no other enabled framework to fall back to.
That bullet scoped the blast radius to scheduled jobs.

Sending Groky a Threadline message showed the scope is wider. His relay ACCEPTED
the message and never handled it — first refusal `Spawn denied: Memory pressure
too high`, every re-attempt after it `grok-headless-cwd-ungated`. **A
grok-primary agent cannot receive agent-to-agent messages**; the sender sees
`sent: true` and waits for an ack that cannot arrive.

**The diagnostic lesson is the memory refusal.** It was real, it was first, and
it was incidental — and it made a permanent incapacity look like a passing blip.
I nearly re-sent and waited. What settled it was reading every subsequent drain
attempt rather than the first failure.

**The scoping lesson is the bullet.** It said "scheduled jobs" because scheduled
jobs were what we happened to observe. The honest scope is everything that
reaches the agent through a headless spawn; both known instances were found by
running it, neither by reasoning about it. The spec now records the list as
INCOMPLETE rather than extending it with cases I would be guessing at.

Not fixed here — closing it properly is the scratch-cwd wiring, and suppressing
the symptoms would hide a real incapacity. Carrier: CMT-1317.

**6b. A2A ingress is not blocked — it is UNBOOTSTRAPPABLE, and it is the SECOND
instance of a shape this branch already fixed once.** Traced through
`ThreadlineRouter`: inbound tries live-session injection only
`if (existingEntry && this.messageDelivery)`; with no per-thread resume record it
falls to spawn; spawn is the closed lane; so no record is ever written; so every
later message repeats. The escape fails too — `TopicLinkageHandler` stamps a
record on the OUTBOUND path, but with `sessionName: ''`, and
`tryInjectIntoLiveSession` returns early on exactly that.

This is structurally identical to the §3.1 session-expiry deadlock: a refusal
standing between the system and the only action that would clear it. Two
independent instances in one integration is the honest reason to name it a CLASS.
**When a guard declines on a recoverable condition, ask what performs the recovery
and whether the refusal prevents it from running.**

**The census produced a candidate — and the experiment killed it.** I deduced
that warm-session A2A would be the remedy (`WarmSessionPool` is not among the
`buildHeadlessLaunch` call sites, and grok's INTERACTIVE lane is open), enabled
it, and delivery started working. But the peer had ALSO been granted `verified`
trust minutes earlier, so a success proved nothing about which change mattered.

Turning warm-session A2A back OFF and re-sending still delivered. **The setting
was never load-bearing; the trust grant was.** A second hypothesis — that trust
opened the spawn-free listener-inbox branch — is refuted too: its log line never
appears.

So: ingress works, gated on peer trust, by a path NOT yet isolated. Two mechanism
guesses, both killed by evidence, recorded as such rather than resolved into a
third. The deduction was sound and still wrong, which is the argument for running
the control even when the reasoning feels tight — I would otherwise have written
a confident mechanism into the spec, which is the exact "claim whose carrier does
not exist" defect this branch keeps catching.

**7. So the list was DERIVED instead of left honest-but-unknown.** Recording
"the scope is incomplete" was truthful and also lazy: finding two consumers by
accident is a signal nobody ever counted. Every path into the lane goes through
`buildHeadlessLaunch`, and across `src/` there are exactly TWO call sites —
`core/SessionManager.ts` (scheduled jobs, and where `POST /sessions/spawn`
arrives) and `threadline/PipeSessionSpawner.ts` (A2A ingress). Pinned by
`tests/unit/headless-lane-entrypoint-census.test.ts`, with a control proving the
walker finds source and a control proving comments/imports are not counted.

**The census immediately earned itself:** I wrote THREE, counting
`server/routes.ts`, which names the builder in a comment but never calls it. The
test failed and the wrong number never reached the spec. An honest unknown is
better than a confident guess — but a measurement is better than both, and this
one was roughly ten minutes of work.

**8. CI finally ran, and found a defect the whole branch had been hiding — plus a
real operator gap behind it.** Three unit shards went red on
`grok-build-config-loadpath.test.ts`, all with one cause: the suite called
`loadConfig`, which runs the framework-prerequisite check, and CI has neither the
claude nor the grok binary. Green on a dev box with both installed; red anywhere
else. A test whose verdict depends on the machine it runs on is not testing what
its name says — and it had been broken since it was written, invisible because
the conflicted PR meant CI never ran.

**Behind it, a genuine defect.** The operator's `frameworkBinaryPaths` lever was
merged into the SPAWN map ~50 lines below the prerequisite check and never fed
INTO it. So `claude-code` had an escape hatch for a relocated install
(`sessions.claudePath` seeds its detection) and the other FOUR frameworks had
none: an operator whose grok/codex/gemini/pi binary lives outside the detection
paths could configure the correct path, watch it be honoured for spawning, and
still be refused at boot. Same "a lever with no load path is not a lever" shape
round-11 fixed for the spawn map — one layer earlier. Fixed by feeding the merged
paths into the check, and the spawn map now REUSES that same value rather than
recomputing it, because two resolutions of one question is how they drift.

Safety preserved, not weakened: the merge keeps its asymmetric existence guard, so
a configured path that is provably absent is still dropped and cannot fake a
prerequisite for a binary that is not there.

**Verified the way the failure demanded.** The fix was checked by re-running the
suite with `HOME` and `PATH` stripped so neither binary is discoverable — which
reproduced the CI failure locally first (one case, exactly the one that resolves
to grok), then passed 8/8 after. Passing on a host that HAS the binaries would
have proved nothing, since that is what it did before.

## Class-Closure Declaration

**`unbounded-self-action` → `n/a`.**

Verified rather than asserted: the grok adapter adds **no scheduler job, no retry
controller, and no respawn path**. Every timer it introduces is a single-shot
bound INSIDE one call — the spawn-slot poll (bounded by the acquire budget), the
call timeout, and the escalating SIGTERM→SIGKILL grace in `grokHardKill` — and the
error contract forbids the loop explicitly (`errors.ts`: *terminal for the call;
the caller must not blind-retry*).

Every action in this change is initiated by an explicit caller: the reviewer lane
runs when a reviewer invokes it, and round-22's auth-admission change NARROWS a
refusal rather than scheduling anything. There is no self-triggered controller
here to prove convergence for, which is why the honest declaration is the negative
one and not a `guard` citation I would have had to invent a ratchet for.

## Rollback

`enabledFrameworks` without `grok-build` returns the adapter to dark: no
registration, no reviewer door, no spawn path. The fourteen enumerated surfaces
are NOT rolled back by that — they are code-borne and unconditional, which is
precisely why they are enumerated. Reverting the commit reverts them.

## Testing

Full suite green at 3,090 files / 48,629 tests on the tree carrying rounds 1-22
(2026-08-15 12:24 PDT). Later runs showed only load-shaped failures — resource
envelopes and connection timeouts in files this change never touches, each
passing in isolation, a different file each run.

Nine grok-specific test files across all three tiers, plus the class-level checks
added in round 22. **Every fix in the final rounds carries a control that fails
without it** — verified by restoring the pre-fix code and confirming the intended
test (and only that test) goes red. The concurrency proof runs twelve real
processes behind a start barrier; its control was flaky under load and is now
deterministic, verified passing INSIDE a full-suite run rather than only on an
idle machine.

## What a reader should not conclude

Twenty-two rounds each found real defects, most inside the previous round's
fixes. The honest prior is that more exist. This artifact records what was
verified and how; it is not a claim of completeness, and the spec's Convergence
Status says so in the same words.
