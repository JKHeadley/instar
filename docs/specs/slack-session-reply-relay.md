---
title: "Slack Session Reply Relay"
slug: "slack-session-reply-relay"
author: "Instar-codey"
parent-principle: "Structure beats Willpower"
status: approved
approved: true
approved-by: "standing-drive blanket preapproval + Echo design authority, topic 458"
lessons-engaged: [P1, P3, P4, P20, P21, B12, B22, B26]
review-convergence: "2026-07-19T10:31:21.642Z"
review-iterations: 2
review-completed-at: "2026-07-19T10:31:21.642Z"
review-report: "docs/specs/reports/slack-session-reply-relay-convergence.md"
cross-model-review: "codex-cli:gpt-5.5, gemini-cli:gemini-3.1-pro-preview"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 8
---

# Slack session reply relay

## Problem and boundary

Slack already has an authenticated reply route, adapter, tone gate, delivery-id deduplication, and thread-aware shell client. The live WS3 canary routed a directed thread message into the correct spawned session, then that session could not reply because its generated command named a missing Claude-only helper. WS4 makes the relay a session-scaffold capability without creating a second Slack send path.

The contract is deliberately narrow: one helper invocation has one delivery id and is idempotent when that same id is retried. Re-running the helper is a new human/model response attempt and is not claimed exactly-once. Durable response-attempt identity across model recovery is outside WS4; prompts must not auto-redrive an ambiguous invocation.

## Authority and source binding

The helper never accepts a caller-chosen Slack destination. It reads `INSTAR_CONVERSATION_ID` and `INSTAR_BIND_TOKEN` from the session environment and posts them, plus text and one stable-per-invocation delivery id, to a new authenticated local conversation-reply facade. The server verifies the bind token with the existing `ConversationBindAuth`, requires the negative conversation id to occur in its authenticated bootstrap set, resolves the registry tuple, validates channel/thread identifiers with the shared Slack regexes, and then delegates to the existing conversation delivery funnel. Request `channelId` or `threadTs` fields are rejected. The route and helper never contain a direct Slack API fallback.

The system sender's existing `/slack/reply/:channelId` path remains unchanged; it is not exposed in generated session instructions. A spawned session can only answer its verified source conversation.

## Multi-machine authority

Slack spawned sessions are placement-pinned to the machine that authenticated the inbound Slack event and owns the local-origin conversation entry plus live adapter. WS4 refuses transfer/recovery placement onto a machine lacking that matching local-origin entry and enabled Slack adapter. A credential-owner-dark condition is a typed unavailable/refusal: no proxy send, no local channel fallback, no queue represented as delivery, and no automatic helper redrive after an ambiguous timeout. Recovery may re-home only after an authenticated inbound on the new adapter-owning machine establishes local origin.

Enforcement is pre-spawn, not prompt-based: the existing Slack inbound and `slack-recovery-spawn` admission call sites query a shared `SlackReplyReadiness` predicate over the local-origin registry tuple and the live enabled adapter before prompt generation or `SessionManager` start. Pool transfer/ownership reconciliation invokes that same predicate at the destination before committing placement; refusal leaves custody with the prior owner and records typed `slack-adapter-authority-unavailable`. The helper route repeats the predicate as defense in depth.

This is machine-local because the Slack socket credential is physically local, but the *agent-wide* behavior is structural refusal off-authority, not an assumption that every machine can send.

machine-local-justification: physical-credential-locality

## One installer and two copies

`ensureSlackReplyRelay` is the only reconciliation primitive. “Slack configured” means `messaging[]` contains a Slack entry with `enabled !== false` and the adapter's required token fields pass the existing config validation; file presence alone never enables installation.

It reconciles independently:

- canonical `.instar/scripts/slack-reply.sh`;
- compatibility `.claude/scripts/slack-reply.sh` when that framework directory exists.

For each regular, non-symlink destination:

- missing: install current bytes mode `0755`;
- current template SHA: repair mode only;
- SHA in the append-only prior-shipped allowlist: make a versioned backup, then replace;
- unknown SHA: preserve it, write the current candidate as `.new`, and record durable degradation.

A customized compatibility copy never blocks a healthy canonical copy. A customized/broken canonical copy blocks Slack session spawn with a typed readiness failure until reconciled; prompts never fall back to the compatibility copy. Symlinks and non-regular files are refused. Writes use a same-directory exclusive temporary file, chmod/fsync, compare-before-rename, and atomic rename. Concurrent refresh/update calls converge; losing writers re-read before rename. Missing packaged template is a typed install failure.

SHA is the overwrite authority because bytes—not a mutable header—prove that the operator has not customized a file (P20). Each shipped template also carries a human-readable relay format version for diagnostics, but that marker never authorizes replacement. The prior-SHA allowlist is append-only release metadata, so line-ending or shebang changes are simply new known shipped bytes rather than fuzzy matches.

All lifecycle call sites invoke the same primitive and bytes/policy: fresh init when Slack is already configured, successful late Slack configure/enable, normal server startup/refresh, explicit `instar migrate`, CLI update, and UpdateChecker fallback. Disabled/unconfigured Slack is a no-op and installs neither copy.

## Prompt and context convergence

One canonical renderer owns the relay instruction contract. Its producer census is:

1. initial Slack inbound spawn;
2. both server recovery/respawn paths;
3. `slack-channel-context.sh` plus deployed-hook migration;
4. `compaction-recovery.sh` plus deployed-hook migration;
5. IdentityRenderer/session-start appendices that emit Slack reply instructions.

