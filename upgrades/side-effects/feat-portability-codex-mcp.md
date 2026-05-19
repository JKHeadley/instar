# Side-effects review — Framework-aware Threadline MCP registration (Gap 2)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER — Codex agents on the network had no advertised MCP tools.
After: no over-block. Codex registration only runs when `~/.codex/` exists;
a Claude-only host is untouched. Both Claude registration blocks are
byte-identical.

## 2. Level-of-abstraction fit

Reuses the existing `OpenAiCodexMcpToolRegistry` (the dedicated Codex TOML
writer). ThreadlineBootstrap orchestrates; the registry owns the format. No
TOML logic duplicated.

## 3. Signal vs Authority compliance

`~/.codex/` existence is the SIGNAL that a Codex runtime is present; the
registry is the single AUTHORITY for the TOML shape. No brittle inline
writer.

## 4. Interactions with adjacent systems

- **Claude registration (~/.claude.json, .mcp.json)** — unchanged,
  byte-identical, still first.
- **OpenAiCodexMcpToolRegistry** — used as-is; its existing tests plus 4 new
  Gap-2 tests cover the path. No change to the registry itself.
- **bootstrapThreadline** — the one call site now awaits the (now async)
  registerThreadlineMcp; downstream steps already followed it sequentially,
  so ordering is preserved.
- **Operator config.toml** — idempotent remove-then-append of only the
  `threadline` table; unrelated `[mcp_servers."other"]` / `model = ...`
  content preserved (tested).

## 5. Rollback cost

Low. One function made async + one awaited call site + one appended block +
one new test. `git revert` restores prior behavior. A leftover
`[mcp_servers."threadline"]` in a Codex config after revert is inert (Codex
just launches an MCP that isn't used).

## 6. Backwards compatibility / drift surface

Claude-only hosts: byte-identical behavior (Codex block gated out). Dual/
Codex hosts: strictly better (tools now advertised). Drift surface: none —
the TOML writer is the single existing registry, not a copy.

## 7. Authorization / Trust posture

No new authority. Writes only the `threadline` MCP table to a config the
operator's Codex already owns, gated on Codex being installed. Non-fatal:
failure cannot break Claude registration or bootstrap, cannot escalate.

## Outcome

Ship. Empirically grounded, reuses a tested writer (no duplication),
default-safe (Codex-presence gated), idempotent, operator-content
preserving, trivial rollback. Sixth shipped of the v1.0.9–v1.0.14 series
(1.0.13) — the final code-level portability gap. Gap 6 remains for operator
architecture review by design.
