# Side-effects review — dynamic-MCP agent awareness + migration

**Change:** A "Dynamic MCP Lifecycle" CLAUDE.md section (honestly experimental/dark),
delivered to new agents (generateClaudeMd) and existing agents (migrateClaudeMd) via
one shared `DYNAMIC_MCP_CLAUDEMD_SECTION(port)` helper. 3 unit tests.

## 1. Blast radius
Documentation only. No runtime behavior, no gate, no route. New agents get the
section at init; existing agents get it appended once on the next update.

## 2. Reversibility
Reversible — remove the helper + call sites + migration block. The migration is
add-if-missing; it never rewrites or deletes existing CLAUDE.md content.

## 3. State / data touched
Appends one section to the agent's own CLAUDE.md on update (idempotent, content-
sniffed on the heading). Nothing else.

## 4. Failure modes
The migration inherits migrateClaudeMd's guards (missing CLAUDE.md ⇒ skipped; read
error ⇒ recorded, no crash). Idempotent: a second run is a no-op (test-verified
byte-identical).

## 5. Security / authority
None. The section TEXT states the Know-Your-Principal authorization rule (the agent
cannot self-approve), which is enforced in code elsewhere; this is awareness, not
enforcement.

## 6. Framework generality
Documentation; the capability it describes is claude-code-scoped (stated in the
text). No framework-launch surface touched.

## 7. Tests
3 unit tests: the section lands on an existing agent (dark tag + /mcp/session + the
needs-approval rule); idempotent second run (byte-identical); generateClaudeMd
parity. Plus the existing migrator tests still green. tsc clean.
