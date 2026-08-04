# Phase A — Interim Synthesis (window #6) — UPDATED 11:13Z, ~8h in

**For the architect's scheduled read.** Every claim below traces to a measurement in
`phase-a-journal.md` with a machine-stamped time and a named source. **Mac Mini unless stated;
per the amendment, nothing here is `aligned` until the laptop is measured too.**

---

## 1. THE HEADLINE HAS CHANGED

Phase A was framed to find **absent** guards. What the evidence shows is **unevenly applied** ones.

> **Where someone hit a failure and built structure in response, the structure is excellent — better
> than my own working practice. Where nobody has hit it yet, there is prose.**

Three separate times tonight the codebase was ahead of me on method:
- `lint-chain-completeness` names the exact failure class this phase exists to hunt — *"a check whose
  absence is indistinguishable from its success"* — and ratchets against it.
- `standards-coverage-ratchet` carries **11 explicit negative controls**; I derived that same
  "B-case" rule by making the mistake and correcting it, four hours later.
- `reviewer-fail-closed-ratchet` injects a forced provider error on **every build**; my equivalent
  injection happened once, by hand, and depended on my remembering.

**This should change the recommendation's shape: the leverage is in PROPAGATING an existing, proven
pattern — not inventing new guards.**

### ⭐ The pattern to propagate, now named precisely
**ONE undeclared key in `COMPONENT_CATEGORY` fails SIX independent ratchets** (benchmark story ·
provenance census · untrusted-input posture · judgesClaims · parser-contract · injection-exposure).
**One shared REGISTER, six declare-or-fail obligations, no default on any.** Verified by injection.

**And the weak link is now precisely named:** `NOT_A_GUARD` is the same architecture — a register with an
obligation — **but its obligation checks that a reason is PRESENT (≥12 chars), never that it is TRUE.**
Two other verified guards already validate a declared value against a **closed set** and reject anything
outside it. **The fix is to apply an existing proven property to the one register that lacks it.**

---

## 2. WHAT IS ACTUALLY PROVEN — **41** at rung 3 (was 23 at the first send)

| tier | verified | population | how |
|---|---|---|---|
| runtime guards | **1** | 90 | `machineCoherence` — caught a real divergence I created, unprompted, live |
| lint-class | **24** | **28 enforcing** (+1 config-gated, +1 warning-only) | deliberate two-sided injection on scripts diffed UNCHANGED vs `origin/main` |
| ratchet-class | **16** | 18 | injection (13) + by-construction (3); 18/18 green = rung 2 for the whole tier |

**Denominator corrections made since the first send:** the lint population is **28 always-enforcing + 1
config-gated + 1 warning-only**, not "30 guards" — a deliberate detector was being counted as a failing
guard, and a config-gated guard as unmeasured when its **flip is proven to work**.

**The enforcement stack is verified end-to-end:** lint detects → ratchet pins its baseline at zero →
`lint-chain-completeness` makes removal from CI impossible. **So the 19 lint verdicts are CI-enforced,
not merely "a script exists".**

---

## 3. THE LIVE PROBLEMS — REWRITTEN 09:51Z. MY EARLIER VERSION OF THIS SECTION WAS WRONG.

⛔ **Retracted:** I reported at 08:04Z that *"the memory-threshold defect is CAUSING the total LLM
collapse — fixing the thresholds fixes the LLM layer."* **Falsified by the machine.** Memory freed on
its own at ~09:40Z, spawn refusals went to **zero**, and the LLM layer **did not recover** (0 successes,
1h and 6h; circuit re-opened at 09:43 with the identical error).

### ⭐ THE ACTUAL ROOT CAUSE — reproduced, measured, and its FIX verified
```
the pool sends each prompt as a COMMAND-LINE ARGUMENT     promptRunner.js:77
tmux send-keys -l ceiling (binary search, scratch session) ~16,256B OK / ~16,480B "command too long"
tone-gate STATIC prompt skeleton, before any content        40,049 bytes
                                                            = 2.5x OVER THE LIMIT
observed: 23 send attempts, 23 failures, 100%
```
**Every such prompt is undeliverable through that path, always** — independent of memory, quota, and
auth. This explains 0 successes across 6h while quota sat at 0–56%, and a circuit that re-opens every
900s because each probe is another oversized send.

