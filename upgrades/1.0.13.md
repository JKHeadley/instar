# Upgrade Guide — v1.0.13 (portability hardening 6 of 6 code gaps)

<!-- bump: patch -->

## What Changed

The final code-level cross-framework portability hardening patch. Five of the
six audit gaps shipped as v1.0.9–v1.0.12; this is the sixth (Gap 2).

When an agent joins the agent-to-agent Threadline network, the Threadline MCP
server was registered only into Claude Code configuration. A Codex agent had
the network connection running but its runtime never knew the Threadline
tools existed. Setup now also registers the Threadline MCP server into Codex
configuration when Codex is installed on the machine.

The Codex configuration format and location were verified against a live
Codex install, not assumed. Registration reuses the existing, already-tested
Codex configuration writer, so there is no second copy of that logic to drift.

## Evidence

Reproduction prior to this change: run a Codex agent, join the Threadline
network. The relay connects, but the Threadline MCP tools
(discover/send/trust/relay) are absent from the Codex runtime because
registration only wrote Claude Code's configuration files.

Observed after this change: on a host where Codex is installed, the
Threadline MCP server is also written as a `[mcp_servers."threadline"]` table
in Codex's user configuration, so Codex launches it and the tools are
reachable. On a Claude-only host (no Codex installed) nothing changes — the
Codex step is skipped. Existing Claude Code configuration writes are
byte-for-byte unchanged and still happen first.

Unit verification: `tests/unit/threadline-codex-mcp-registration.test.ts` —
four cases against an isolated Codex config location: the stdio server table
is written; re-registration replaces rather than duplicates the table;
unrelated operator configuration content is preserved; the registered state
is reported correctly. The ThreadlineBootstrap regression suite passes.

## What to Tell Your User

- "If you run an agent on Codex and connect it to the agent network, its tools now actually work from Codex, not just from Claude Code. Claude-only setups are unchanged."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex MCP registration | Automatic when joining the Threadline network on a host with Codex installed. |
| No-duplication guarantee | Re-running setup replaces the Threadline server entry rather than duplicating it, and leaves other Codex configuration intact. |

## Deferred (Tracked Follow-ups)

- One audit item remains: unifying the post-update migrator's identity
  handling with the identity renderer (how the rich Claude capability
  document relates to the canonical identity source). This is a genuine
  architecture decision and is being reviewed with the operator rather than
  refactored blind — it is not a deferral of doable work.
