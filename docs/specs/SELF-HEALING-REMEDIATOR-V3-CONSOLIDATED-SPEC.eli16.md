# Self-Healing Remediator v3 — Plain-English Overview

> **One-line shape:** v3 is the rewrite-everything-clean version of the spec — same architecture as v2, same 67 amendments folded in, but now told as one straight story instead of "v1 plus v2 plus 67 patches." This is what the next build PRs actually point at.

## Why this document exists

The v2 spec is 1019 lines long. About 500 of those lines are amendments numbered A1 through A67 — each one a patch onto the original design. After 5 review rounds (4 internal + 1 cross-model with GPT, Gemini, Grok), the cross-model panel's #1 recommendation was: *before any code lands, write one clean canonical document that restates the final answers without the patches.* That's v3.

Reading v2 means reading the original design, then reading 67 corrections, and mentally diffing. Reading v3 means reading the design once. That's the whole point. Implementation PRs reference v3, not v2.

## What the system does

A self-healing agent should fix itself when something predictable breaks. Today, five different self-fix helpers ("surfaces") already ship in Instar — they auto-rebuild the SQLite library, fix the supervisor, retry stuck Telegram messages, recover corrupt databases, run health probes. Each one was built in isolation. None know about the others. So:

- Two of them can try to fix the same problem at once and step on each other.
- The same problem comes back over and over because nothing remembers we fixed it 10 minutes ago.
- A new problem the surfaces don't know about just becomes "alert Justin forever."

The Remediator is the conductor that sits above the five helpers and gives them a shared brain — shared logbook, shared lock, shared cooldown, shared "should I alert or stay silent" decision. A sibling module called NovelFailureReviewer watches the logbook for problems no helper handles and asks Justin to write a new helper.

## The four-layer architecture

1. **Probes** detect: small, signed health checks that emit structured failure events.
2. **Remediator** orchestrates: matches events to runbooks, holds locks, runs the attempt state machine, writes the audit log, decides silence vs alert.
3. **Runbooks** execute: thin (~50-line) wrappers over the existing surfaces. They never re-implement the heal; they just call the existing code with the orchestration context the Remediator hands them.
4. **NovelFailureReviewer** proposes: reads the audit log, clusters unmatched failures, asks a cheap LLM for a summary, sends Justin a proposal via Telegram (or Slack/email/CLI/etc).

No layer can short-circuit another. The reviewer cannot write runbook code. The Remediator cannot decide silence policy for surfaces. Surfaces cannot fire without a capability token from the Remediator.

## The big safety idea

Every dangerous action is gated by a **capability token** — a short-lived, signed object the Remediator hands to a surface when it's allowed to act. The token expires using monotonic time (so laptop sleep doesn't break it), can't be replayed across boots (because every surface tracks its own monotonic counter persisted in the audit log), and can't be replayed within a boot (because surfaces track which tokens they've seen). Without a valid token, a surface falls back to its in-line path — same behavior as before the Remediator existed.

Every signing key is **per-context, per-scope**. There are five contexts (capability, probe, in-flight lock, ledger, audit). Each context has a master key in your OS keychain. Each runbook/probe/surface gets its own leaf key derived from the master + a per-install nonce that is also in the keychain (never on disk). Stealing one runbook's leaf key doesn't forge anything else. Stealing the entire keychain doesn't help unless you also have the install nonce — which lives in the same keychain under the same scoped access control.

## What's different from v2 (no behavior changes — just clarity)

- v2 said "the system probe framework lives at `src/knowledge/ProbeRegistry.ts`." That was wrong. The probe interface lives in `src/monitoring/SystemReviewer.ts` (existing file). The orchestration-side reviewer module is named `NovelFailureReviewer` to avoid colliding with that existing module.
- v2 had 67 amendments scattered through 500 lines. v3 has one linear architecture, one linear key hierarchy, one linear state-file table, one linear test plan.
- v3 adds three summary tables that didn't exist in v2: a threat-model summary (every adversary scenario → which amendment handles it), a performance budget summary (every cost path → its budget), and a platform support matrix (every deployment platform → which secret backend it uses).

## Where it ships and in what order

The cross-model panel pushed back on bundling everything into Phase 1. The build is now three tiers:

- **Tier 1 — Minimum Safe Core.** Key vault, error normalization, audit infrastructure, the Remediator skeleton, and ONE wrapper runbook (the SQLite ABI rebuild). Observe-only mode. Proves the orchestration shape works before adversarial defenses are bundled in.
- **Tier 2 — Security Hardening.** Probe authentication, capability token enforcement, supervisor handshake, remaining wrappers, CI gate for different-principal verification on proposal-derived runbooks. This unlocks live mode (silence on verified success).
- **Tier 3 — Fleet Intelligence.** NovelFailureReviewer + clustering + dashboard proposals + primary-aggregator lease with fencing tokens. Adds the bottom-up learning loop.

Each tier is independently valuable. Later tiers don't block on full adoption of earlier ones.

## What ships across platforms

v2's hard keychain requirement broke Docker, headless CI, airgapped, and Windows. v3's key vault supports four backends in priority order: OS Keychain → Hardware enclave (TPM/Secure Enclave) → Cloud KMS (AWS/GCP/Azure) → env-var passphrase + age-encrypted flatfile. Trust-elevation channels are similarly abstracted: Telegram, Slack, email magic-link, WebAuthn, CLI signed confirmation, or Threadline cross-agent attestation. Pick what fits your deployment.

## What it does NOT do (explicit)

- Does NOT modify user project files.
- Does NOT touch git state.
- Does NOT make outbound network calls during `execute()`.
- Does NOT install or upgrade packages from the internet.
- Does NOT author its own runbooks from LLM output — every runbook ships as code through `/instar-dev`.
- Does NOT modify config files a human edits.
- Does NOT support a `blastRadius: "external"` runbook on day one.

## What you actually need to decide

You already approved this in topic 3079 on 2026-05-13. v3 carries that approval forward. The only new question would be if you want to revisit the tiering, the cross-platform fallback order, or any of the threat-model rows. Otherwise: this is the implementation contract, Tier-1 PRs (F-1, F-2, F-3, F-4, F-8-subset, W-1) start referencing it, and v2 stops being the authoritative document the moment v3 merges.