**Remedy — TESTED at the real size BEFORE recommending:**
`tmux load-buffer <file>` + `paste-buffer` delivered **40KB OK** and **200KB OK**, where the current path
failed. One function at the send site. **Offered, not started** (outside the sanctioned two).

### The two INDEPENDENT faults, both now precisely named
1. **codex-cli** — 401, token invalidated 2026-08-03T23:57Z. **Justin's sign-in.**
2. **interactive pool** — prompt 2.5x over tmux's argv limit. **A code fix, proven.**

### The memory thresholds — still worth fixing, on their OWN merits only
21 scheduled jobs die whenever free memory sits below ~25%, which was most of the night. **But the
threshold change is NOT the LLM fix, and my shipped memory fix changed the tier LABEL, not any gate
DECISION** (both metrics refuse at ~18% free and allow at ~56%). **The public release note claiming
otherwise needs correcting.**

### `CrashLoopPauser` — unchanged and still the one clean buildable gap
Dead code (never constructed; control passed) while 21 jobs run away, top **477** consecutive failures.
Invisible to the audit because its exclusion rationale *asserts* an observability that does not hold, and
`lint-guard-manifest` checks that a reason EXISTS, never that it is TRUE.

## 4. THE AUDIT'S DOMINANT RISK IS MY OWN ERROR RATE

**Twelve times a result looked like a broken guard. All twelve were mine. Zero genuine guard failures by
injection.** ⭐ **And THREE times I reported a causal story built from correlated timing and had to
retract it** (memory→LLM · a spawn race · an id mismatch). **The one method that has never failed: run
the real command against a throwaway target.** Six minutes with a scratch tmux session produced the root
cause that four hours of log-reading did not. Three were REPEATS of lessons I had already written in the journal — including using a
command I had personally documented as absent on this machine.
Causes: full-repo scan skipping untracked files (3×, after I documented it), path-allowlist scope,
guessing a violation shape, inventing an API, an edit that never landed, wrong registry field depth.

**Keyword bucketing failed twice, in both directions** — once undercounting a class 4.5×, once about to
invent a problem in the strongest guards.

**Standing rules adopted mid-phase:** (a) a B case is mandatory — a catch without one proves nothing;
(b) a keyword classification is a search aid, never a finding; (c) a lint that looks broken is
mis-invoked until its invocation is read from source; (d) journal timestamps are machine-stamped
(`jlog.sh`) after I fabricated 7+ by hand.

⭐ **If I had reported first results, I would have handed you seven broken guards that all work.**

---

## 5. HONEST GAPS

- **8 of 16 Level-2 leaves are `unmeasured`, not `false`** — the guard never had an opportunity to act.
  Settling them needs a staged violation, i.e. the throwaway-agent harness. **`bob` already exists, live,
  on the current build** — but 62 of its 87 guards are off, and a verdict there proves the *mechanism*,
  never *this machine*.
- **12 ratchets + 11 lints remain untested.**
- **The laptop is 2 versions behind (1.3.1122)** — so no node can be `aligned` yet, and I did not check
  that until 6 hours in.
- **The self-unblock checker is OFF**, so tonight's escalations were ungated; I ran the ladder by hand
  and one probe (org vault) is **blocked, not negative**.


---

## 6. THE SHARPEST GAP (found after the first send) — and the only one with measured harm

**The standard** *"Intelligence Infers, Keywords Only Guard"* forbids matching a natural-language phrase
list against a human's message to DECIDE what they meant — *"classify, reroute, or swallow it."*
**A ratchet enforces it; I verified by injection that it bites.** Its scan scope is
`src/{core,monitoring,server,threadline,messaging}`.

**The outbound grounding check is that anti-pattern** — six literal phrases `grep -qiE`'d against my
outbound text to **block the send**. It lives **agent-side** (`.instar/scripts/`), outside the ratchet's
scope by construction.

**Measured harm: 11 blocks tonight · 2 true · 9 false · precision 25%→22%→20%→18%, falling at every
re-measurement.** Three fired on phrases appearing only **inside a quotation**, including one on the
message documenting this defect. The false blocks cost meaning-preserving rewrites — **which trains an
agent to route around the check rather than read it.**

