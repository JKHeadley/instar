# Side-Effects Review — componentFrameworks load-path fix

## Blast radius

One field passthrough in `Config.load`'s sessions construction:
`fileConfig.sessions.componentFrameworks` → `config.sessions.componentFrameworks`
(object-typed values only; absent/invalid → field omitted, exactly as today).

- Agents that never set the field: byte-identical loaded config (the
  no-phantom-field test pins this).
- Agents that set it (per the docs): the IntelligenceRouter's
  `resolveConfig()` now actually sees it — the documented behavior finally
  happens. The router already validates per-call: unknown/unavailable
  frameworks degrade to the default framework WITH a DegradationReporter
  emission, so a bad value cannot break the LLM path.

## Framework generality

The fix is framework-agnostic by construction — it carries the whole routing
table (categories/overrides/default for any of claude-code / codex-cli /
gemini-cli / pi-cli) without interpreting it; per-framework validation stays
in the router where it already lives.

## Why it was missed (causal)

Latent since the per-component-framework-routing feature shipped: its tests
constructed config OBJECTS in memory, never exercising the file-load path.
The exact-gap regression test added here loads a REAL file through
`loadConfig()`.

## Rollback

Revert the commit — the field returns to being dropped (the pre-fix
behavior). No data migrations, no state changes.
