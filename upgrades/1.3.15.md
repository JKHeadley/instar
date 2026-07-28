# Instar Upgrade Guide — NEXT

<!-- bump: minor -->

## What Changed

**Framework-Onboarding Mentor System — Stage-B deep forensics.** The "look under the hood" half of
the mentor loop is now real. Instead of recording nothing, Stage B reads the mentee's actual recent
signals — error/sentinel lines from the server log plus a usage digest from its recent Codex session
rollouts (token burn, rate-limit pressure) — and asks the model to classify any concrete issues into
the three buckets (engine limitation / Instar integration gap / one-off mistake), writing them to the
ledger. The prompt-and-parse logic is a separate pure module, defensively tested: malformed or
invented entries are dropped, and a failed forensic read is a no-op tick, never a crash or a poisoned
ledger. Still dormant.

## What to Tell Your User

- When the mentor inspects the mentee, it now actually reads its logs and recent sessions and writes
  down what it finds — bucketed and ranked — rather than just noting that an inspection happened.
- It's deliberately cautious: it reports nothing rather than guess, so the notebook stays trustworthy.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stage-B forensics | Automatic inside a live/dry-run mentor tick — reads server-log errors + codex-rollout digest, classifies into ledger findings |
| Defensive forensic parse | `MentorStageBForensics.parseForensicFindings()` — drops malformed/invalid entries; never throws |

## Evidence

Net-new feature, not a bug fix — no prior production failure. Proven by tests: the parser is asserted
to handle clean JSON, markdown-fenced output, and surrounding prose; to **drop invalid-bucket and
titleless entries**; to return `[]` for non-JSON/empty/broken input (never throw); to cap findings
per run; and to derive a stable dedupKey when the model omits one. `analyzeForensics` is asserted to
**skip the LLM call entirely when there are no signals**, to classify real signals via the injected
model, and to return `[]` (no crash) when the LLM throws. 10 unit tests + an e2e confirming the server
boots clean with the forensics wiring and stays dormant; affected push-config suite green (488) vs
canonical main.
