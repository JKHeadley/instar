# Side-Effects Review — LLM HTTP lint constant folding

**Version / slug:** `llm-http-constant-folding`
**Date:** `2026-08-14`
**Author:** `Instar-codey`
**Tier:** 1 (one lint script plus focused unit coverage; no runtime code, route, config, migration, or persistence change)
**Second-pass reviewer:** `not required — CI/pre-commit lint hardening only; no runtime outbound message or session lifecycle decision`

## Summary of the change

`scripts/lint-no-direct-llm-http.js` now folds adjacent constant string and no-expression template literals joined by `+` before checking for known LLM provider hosts. This closes the reproduced split-host bypass (`'api.' + 'anthropic.com/v1/messages'`) while keeping scope at literal URL construction only. `tests/unit/burn-detection-phase-1.test.ts` adds red/green coverage for split Anthropic, OpenAI, and Google host literals plus a non-folded dynamic construction control.

Build location re-grounding: work was built in fresh worktree `/Users/justin_instar_1/.instar/agents/instar-codey/.worktrees/agent-llm-http-constant-folding` from current `JKHeadley/main` (`4731ec6a90356ed319454a996b4eb72edcf38ab2`), created through `npx -y instar@1.3.1144 worktree create ... --base origin/main` after the local wrapper lacked an installed package. Remote verified as `origin https://github.com/JKHeadley/instar.git`; package version verified as `1.3.1144`.

## Decision-point inventory

- `scripts/lint-no-direct-llm-http.js` — modify — build-time block/allow decision for direct provider HTTP references outside the provider chokepoint and named metadata exceptions.

## 1. Over-block

The new over-block risk is a benign constant string in production source that names a provider host across literal pieces without making a call. That is the same policy as the existing unsplit-host lint: production source outside the allowlist should not carry raw provider host literals because they become copyable direct-call paths. The real-tree scan after the fix was clean.

OAuth/profile/usage metadata readers keep their existing allowlist/grandfather treatment; this change did not add endpoint-level bans that would collapse metadata reads into inference calls.

## 2. Under-block

The lint still misses dynamic construction, such as `'https://api.' + providerHost + '/v1/messages'`, computed arrays joined into a host, decoded strings, or runtime config that points at a provider endpoint. That is intentional for this PR: automatic discovery/dataflow was the high-false-positive direction. The closure here is constant URL literals, not semantic HTTP-call proof.

## 3. Level-of-abstraction fit

Correct layer: this is a deterministic CI lint in the existing `lint-no-*` family. The protected invariant is "new production raw LLM provider host literals outside the chokepoint require review." The lower-level primitive is a string-literal scanner, not an authority over runtime user intent.

## 4. Signal vs authority compliance

Reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

This change holds blocking authority with brittle logic, but it is a build-time hard invariant/safety guard, not a conversational judgment point. The lint blocks source code containing direct provider endpoint literals outside reviewed locations, analogous to a safety guard on data egress and spend attribution. It does not decide whether a user message is appropriate or whether an agent action should proceed at runtime.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The input is source text and an enumerated provider-host list; there are no live competing signals such as urgency, recency, ownership, or liveness.

## 5. Interactions

- **Shadowing:** It runs inside the existing `npm run lint` chain. It may fail before later lints, as before; no downstream lint depends on side effects from this script.
- **Double-fire:** `lint-llm-attribution.js` and other provider-path checks may catch related defects, but this one reports direct HTTP host literals specifically. Duplicate CI failures are acceptable because they point at the same source change.
- **Races:** No shared state. It reads files and exits.
- **Feedback loops:** None.

## 6. External surfaces

No runtime external surface changes. Other agents and users only see this as a stricter build/pre-commit/CI failure when source contains a newly-recognized split provider URL. No Telegram, Slack, GitHub API, dashboard, database, ledger, or generated URL behavior changes. No operator-facing action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: this is a repository lint run independently in each checkout/CI runner. It emits no user-facing notices, holds no durable state, and generates no URLs. Multi-machine consistency comes from the shared git commit containing the lint and tests.

## 8. Rollback cost

Pure code/test/docs change. Rollback is a hot-fix revert of the lint folding helper and tests. No data migration, no agent state repair, and no user-visible runtime regression while rollback propagates.

## Conclusion

The real-tree scan stayed clean and the negative control failed for the intended old-lint cases, so the scoped constant-folding fix is clear to ship. No broader automatic actuator discovery or dynamic URL dataflow was added.

## Second-pass review

Not required.

## Evidence pointers

- Old-lint focused run: `npx vitest run tests/unit/burn-detection-phase-1.test.ts` failed 2 of 20 tests, specifically the two new split-host rejection tests.
- Fixed targeted run: `npx vitest run tests/unit/burn-detection-phase-1.test.ts` passed 20/20.
- Fixed real-tree scan: `node scripts/lint-no-direct-llm-http.js` exited 0.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