Every producer names `.instar/scripts/slack-reply.sh` and relies on authenticated `INSTAR_CONVERSATION_ID` plus `INSTAR_BIND_TOKEN`; it never interpolates a destination. Thread history is selected from the verified tuple: a thread session receives the root and replies for exactly that `(channelId, threadTs)`, while a root session receives channel-root messages only. Missing, malformed, or mismatched thread metadata is a typed wiring failure and blocks spawn/recovery; it never flattens to root. Inbound content stays inside the existing untrusted-data delimiters.

The bind token is minted by `SessionManager` for the session's bootstrap conversation ids and survives compaction because it remains in the tmux session environment. A recovery/respawn receives a newly minted token for the newly verified bootstrap set; a successful authority re-home therefore requires authenticated inbound and a new spawn. This composes the existing durable-conversation-identity bind-token contract rather than extending token lifetime or trust.

A source-census ratchet fails if shipped source/templates generate the Claude Slack relay path, accept a raw relay destination, or if a thread-capable producer omits verified thread handling.

Prompt correctness is compatibility/readiness evidence, never the security boundary. The route's bind-token and registry checks refuse a foreign destination even if a stale or malicious prompt invokes the helper incorrectly.

## Timeout and outcome contract

The helper uses bounded curl connect and total timeouts shorter than the server route timeout plus a small response margin. It accepts an optional `INSTAR_DELIVERY_ID` only for an explicit same-attempt retry; otherwise it mints a UUID before POST. On ambiguity it prints the id to stderr and a mode-`0600` per-session diagnostic file, but never retries. A deliberate verification-driven retry sets that printed id in `INSTAR_DELIVERY_ID`; the helper validates UUID shape and the server deduplicates it. A clean pre-accept refusal is retryable only by an explicit new invocation. A timeout/reset after request transmission is ambiguous, exits nonzero with an “outcome unknown; do not auto-redrive” instruction. HTTP 408 is ambiguous nonzero; HTTP 409 is delivered-equivalent duplicate. No helper call can park indefinitely.

## Decision points touched

| Decision | Classification | Resolution |
|---|---|---|
| Destination authority | invariant | Bind-token-scoped conversation id; caller destination forbidden. |
| Canonical path | invariant | A single neutral executable is the deterministic authority; Claude path is compatibility-only. |
| Slack installation gate | invariant | Enabled and config-valid Slack adapter, using one shared predicate. |
| Customized-copy handling | invariant | SHA provenance deterministically separates known shipped bytes from unknown operator content; unknown bytes are preserved. |
| Cross-machine execution | invariant | Local-origin registry entry plus live adapter is a closed mechanical predicate; off-authority placement is refused. |
| Thread isolation | invariant | Verified tuple selects exact thread/root context and delivery. |
| Ambiguous outcome | invariant | Transport evidence mechanically classifies ambiguity; bounded nonzero exit never authorizes automatic redrive. |

## Three-tier acceptance and live regression

Tier 1 unit tests cover the exact Slack predicate, source binding refusals (wrong/absent token, wrong conversation, caller destination), identifier validation, thread/root truth table, SHA reconciliation including stock-header customization, symlink refusal, modes, concurrent atomic replacement, independent-copy outcomes, and bounded/ambiguous helper behavior.

Tier 2 integration drives the full authenticated HTTP pipeline through the real route, bind verifier, registry, tone/dedup gates, and adapter fake. It proves one adapter call in the source thread, zero root calls, same-delivery-id suppression, malformed/foreign tuple refusal, hung endpoint timeout, and no direct fallback.

Tier 3 production lifecycle uses actual init/refresh/server composition with an enabled Slack adapter and a spawned non-Claude-framework session with only the neutral helper present. It reproduces the WS3 missing-helper failure before installation, then proves exactly one invocation-level response in the directed source thread. It also covers configure-later, each migration/update call-site census, compaction and recovery thread preservation, current→old→current rollback, and a two-machine canary: an off-authority session placement is refused, credential-owner-dark stays unavailable, and authenticated inbound on the new authority permits re-home.

Migration Parity is a ship gate: session-scaffold-installed behavior must pass fresh, late-configured, upgraded-stock, customized, missing-neutral, and non-executable-copy fixtures with byte/mode parity where replacement is authorized.

## Deployment and rollback

Deployment first installs/reconciles helpers, then changes prompt generators, then migrates deployed hooks; readiness must be green before Slack session spawn. The Slack live-test reprovision runbook in PR #1518 gains postflight checks for canonical helper regular-file status, mode/current SHA, compatibility status, and a neutral-path in-thread response; multi-machine postflight proves the authority/refusal rule.

Rollback reverses that order: first restore prompt generators and deployed hooks to commands available in the target old version, then restore versioned known-shipped helper backups or remove the neutral helper only when no live prompt references it. Unknown/custom files and `.new` candidates remain untouched and their degradation stays visible. Tests exercise old→current and current→old with both copies so rollback cannot strand prompts on an absent executable.

## Open questions

None.

## Acknowledged trade-offs and extension boundary

Pinning favors source authority over availability: while the adapter owner is dark, the user sees no fabricated success and may need to send a new message after another machine acquires that distinct Slack app identity. Durable response-attempt identity spanning model/session recovery and an authenticated cross-machine adapter proxy are separate capabilities and are not implied by WS4. Two physical copies are temporary compatibility debt: the neutral copy is the single authority and the compatibility mirror can be retired after supported Claude scaffolds consume the neutral contract.
