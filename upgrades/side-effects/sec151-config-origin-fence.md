# Side effects: the settings API cannot change the public address, the relay addresses, the agent-network trust switches, what a peer-started session may touch, which framework runs, or where feedback goes (SEC-151)

In plain words: the settings API, and the bearer writer that holds the same rules, could change the named tunnel's token, config file and hostname, so one API call could point the agent's public address at another tunnel account. The same calls could change where agent-to-agent traffic goes, switch off the agent-network trust checks, widen what a session started by a peer may touch, change which framework runs, and send feedback to another host. Those settings now come only from the config file.

Tier 1. Size: 2 source files (`src/config/bearerConfigWrite.ts`, `src/server/routes.ts`), 1 new test file. It is stacked on the SEC-145 branch, which fences the session-binary and Anthropic-connection keys the same way.

## What changes for running agents
- One shared table, `OPERATOR_ONLY_CONFIG_PATHS`, holds the fenced paths:
  - `tunnel.token`, `tunnel.configFile`, `tunnel.hostname` and `tunnel.relayProviders`
  - `threadline.relayUrl` and `threadline.listener.relayUrl`
  - `threadline.listener.pipeMode.allowedTools`, `allowedPaths`, `minIqsBand` and `model`
  - the agent-network trust settings `threadline.encryptToPinned`, `refuseDowngrade`, `relayUnknownSenderTrust`, `localRouteTrust`, `firstContactPolicy` and `warmSessionA2A.trustFloor`. These are read live, so a change took effect with no restart.
  - `sessions.framework` (the agent-wide default, which has the highest precedence), `sessions.componentFrameworks`, `sessions.enabledFrameworks`, `sessions.frameworkDefaultModels` and `sessions.natureRouting`
  - `feedback.webhookUrl` and `feedback.feedbackFile`
- `PATCH /config` refuses with a 400 (`fenced: [...]`) any body that would change a fenced path. The route merges one level deep, so a body naming a second-level key replaces that whole subtree. A body with `threadline.listener` or `threadline.warmSessionA2A` is refused for that reason, as is a non-object top-level value. The single-path writer still allows `threadline.warmSessionA2A.enabled`.
- `bearerConfigWriteRefusal` refuses a single-path write at a fenced path, at an ancestor that would replace it, or beneath it, matching whole path segments.
- Unchanged: the feature switches (`tunnel.enabled`, `threadline.relayEnabled`, `feedback.enabled`, `dispatches.enabled`) and every other setting. The maturation ladder writes its `enabled` switches through the live config directly, not through these routes, so it is unaffected. The framework-enable route, which has its own confirmation, still sets `enabledFrameworks`.
- No caller in `src` or the dashboard writes a fenced path through these routes.

## Review
An independent reviewer read the diff and the code paths behind it. It found no bypass and nothing broken: arrays, nulls, prototype keys and empty path segments are all refused, and the other config-writing routes cannot reach a fenced path. It raised one blocking gap, the agent-wide default framework `sessions.framework`, and several settings of the same kind: the agent-network trust switches, the feedback address and file, the pipe-mode band and model, the per-framework default models and the nature-routing chains. All are added here. `dispatches.dispatchFile` is fenced by the SEC-153 change. `tunnel.type` is left open, since switching it changes availability only, not where traffic goes. On a second pass over the additions the reviewer concurred. It noted that the maturation ladder can still flip the `enabled` switches of the trust settings and nature routing through its direct write, by design, and that a config-change commitment on a fenced path is now refused safely (nothing is written; the drift is still reported).

## Signal vs authority
It only removes a way in. The operator still sets every one of these in the config file.

## Rollback
Revert the commit. No state is written.

## Not in this change
A true allowlist, naming every setting the API may change instead of listing the forbidden ones, needs an inventory of what the dashboard and the feature switches write. It follows as a separate design note to the Chief of Staff.

## Tests
- `tests/unit/sec151-config-origin-fence.test.ts` (new, 7 cases):
  - Each fenced path is named for a PATCH body, and a second-level replacement covers every fenced path below it.
  - The feature switches and ordinary settings pass.
  - The bearer writer refuses fenced paths, their ancestors and their descendants, allows the switches beside them, and matches whole segments.
  - A wiring check shows `PATCH /config` runs the table.
- Also pass: `bearer-config-write`, `feature-enableaction-validity`, `feature-action-applier`, `org-action-check`, `grok-build-round17-security`, `Config`. Integration and end-to-end runs are left to Local Verify.