> **The general form is bigger than the instance: repo-side and agent-side surfaces are enforced by
> SEPARATE machinery with no bridge.** A standard can be rigorously enforced in one and freely violated
> in the other, and each side looks clean from inside itself. **Our Tranche 2 brief recorded the mirror
> image of this** (*Right to Stand Ground*: guarded agent-side, unguarded repo-side).

**Recommendation: extend the existing verified ratchet's scan scope to the agent-side surface. No new
guard required.**

## 7. FOUR CONSTITUTIONAL STANDARDS FOUND ALREADY LOAD-BEARING

Not aspirational prose — code I broke and watched catch me:
1. **invisible-guard-loss** → `lint-chain-completeness` (the lint chain may only GROW)
2. **declare-or-fail** → the `COMPONENT_CATEGORY` six
3. **keywords-only-guard** → `keyword-intent-decision-ratchet`
4. **Close the Loop** → `durable-output-chokepoint-ratchet`: a `pending` item **must carry an owner**,
   and the pending set is **shrink-only** — deferral solved as arithmetic, not discipline.

**The failures are at the EDGES** — scope boundaries, agent-side surfaces, registers that check presence
instead of content, a component classified but never constructed. **Not absent principles: principles
with unguarded perimeters.**


---

## 8. THREE INDEPENDENT LLM FAULTS — all characterized (10:22Z)

I reported one cause, then two, and the honest count is **three**. Each is independent; each was
initially hidden behind another.

| # | fault | status |
|---|---|---|
| 1 | **Interactive pool** — every prompt is **2.5× over the ~16KB `tmux send-keys` argv ceiling** (skeleton alone 40,049B; limit measured ~16,256B) | **PROVEN. Remedy also proven** (`load-buffer`+`paste-buffer` delivered 40KB and 200KB where the current path failed) |
| 2 | **codex-cli** — 401, token invalidated 2026-08-03T23:57Z | **Justin's sign-in** |
| 3 | **headless `claude -p` in the AGENT HOME** — hangs >150s; 4s from a clean dir | **Characterized, cause UNPROVEN** |

**Fault 3's live lead:** all four measurements fit *"the hooks, which execute only in a TRUSTED
workspace, are implicated"* — the three fast controls each printed *"this workspace has not been
trusted"*, meaning **hooks never ran in them.** Two config defects found alongside: `SessionStart`
registered **three times**, and hook timeouts written as both `5` and `5000`/`10000` (if those are
seconds, that is 83–166 minutes — effectively unbounded).

## 9. CROSS-MACHINE POSTURE — the amendment, measured

| | Mini | Laptop |
|---|---|---|
| missing | 0 | **2** |
| off-runtime-divergent | 0 | **1** |
| on-confirmed | **20** | 18 |
| on-unverified | 40 | **48** |

⛔ **The laptop's `monitoring.resumeQueue` is off at runtime against its config** — an autonomous run
interrupted there is **not revived**. The guard self-reports this exactly as designed; nobody had looked.

**Load-bearing gaps differ per machine** (`inboundQueue` Mini-only; `preferredCaptainHandback`
laptop-only) — **the amendment's premise demonstrated, not argued.** `orphanedWorkSentinel` is
**blind on the Mini and simply OFF on the laptop** — one guard, two states, and a fleet-wide verdict
would have been wrong about both.

## 10. TWO GUARDS SHARE ONE BLIND SPOT: USE vs MENTION

- **Grounding gate** — 13 blocks tonight, **2 true / 11 false, precision 15%**, falling at every
  re-measurement. Four blocks fired on phrases appearing only **inside a quotation**.
- **`dangerous-command-guard`** — correctly refused a scratch delete, then **blocked the journal entry
  describing that refusal.**

**Both scan text without distinguishing using a phrase from talking about one.** ⭐ **Their blast radii
differ enormously** — one refuses loudly and explains itself; the other silently costs a
meaning-preserving rewrite of a correct message. **Same defect, opposite cost profile** — which is the
signal-vs-authority distinction expressed as consequence.


---

## 11. STATE AT 10:57Z — 51 verified, and the work is now DURABLE

