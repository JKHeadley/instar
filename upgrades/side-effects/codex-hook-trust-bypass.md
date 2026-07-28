# Side-Effects Review: Codex hook-trust bypass (P6a — autonomy)

## Change
- **New** `src/core/codexCapabilities.ts`: memoized `codexSupportsHookTrustBypass(binaryPath)` — probes `codex --help` once per binary path, returns whether `--dangerously-bypass-hook-trust` is supported. Fails closed on any error.
- **`src/core/frameworkSessionLaunch.ts`**: both the interactive (`codexCliBuilder`) and headless (`codexCliHeadlessBuilder`) codex builders append `--dangerously-bypass-hook-trust` when the probe passes.

## Why
Codex requires interactive trust of command hooks before they run; that prompt freezes an unattended/autonomous session and offers a "continue without trusting" escape that lets an agent decline its own guards. The flag (codex 0.133) runs instar's already-vetted hooks with no prompt. Per Justin's delegation ("choose what's best for Instar", 2026-05-24), chosen as a **per-agent launch flag** over system-managed hooks — see spec §10 P6a for the full rationale.

## Scope / blast radius
- **Codex launches only.** Claude launches are untouched (separate builder). The flag is appended only to codex argv, and only when the probed binary supports it.
- **Safe-by-construction:** instar writes the hooks (`installCodexHooks`) AND owns the launch command — there is no untrusted third-party hook this prompt would have protected against. The "danger" of the flag (running arbitrary untrusted hooks) does not apply.
- **No system-wide effect:** unlike managed hooks, this changes nothing outside instar's own spawned codex processes. The operator's personal `codex` launches do not get the flag and still prompt normally.
- **Older codex (<0.133):** the probe returns false → flag omitted → the launch still succeeds (an unknown flag would otherwise fail the whole launch) and degrades to the safe-by-blocking interactive trust-prompt path.

## Signal vs Authority / over-block
- No change to what the hooks block. This only affects whether they run unprompted. No new authority, no new patterns.

## Performance
- The probe runs `codex --help` at most once per binary path per process (memoized), at session-spawn time (infrequent), 5s timeout. Negligible.

## Migration parity
- **None required.** This is instar's own dist code (the launch builders), not an agent-installed file (`.claude/settings.json` / `.codex/hooks.json` / hook scripts / config defaults). Existing agents receive it on the normal npm update + server restart. (The P5c hooks.json/guard changes that this depends on already shipped in v1.2.66 with their own migration.)

## Unbypassability (honest bound)
- The agent cannot remove the flag from a launch instar constructs → it cannot turn off the trust-bypass. It could still attempt to edit `.codex/hooks.json` / the guard script to neuter the hook itself; that residual vector is covered by always-overwrite-on-update of instar-owned hooks + the file-edit gates, not by this change. Absolute unbypassability would require system-managed hooks, deliberately not chosen (see spec §10 P6a).

## Tests
- `tests/unit/codexCapabilities.test.ts` (5): supported/unsupported `--help`, fail-closed on missing + empty path, memoization (cached true survives binary deletion).
- `tests/unit/frameworkSessionLaunch.test.ts` (+4): interactive & headless builders append the flag when the fake binary advertises it, omit it when it doesn't; prompt stays the final positional arg in headless.
- Live-proven end-to-end on real codex 0.133 (no trust granted → no prompt → guard still blocked `rm -rf /`). `tsc` clean; 53 launch/capability tests green.

## Rollback
- Remove the two `if (codexSupportsHookTrustBypass(...)) argv.push(...)` blocks and delete `codexCapabilities.ts`. No data migration. (Rollback re-introduces the autonomous-hang on the trust prompt.)

## Publish
- Branch `echo/codex-hook-trust-bypass`. Patch → next release.
