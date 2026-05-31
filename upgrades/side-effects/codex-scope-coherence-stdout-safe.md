# Side-effects — scope-coherence-checkpoint codex stdout-safe

## 1. What files/state does this touch at runtime?
Only the generated `.instar/hooks/instar/scope-coherence-checkpoint.js` (rewritten
by the always-overwrite built-in-hook migration). At Stop time the hook reads its
state file + (when deep) fetches active-job context — unchanged. The only change is
what it writes to stdout on the allow paths (now nothing).

## 2. Does it change any functional behavior?
- **Claude:** none. Empty stdout == approve in Claude Code, identical to the prior
  explicit `{decision:'approve'}`. The scope-checkpoint still blocks (prompts) when
  deep-implementation + cooldown + min-age conditions are met.
- **codex:** the allow paths no longer emit `{decision:'approve'}`, so codex stops
  reporting "invalid stop hook JSON output" on session completion. The block path is
  unchanged (codex accepts `{decision:'block',...}`).

## 3. What happens on failure / weird input?
The catch-all error path now allows (empty stdout) instead of emitting approve-JSON
— same allow outcome, codex-safe. Malformed stdin still falls through to allow.

## 4. Migration parity — do existing agents get it?
Yes, automatically. The hook is in the always-overwrite built-in-hook set, so every
agent regenerates it from the fixed `getScopeCoherenceCheckpointHook()` on its next
update (incl. instar-codey). No marker/sniff needed.

## 5. Could it spam / flood / burn resources?
No — it REDUCES output (writes less). The hook runs only at Stop, same as before.

## 6. Rollback / off-switch?
Revert the PR; the next update regenerates the prior hook. No residual state, no
flag. Reverting restores `{decision:'approve'}` (Claude unaffected; codex error
returns).

## 7. Concurrency / ordering?
None new. Single short-lived hook process per Stop event, unchanged.

## Blast radius
Small + behavior-preserving on Claude, error-fixing on codex. One generator method
in PostUpdateMigrator (six allow-path stdout writes removed; block path kept) + test
updates. Mirrors the #604 codex-stdout convention. The broader approve-JSON class
(other hooks + additionalContext signal hooks) is explicitly out of scope, tracked
under #32 / ledger issue codex-stop-chain-multi-json-invalid.