**Four git-tracked commits** (the correction this session most needed — the night's evidence had been
living only in an agent home that is not a git repository and in Telegram messages that scroll):
```
7fa5d9857  Phase A audit, rounds 1–2      (validator-parsed; honestly NOT converged)
bc46c53e2  auditor method lessons          (the 12 false results and their tells)
b76d7048b  the Structure>Willpower measurement on the auditor
9c777ad85  Phase A round 3                 (51 verified; positional ceiling named)
```

**Verified at rung 3: 51** — 1 runtime guard · 26 lint-class · 18 ratchet-class · 5 non-lint enforcement
scripts · the instar-dev gate (which verified itself by refusing this auditor's own out-of-discipline
commit).

## 12. THE POSITIONAL CEILING — a plan decision, not a measurement one

**Ten of the 27 non-lint enforcement guards cannot be tested from an agent workstation at all.** They
need a PR description, a CI event payload, a staged diff against a remote, or a release moment.

> **A convergence claim made from here would be a claim about the REACHABLE surface only.** Either part
> of Phase A runs inside CI, or the scope is explicitly narrowed to what an agent can observe. **That is
> the architect's call.**

## 13. CORRECTIONS MADE SINCE THE LAST UPDATE (all against my own prior reports)

- ⛔ **"Lint tier complete, 30/30"** — retracted. Scoped by filename prefix; 27 further guard-shaped
  scripts existed.
- ⛔ **"Two guards in the ambiguous-zero class"** — retracted. Both had looked-counters; that class is
  **empty**. I populated it using the very keyword technique the taxonomy exists to discredit.
- ⛔ **Tranche 1's "live but never exercised"** — corrected after 4h37m. The route's `counters` block
  (which I never printed) shows **9 real opportunities, 0 acts**. Verdict upgraded to
  `effective: FALSE — evidenced`, and the node needs splitting: its **hold sub-policy is LIVE and acting**
  (4 holds, 4 recovered) while the queue is dry-run.
- ⛔ **Fault 3's "two strong leads"** — both now **eliminated** by measurement (hook timing; MCP servers),
  along with context size. Cause remains unproven; the position is honest but weaker than reported.
- ⛔ **Population arithmetic** — the three enforcement tiers **overlap** and were counted as disjoint all
  night. No corrected total invented, because none can be derived yet.

**Six retractions in ninety minutes, every one against something I had already sent upward.** The audit's
findings are only as good as this rate of self-correction, and that rate is the thing the method-lessons
document exists to transfer.


---

## 14. CLOSED SINCE 10:57Z

**The scheduled-jobs thread closes EMPIRICALLY.** Every failure still on the board predates 09:40Z when
memory freed itself. **Zero failures in the 90 minutes since; 12 succeeding against 4 overnight.**
⛔ **"21 dead jobs" — my most-repeated number of the night — is retired.** The jobs were **throttled, not
broken**, and my shipped fix is still not implicated in the recovery. What remains worth fixing on its
own merits is the threshold mismatch (gate refuses at `free<25%`; the reaper calls the same reading
`normal` until `free<12%`), which will throttle the machine again on the next tight period.

**The Codey hypothesis is REFUTED, and the refutation is the strongest control I have.** I guessed his
silence might be my tmux-argv fault. He is **not** in `force` mode and his log shows **zero** occurrences
of the signature — against my 23 send failures and 9 circuit trips. **Same codebase, same version, same
physical machine, different mode, zero occurrences.** ⭐ **That is an independent confirming case for the
root cause that I did not construct for the purpose.**

**Round 4 committed.** Seven audit commits now. The counter surface measured at **7 of 38 guard-shaped
routes (18%)**, two of my own classifications retracted, and the audit's coverage bound stated:
**433 GET routes exist; ~40 examined.**

## 15. THE ONE THING I MOST WANT DECIDED

**Phase A is not converging, and after four rounds that is the finding rather than an obstacle.** Each
round enlarged the surface faster than it closed it (90 guards → +30 → +18 → +27 → 433 routes).

> **Either the scope is "the enforcement tiers an agent workstation can observe" — much of which is
> genuinely done, with the remainder named — or the scope is the whole system, which needs CI access and
> the `{looked, wouldAct, didAct}` schema change before another hour of sweeping is worth spending.**

**That is a plan decision, supported by four rounds of evidence rather than by fatigue.**
