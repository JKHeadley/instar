
---

## Round 6 — SERIAL MASKING: you cannot enumerate the faults in a degraded system by inspection

The internal-LLM outage turned out to be **three independent faults stacked in series**, and each one
was invisible until the one in front of it was fixed.

| # | fault | how it presented | when it became visible |
|---|---|---|---|
| 1 | `tmux send-keys -l` argv ceiling — ~40 KB prompt vs ~16 KB limit | breaker log said `provider rate-limited` (a hardcoded string) | only after reading the reason field the headline talked over |
| 2 | codex-cli OAuth `refresh_token_invalidated` (401) | components at 100% error; routing surface said codex `available: true` | only after #1 was fixed, deployed, and the pool STILL got no traffic |
| 3 | swap-attempt timeout **5 s** vs the pool's own `maxPromptWaitSeconds` **120 s** | two `swap-attempt-timeout: claude-code` lines, easily read as noise | only after #2 explained why traffic reached the swap at all |

### The lesson

**At each stage, the evidence available genuinely supported a single-fault story.** After fixing #1 I
had: a reproduced defect, a byte-exact end-to-end proof on the live provider, a deploy, and zero
failures post-restart. Every one of those was true. The conclusion "the outage is fixed" would have
been *reasonable* — and wrong.

What saved it was refusing to accept **absence of failure as evidence of success**. Zero breaker trips
after the restart proved nothing, because nothing was calling the path. I had said that out loud before
measuring, which is the only reason I kept looking instead of declaring victory.

**Rule: in a degraded system, a fix that removes a blocker does not reveal a working system — it
reveals the NEXT blocker.** Do not enumerate the fault list up front from inspection; it will be
incomplete by construction, because downstream faults are unobservable while an upstream one absorbs
all the traffic. Fix, deploy, then RE-MEASURE the end-to-end behaviour rather than the thing you fixed.

**Corollary — the honest completion criterion is a POSITIVE observation, never a negative one.**
"No errors since the fix" is compatible with "nothing ran". The close condition must be *something
succeeded*, and it must be something you watched land.

### And a fourth instance of ASSERTS-UNMEASURED-STATE, found the same way

Fault #2's surface: `GET /intelligence/routing` reports codex-cli **`available: true`** for every
component while every codex call returns 401. Availability is measured as *the binary exists*, not
*the door opens*.

That is the third confirmed instance of the class (after the memory metric and the breaker label), and
it lands **exactly** in the blind spot the Round 5 sweep named as unseeable — *a cause asserted by a
computed field rather than a string*. The Round 5 verdict ("outlier, not a pattern", 3 angles, 348
files) is therefore **weakened, and correctly so**: the sweep's own declared blind spot is where the
counterexample was hiding. Naming the blind spot is what made this recognisable when it appeared.

**Round 5's conclusion is amended: not converged, and now with a known counterexample class — computed
availability/health booleans. That is the highest-yield next angle, ahead of field-name matching.**

---

## Round 6 additions — #22, #23, and the first guards caught being EFFECTIVE on me

### #22 — I applied the absence rule everywhere except my own incident report

Seconds after a harness killed a pool session, I checked for pool sessions, got an empty result, and
reported **"the pool is empty — one session to zero."** Both numbers were wrong. There were **two**
sessions, one was killed, and the survivor was healthy and serving throughout (verified: live process,
idle prompt, answered a 17,281-byte chunked prompt in ~5 s).

This is the **third** occurrence today of *an empty/failed command result read as data* — after the
`/jobs` route with no `lastRun` field, and the laptop probe where an auth error parsed into nulls I
read as runtime state.

**The tell is not new. The context is.** I have a written rule — *before reporting an absence, prove
the check could have shown otherwise* — and applied it consistently to guards, jobs and peers… then
not to **my own incident report**, the single place it mattered most. A false alarm about
infrastructure damage is more expensive than any other kind, because it triggers exactly the panicked,
unverified remediation that causes real damage.

**Rule: the absence check applies HARDEST to your own bad news.** Alarm is the state in which
verification feels least affordable and is most necessary.

### #23 — "smoke test" is a name, not a behaviour contract

I ran an adapter's own `_smoketest` against live infrastructure to gather evidence. On startup it
reaped a **live** pool session belonging to the running server, by a loose name match, then failed to
start its own.

I read the docblock ("exercises the adapter against a real REPL pool") and inferred it was
self-contained. It wasn't. **I trusted the label instead of reading the mechanism** — the exact failure
this audit exists to catalogue, committed by the auditor, with teeth.

**Rule: before running any harness against live infrastructure, read its SETUP path specifically** —
not its purpose, not its docblock, but what it does to the world before it does its job.

**Filed separately as a real defect:** a harness that reaps another live process's sessions on startup
is dangerous by design, independent of my carelessness. Its "stale" detection should be scoped to
sessions it owns.

### ⭐ THREE guards observed EFFECTIVE on live violations — all caught on me

| guard | violation I actually committed | outcome |
|---|---|---|
| managing-server restart refusal | tried to restart my OWN managing server from inside its session | refused, with the reason AND a safe alternative |
| destructive-command guard | attempted a hard-reset of a git working tree | blocked, authorization required |
| `lint-chain-completeness` | added a lint to CI without protecting it in `REQUIRED_LINTS` | failed the build, named the exact fix |

**All three are rung 3** — a genuine violation, caught on current code — and none required a designed
injection. I obtained them by making the mistakes.

**Method note: the auditor's own errors are a legitimate and under-used source of rung-3 evidence.**
They are unplanned, genuinely adversarial, and free. The catch is that the evidence only exists if you
REPORT your violations instead of quietly fixing them. Every one of the 23 catalogued errors was a
potential rung-3 datapoint; I recorded them as method failures and only noticed late that they are
also guard measurements.

### ⚠️ A false positive in the same family, caught immediately after

The destructive-command guard then blocked a **commit message** that merely *quoted* the hard-reset
command as prose. It matches the raw tool input, so a MENTION trips it identically to a USE.

Same shape as the tone gate flagging `rung-3` in a message where that term was the operator's own
vocabulary. **Keyword guards cannot distinguish use from mention** — which is the "Intelligence Infers,
Keywords Only Guard" standard restated as a measurement. Both were cheap to work around honestly
(reword, or acknowledge with a reason), and both are recorded rather than silently bypassed.
