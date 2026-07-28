# Side-effects review — analysis-paralysis-guard: ESM-safe module loading

**Change:** in the generated hook template, two top-level `require` calls become `await import('node:…')`
inside the stdin `end` handler, which becomes `async`.

| Surface | Effect |
|---|---|
| CJS-mode agents | Unchanged in practice — dynamic `import()` works in CommonJS too. |
| **ESM-mode agents** | **Fixed.** Previously the hook threw `require is not defined` on every tool call. |
| Hook semantics | None. Same window, same threshold, same checklist, still advisory. |
| Other hooks / files | None — one template string in `PostUpdateMigrator`. |

## The one behavioural nuance worth stating

The handler is now `async`, so it returns a promise the `end` listener does not await. Node keeps the
process alive until the microtask completes and the handler still calls `process.exit` on its own paths,
so ordering is unchanged in practice. The hook is advisory and its worst failure mode is not emitting a
checklist — it cannot block a tool call or fail a session either way.

## Why this matters more than a lint fix

The guard is a **PostToolUse** hook: it runs after *every* tool call. A crash-on-load is not degraded
behaviour, it is a per-tool-call exception on every affected agent. And it installs through
`PostUpdateMigrator`, so it would have reached existing agents on update, not just fresh installs.

This is the `hook-event-reporter.js` incident's shape exactly — the reason built-in hooks are now always
overwritten rather than install-if-missing, and the reason
`tests/unit/no-bare-require-in-generated-hooks.test.ts` exists. The PR predates that test (2026-05-23),
so this was never ignored; it had simply never been measured.

## Verification

- `tests/unit/no-bare-require-in-generated-hooks.test.ts`: **28/28 green**; it failed on this hook before.
- No change to the hook's logic — only where `fs`/`path` come from.
