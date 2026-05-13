# Self-Healing Remediator v2 — Plain-English Overview (Final, post 5-round convergence)

> The one-line version: instead of building a self-healing system from scratch, the remediator becomes the conductor over the five auto-fix helpers that already shipped in the last month, plus a sibling module (NovelFailureReviewer) that watches for patterns we don't have a fix for yet and asks you to write one — after 5 rounds of review across 4 internal Claude reviewers and 3 external models (GPT, Gemini, Grok).

## The problem in one breath

When Echo breaks, it's usually because the environment shifted underneath it (Homebrew bumped Node, the laptop slept too long, a database file got corrupted mid-write). Each of these has a fix. None of the fixes know about the others. The same problem comes back over and over because nothing remembers we already fixed it ten minutes ago. Two healers can fix the same thing simultaneously and step on each other. A new failure shows up and the only thing that happens is "alert the user" — forever.

That's not self-healing. That's noisy.

## What already exists

The "five sprinklers" — already in production:

1. **NativeModuleHealer** — auto-rebuilds the SQLite library when Node version drifts. Just merged.
2. **Lifeline preflight** — fixes mismatches before the server starts; escalates to full rebuild on crash-loop.
3. **Delivery retry sentinel** — durable queue for Telegram message failures.
4. **System probes** — framework for small, safe "is this working?" checks.
5. **DB corruption recovery** — quarantines bad DB files; falls back to in-memory mode.

Each was built in isolation. None share a logbook, lock, or cooldown.

## What this adds

A central **Remediator** that gives the five healers a shared brain:

