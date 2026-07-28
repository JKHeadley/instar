# Convergence Report — Slack Session Reply Relay

## Outcome

Converged in two rounds and approved under the standing-drive blanket preapproval with Echo's design authority on topic 458. Real external reads ran through Codex (`gpt-5.5`) and Gemini (`gemini-3.1-pro-preview`). Their final verdicts were both **MINOR ISSUES**; every material architectural issue from the first round was resolved, and the second-round operational clarifications were folded into the spec.

## Plain-English result

The live Slack test proved that inbound routing worked but a spawned session was handed a reply command whose script was missing. The converged design supplies one framework-neutral reply helper, binds it mechanically to the session's verified source conversation, installs it safely for fresh and upgraded agents, and makes every spawn/recovery prompt use it. It cannot choose another channel, flatten a thread to channel root, call Slack directly, hang forever, or claim a timeout definitely failed.

## Iteration summary

| Round | Review inputs | Material findings | Resolution |
|---|---|---:|---|
| 1 | security, scalability, adversarial, integration/deployment, decision-completeness, lessons/foundation, Codex, Gemini | 14 | Replaced caller-chosen destination with bind-token conversation authority; added exact thread context isolation; chose structural machine placement pin/refusal; replaced marker overwrite with SHA provenance; unified lifecycle installer; specified atomic concurrency, deadlines, honest idempotency boundary, prompt census, rollback and three-tier tests. |
| 2 | integration/deployment, decision-completeness, lessons/foundation, Codex, Gemini | 6 material + operational polish | Named pre-spawn and transfer enforcement seams; defined delivery-id retry UX; justified SHA authority plus diagnostic version marker; grounded bind-token lifecycle; made prompt checks explicitly non-authoritative; documented availability/compatibility trade-offs. |

The Standards-Conformance Gate was attempted before round 1 and returned `specPath escapes specsDir` because the hook required a rendered review artifact before allowing the draft into `docs/specs`. That circular pre-review location constraint was recorded honestly as unavailable, not skipped. The finalized spec is now inside `docs/specs` and the normal conformance and precommit gates apply.

## Findings catalog and dispositions

- **Source binding (high):** the old helper accepted raw channel/thread arguments from the model. The new session helper accepts neither; the existing bind token authenticates a negative conversation id and the server resolves the verified tuple.
- **Thread flattening and prompt drift (high):** compaction and channel-context templates used a Claude path and omitted thread identity. One renderer contract plus a complete producer census and ratchet now covers initial spawn, recovery, compaction, channel context, and identity appendices. Runtime binding remains the authority.
- **Cross-machine adapter authority (high):** a local helper cannot assume every session owner holds Slack credentials. Slack sessions are admitted and transferred only to a machine with the matching local-origin conversation and enabled live adapter; off-authority and owner-dark states refuse honestly.
- **Customization overwrite (high):** header/marker detection could destroy an operator-customized script. Only current SHA or an append-only known-shipped prior SHA authorizes replacement; unknown files are preserved with a `.new` candidate and durable degradation.
- **Migration parity (high):** one `ensureSlackReplyRelay` primitive is used by fresh init, late configure, startup refresh, migrate, CLI update, and UpdateChecker fallback. Fresh, upgrade, customized, missing, and mode-repair fixtures are ship gates.
- **Exactly-once overclaim (high):** a helper normally mints a new UUID, so independent invocations are not exactly-once. The contract is narrowed to one invocation/same-id retries, with an explicit reuse mechanism and no automatic retry after ambiguity.
- **Bounded failure (medium):** connect and total curl timeouts, server timeout ordering, 408 ambiguity, 409 delivered-equivalent behavior, and non-redrive instructions are normative.
- **Concurrent installation (medium):** same-directory exclusive temporary files, fsync/chmod, compare-before-rename, and independent canonical/mirror reconciliation make update races convergent.
- **Rollback (medium):** prompts/hooks are restored before helper removal; known shipped files have versioned backups; unknown/custom files and candidates are never erased.
- **Evidence integrity (medium):** Tier 3 uses production init/refresh/server composition and a spawned non-Claude session rather than a directly constructed router. The exact WS3 failure is the regression fixture.

## Decision completeness

All non-cheap choices are frontloaded: destination authority, canonical path, exact Slack configuration predicate, customized-copy policy, cross-machine authority, thread isolation, timeout ambiguity, duplicate boundary, deployment order, and rollback order. There are no blocking open questions. Future cross-machine adapter proxying and durable response-attempt identity are acknowledged extensions, not hidden dependencies.

## Convergence verdict

The design composes existing Slack adapter, authenticated local server, conversation registry, bind-token verifier, tone gate, and deduplication rather than inventing a parallel send path. It meets the WS4 deliverables: spec first, all three test tiers, Migration Parity for session-scaffold installation, the live WS3 regression, and the canonical Slack runbook in the same PR. Ready to build.
