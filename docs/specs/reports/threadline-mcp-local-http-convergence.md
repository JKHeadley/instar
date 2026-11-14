# Convergence Report — Threadline MCP over local HTTP

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran in all six rounds through the agent's codex CLI. Gemini was not available (`gemini-not-installed`); Grok is not enabled. The Standards-Conformance Gate was unavailable every round: `POST /spec/conformance-check` only reads specs inside the agent home's `docs/specs/`, and this spec lives in an instar worktree (refused with "specPath escapes specsDir"; queued as feedback fb-3bdf0337-7a0). The lessons-aware reviewers searched `docs/STANDARDS-REGISTRY.md` directly instead.

## ELI10 Overview

Every working session an agent runs starts a small helper program that gives it the agent-to-agent messaging tools. Each helper is a copy of the same program: about 45 MB of memory and a sixth of a second to start, and every one of them only forwards its work to the agent's main server, which is already running. This spec lets the main server offer those same tools directly, over a connection that only works on the same machine, so sessions stop needing a helper each.

It ships switched off. When it is on, a session that can use the new route gets it; anything doubtful (an old Claude Code or Codex, a failed self-check, a session deliberately stripped of credentials) gets the old helper, so nobody is worse off than today.

Two long-standing bugs are fixed along the way for everyone, switched on or not: waiting more than 30 seconds for another agent's reply used to be cut off (and a timed-out send was misreported as "not sent"), and those waits now get their full five minutes.

## Original vs Converged

- **Credential.** The first draft gave each session its own password for the new route. Review showed the routes behind the tools do not check any password and take the session's name on trust, so a per-session password would have protected nothing while adding a token store and restart machinery. Round 2 switched to the agent's main token; round 3 showed that token is replaced after a tunnel backup is used, which would silently cut running sessions off, and that a "previous token" grace reopened the very path the replacement closes. The converged design uses one machine-local secret file accepted only on this route, from the same machine, never sent anywhere and never replaced by tunnel events.
- **Honest attribution.** The draft claimed the per-session password made sends attributable. The converged spec says plainly that which session sent a message is self-reported, exactly as today, and files the underlying weakness separately.
- **Sharing, not duplicating.** The draft built new copies of the trust and discovery objects; review showed two copies in one process would overwrite each other's changes. The converged design uses the server's own live objects.
- **Real client behaviour, tested.** Claude Code 2.1.310 and codex-cli 0.156.1 were driven for real. Claude Code expands header variables and lets a per-session entry replace the global one. Codex merges its per-session settings into the shared file and refuses the result, so it gets a separately named entry and a careful, parse-checked disable of the shared one.
- **Registry.** Three rounds designed registry support; round 5 found today's helper never has registry tools at all (its login is always refused: 101 failures, no successes in the logs). The converged design matches that exactly and files the login bug.
- **Long waits.** Rounds 2–6 traced a 300-second wait through every layer and found it cut off at 30 s on the inner call and at 300 s by Node's own fetch, misreported on timeout, and not cancellable on disconnect. The converged design orders five deadlines with headroom between them, reports "outcome unknown" instead of "failed", cancels only on a genuine early disconnect, and never frees capacity while work is still running.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, scalability, integration, decision-completeness, GPT | 18 | 9 | per-session token dropped; shared live deps; isLocal context; registry via get(); middleware |
| 2 | security, integration, GPT | 9 | 13 | relay-send timeout; batch refusal; registry second-connection risk; token rotation; HTTP self-probe; version floor; Codex verified |
| 3 | integration, GPT | 4 | 9 | previous-token grace replaced by a local secret; undici agent; wait-slot reservation |
| 4 | GPT (internal: none) | 2 | 7 | per-request registry client; response/execution deadlines; middleware placement |
| 5 | integration, GPT | 3 | 10 | registry: null parity; ordered deadlines; outcome-unknown; both-branch cancellation |
| 6 | GPT (internal: none) | 2 (applied at cap, not re-reviewed) | 6 | res-close cancellation; no capacity release while work runs |

Standards-Conformance Gate: unavailable every round (specPath escapes specsDir; fb-3bdf0337-7a0).

## Proportion

Tier 2 (security-sensitive: a credential and a new route); 6 rounds of a 6-round cap. The spec is ~160 lines for a change touching about 8 source files. ⚠ The full cap was used; four of the six rounds each removed a factually wrong premise (unauthenticated routes, token rotation, helper registry behaviour, Node request-close semantics) rather than polishing, which is why it ran long.

## Left behind

- Round 6 GPT design findings, applied at the cap without a further round (neither is safety, security or data loss): cancellation keyed on `res.on('close')` with `!res.writableFinished`; slots never released for still-running work, reported as `stuckOperations` instead. The build's criterion 8 tests both.
- Attribution (`originSessionName`) stays self-asserted, as today — feedback fb-a9c21fc7-1bd.
- Registry tools absent on every agent because the helper's login omits `agentId` — feedback fb-8972c480-a75.
- `/threadline/relay-send` reachable from the public tunnel without a token — spun off to its own session (fb-829a7161-942); this spec neither causes nor depends on it.
- Codex project-scope `.codex/config.toml` entries are not checked by the shared-entry detection (fails safe: a duplicate helper).
- `allowedHosts` / `enableDnsRebindingProtection` are deprecated in SDK 1.27.1 (still functional).
- Precision items from every round not listed above were either applied in passing as one-line edits or are wording-only.

## Full Findings Catalog

Round-by-round reviewer outputs (internal: security+adversarial, scalability+integration, decision-completeness+lessons, then combined full-lens from round 4; external: GPT via codex-cli every round) were folded into the spec as listed in the Iteration Summary. Each round's GPT output is retained at `/home/echo/echo-test-tmp/codex-r{1..6}.json` on Mama PC for the duration of the build; the decisive facts each round turned on are recorded in the spec itself (D1–D6, Risks, Frontloaded Decisions 1–17) with file:line references.

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The final internal round found no design-class issue; the final external round's two design findings were concrete, non-safety corrections with obvious fixes, applied and recorded above. Zero open user decisions. Spec is ready for build.