- Shared logbook (every attempt across every healer goes here).
- Shared lock (one heal of the same type at a time).
- Shared cooldown (stop after 3 attempts in 4 hours; tell the user).
- Shared dry-run mode (new healers run observe-only for a week before they're allowed to act).
- Shared silence-vs-alert decision (silence earned by verified success; alerts for novel failures and verification failures).

What it deliberately does NOT do:

- Does NOT rewrite the existing healers. Each one stays as it is and just exposes a second entry point the Remediator can call.
- Does NOT decide on its own which problems are "worth" fixing. Every new fix needs a human-approved spec.
- Does NOT silence alerts in Phase 1. Phase 1 is observe-only — records what it would have done. Only Phase 2 lets verified successes go quiet.

## The new piece: NovelFailureReviewer

(Renamed from "SystemReviewer" mid-review because that name was already taken by an existing module.)

A sibling module that:

1. Watches the logbook for failures the Remediator had no fix for.
2. Spots patterns — same unknown failure happening ≥ 3 times across ≥ 2 sessions in 14 days = real, not noise.
3. Asks a small, cheap LLM to write a one-paragraph summary and suggest a name.
4. Sends Justin a Telegram message with a link: "Here's a new pattern — want to write a fix?"

The reviewer cannot write fixes itself. It can only suggest. A human has to decide. That's the bottom-up learning loop — the system grows its own playbook through human-approved expansion, not by training itself.

## The safeguards (5 rounds of review hardened these)

Across 5 review rounds — 4 internal Claude reviewers + 1 cross-model panel (GPT, Gemini, Grok) — 67 amendments were folded in, addressing roughly 150 distinct findings.

**Prevents the Remediator from acting as authority it doesn't have.**
- Each runbook gets its own cryptographic leaf key, derived from a master in your OS keychain plus a per-install nonce that also lives in the keychain (not on disk). Stealing one runbook's key doesn't forge the others. The same applies to probes — each probe has its own key.
- The thing the Remediator passes to a healer is a signed, expiring capability token — microsecond lifetime, monotonic-time deadlines (so it doesn't break on laptop sleep). Surfaces refuse anything else.
- Healers can't both try to fix the same problem at once: they acquire a shared HMAC-signed lockfile first. Lockfile content is signed; replays are caught via heartbeat sequence numbers.
- Healers that hang are aborted at deadline; their child processes get killed; locks are released; the user gets alerted.

**Prevents the system from hurting itself.**
- A healer that fails verification three times in four hours across any restarts stops trying and falls back to alert-only. Closes the "every wake-from-sleep triggers a fresh rebuild" loop.
- "Verify failed" requires a probe-signed structured failure payload — anything else (timeout, missing reply, malformed payload) is "inconclusive" and doesn't count toward quarantine. A compromised probe can't DoS healing just by being noisy.
- Essential runbooks have a stricter quarantine threshold AND require a real second factor (signed CLI confirmation, hardware key, or cross-agent attestation) to un-quarantine. Cooling-off-on-the-same-channel alone isn't enough.
- Verification has to assert durable state, not just live state. A database in fallback in-memory mode emits a non-silenceable durability-degraded event — the user always knows.

**Prevents the NovelFailureReviewer from being weaponized.**
- Cannot generate more than three open proposals at a time. Rest queue silently.
- All proposals from one tick batch into ONE message.
- Cannot author runbook code. Proposals require a human-approved `/instar-dev` commit signed by a different principal (GPG/sigstore signature OR Telegram-countersigned approval that binds to the specific proposal-id — replay across runbooks is closed).
- LLM model selection is allowlisted, validated at call-site, recorded in audit log. Monthly USD budget circuit-breaker pauses calls when exceeded.
- Probe verify-scope comes from signed source code, not runtime self-declaration. A compromised probe can't expand its scope to DoS other subsystems.
- Cross-machine clustering uses a leader-elected primary with fencing tokens (no split-brain). Proposals are deduplicated by canonical ID; stale proposals are explicitly superseded.

**Prevents supply-chain compromise during heal.**
- Native rebuilds use `--ignore-scripts` AND verify prebuild binaries against a signed sha256 manifest (or build from source against a pinned source-tarball sha256). Post-extraction permissions are `0500`, extraction is to a process-private directory — closes the TOCTOU window between sha256 verification and `require()`.

## What ships when — phase tiering

The cross-model panel pushed back on bundling everything into Phase 1. Now tiered:

- **Tier 1 — Minimum Safe Orchestration Core.** Key vault, error normalization, audit infra, the Remediator skeleton, and ONE wrapper runbook (NativeModuleHealer). Observe-only. Proves value first.
- **Tier 2 — Security Hardening.** Probe authentication, capability token enforcement, supervisor handshake, remaining wrappers, CI gate for different-principal verification. Unlocks live mode (silence on success).
- **Tier 3 — Fleet Intelligence.** The NovelFailureReviewer + clustering + proposal dashboard + primary-aggregator with fencing tokens. Adds the bottom-up learning loop.

Each tier is independently valuable. Later tiers don't block on earlier ones being fully adopted.

## What ships across many platforms

Cross-model panel surfaced that the original design hard-required OS keychain — which breaks Docker, headless CI, airgapped, and Windows. Fix: the key vault supports four backends in priority order:

1. OS keychain (macOS Keychain or Linux libsecret) — preferred.
2. Hardware enclave (TPM 2.0, Secure Enclave bridge) — preferred when present.
3. Cloud KMS (AWS/GCP/Azure) — opt-in for fleet deployments.
4. Env-var-injected passphrase + age-encrypted flatfile — for Docker/headless.

Trust-elevation channels are also abstracted: Telegram, Slack, email magic-link, WebAuthn, signed CLI, Threadline cross-agent — pick what fits the deployment.

## Where the spec sits right now

- **5 rounds of review complete.** 4 internal Claude reviewers (security, scalability, adversarial, integration) ran in parallel × 4 rounds. Final round: cross-model panel (GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast).
- **Cross-model verdict:** 8/10 CONDITIONAL (GPT), 9/10 CONDITIONAL (Gemini), 9/10 APPROVE (Grok). All three confirmed the architectural shape is correct and adversarial trajectory across R1–R4 is industry-leading.
- **67 amendments folded in across A1–A67.** Addresses ~150 distinct findings.
- **One commitment before Tier-1 build begins:** a v3 consolidated spec PR that restates the final contracts in one linear document (instead of v1 + v2 + 67 amendments). The consolidation pass is GPT's #1 recommendation and prevents implementation drift.

## What you actually need to decide

Reading-this-overview level: **two decisions.**

1. **Does the conductor-over-existing-healers shape feel right?** That's the architectural question, asked at the start of the review cycle and now validated across 5 rounds.

2. **Is the tiered rollout (Minimum Safe Core → Hardening → Fleet Intelligence) the right phasing?** Or do you want everything in one Phase 1?

If yes to both: I write the v3 consolidated spec as my next step, then start the Tier-1 build (`F-1` through `W-1`) once the consolidation is approved.

If no on either: tell me where the shape is wrong, and I re-shape before any more work goes in.

If you want to read the full spec rather than this overview, the spec is now `cross-model-amended` status — 1019 lines, 67 amendments, sitting at `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md`. But the v3 consolidation PR is what the implementation actually rides on; v2 is the review artifact.
