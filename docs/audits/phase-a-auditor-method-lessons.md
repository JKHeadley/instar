
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
