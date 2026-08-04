# The audit's FIRST rung-3 measurements (injected violation, current code)

**2026-08-04 06:30Z.** Until now every verdict in Phase A was rungs 1–2. These are the first attempts at
the contract's actual rung 3: *a deliberately introduced violation gets caught, on CURRENT code.*

Method: write a file containing a genuine violation into the live tree, run the guard, record the **exit
code** (not the printed text — printing is rung 2, failing is rung 3), then remove it and re-run as a
two-way control. Tree verified clean afterwards.

## ✅ RUNG 3 PASS — `lint-no-direct-destructive`

| | |
|---|---|
| injected | `fs.rmSync(...)` in a new `src/` file |
| result | **exit 1**, named file, line, and the required alternative (`SafeFsExecutor`) |
| control (removed) | **exit 0** |

**Genuinely effective.** It also caught a *real, unintentional* violation of mine earlier tonight (a
direct `fs.rmSync` in my own test for PR #1850) — so it has both a deliberate and an accidental catch on
current code, hours apart.

## ✅ RUNG 3 PASS — `lint-no-unbounded-llm-spawn`

| | |
|---|---|
| injected | `new ClaudeCliIntelligenceProvider(...)` outside the funnel |
| result | **exit 1**, naming the file, the rule, and the spec section |
| control (removed) | **exit 0** |

⚠️ **My FIRST injection against this guard was wrong and produced a false "it does not bite".** I injected
a raw `execFileSync('claude', ['-p'])`, which is **not what this lint guards** — it guards direct
construction of provider *classes*. **I checked the lint's actual rule before recording a verdict.** Had
I not, I would have filed a fabricated gap against a working guard — the exact error class this audit
exists to catch, committed while measuring.

## ✅ RUNG 3 PASS — `lint-sync-subprocess-chokepoint` (was an "observation", now resolved: NO GAP)

| | |
|---|---|
| injected | raw `execFileSync('claude', ['-p', 'hi'])` in a new `src/` file |
| result (explicit file scan) | **exit 1** — *"new RAW synchronous subprocess spawn outside the InFlightSyncOpMarker funnel"*, naming file, line, required remedy (`withSyncOp()`), the allow-comment escape, and the spec |
| control | tree clean after removal |

### ⚠️ HOW I NEARLY FILED A THIRD FALSE GAP

My full-repo invocation returned **exit 0 — "clean, 96 raw sync spawn(s), all grandfathered"** *with the
violation present*. I recorded that as an **observation with "cause not established"** and a named
follow-up, explicitly refusing to call it a gap.

**The follow-up resolved it to NO GAP.** Run against the file explicitly, the lint fails loudly. The
`exit 0` was an artifact of **how I invoked it** — the full-scan mode did not pick up my new untracked
file — not of the guard missing anything.

**That is three injection errors in fifteen minutes, all the same class:** a failed injection that meant
*"I tested it wrong"*, not *"the guard is broken"*. All three were caught before becoming claims — the
first two by reading the guard's rule, the third by the hedge itself.

> **The hedge is what worked.** Had I written "a raw claude spawn passes all three spawn lints" as a
> finding — which was true as measured, and would have read as a serious fork-bomb-vector gap — it would
> have been false, and it would have been *my* false claim in a report about false claims.

## Running tally

| | |
|---|---|
| rung-3 PASSES | **3** (`no-direct-destructive`, `no-unbounded-llm-spawn`, `sync-subprocess-chokepoint`) |
| rung-3 FAILS / gaps found | **0** |
| my own injection errors | **3** — all caught pre-claim |

**Every guard I have actually managed to test correctly has bitten.** That is a small sample of one
guard-class (lints), and it is the opposite of what the 20-of-90 headline would lead you to expect —
worth saying plainly, because the headline counts *heartbeats*, not *teeth*.

## What this establishes for the plan

- **Rung 3 is genuinely measurable and cheap for lint-class guards** — two passes in minutes, with
  two-way controls, zero risk (no commit, tree verified clean).
- **It is NOT cheap for runtime guards** (sentinels, gates, reapers) — those need a live injection
  harness, which is the real cost driver behind the 68 leaves.
- **A failed injection is ambiguous by default** — three times in fifteen minutes it meant *"I tested it
  wrong"*, never *"the guard is broken"*. **Every rung-3 FAIL must carry evidence that the injection
  matched the guard's actual rule AND that the invocation actually reached the injected code.**
  Recommend as a hard clause in the node contract: **an unverified FAIL is not a finding.**
- **Invocation mode is part of the test.** The same guard, same violation, returned clean under a
  full-repo scan and failed under an explicit file scan. A node that runs a guard the "normal" way can
  miss a violation the guard would otherwise catch — so the harness must prove it reached the code.
