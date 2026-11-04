# Whole-agent Threadline status

## What Changed

Echo can run on several computers. Only one computer holds the live Threadline connection at a time, so a standby's local connection is intentionally off. The old status answer described that local fact as though Threadline were off for Echo. A session could then tell Justin the agent network was unavailable when the Studio was connected.

The status routes now check the other known machines and lead with whether Echo is reachable, which machine currently carries the connection, and what happens if that machine goes away. A peer must answer with Echo's verified relay identity before its connection counts. If a holder cannot be checked, the answer is **unknown**; the standby's local setting remains visible as secondary detail. The MCP status and discovery tools use the same agent verdict, and discovery can use the holder's server connection from a standby.

The channel registry also checks Slack across known machines. This fixes the measured false "Slack is not enabled" answer from Mama PC while the Studio was connected. A dark peer keeps a negative answer unknown. The session guidance for existing and new installs now tells a session which field describes the whole agent. The existing posture lint and side effects template now ask status surface authors to declare scope. Other local status surfaces are tracked in issue #2697.

## What to Tell Your User

Threadline is available through Echo's connected machine even when the computer hosting this conversation is on standby. If that machine cannot be checked, Echo says its reachability is unknown.

## Summary of New Capabilities

- Whole-agent Threadline status from any machine.
- Standby MCP network discovery through the connected holder.
- Whole-agent Slack channel verdict in `/channels`.

## Evidence

Before: on 2026-11-03, the Studio reported Threadline connected and Slack working, while Mama PC reported Threadline and Slack not configured. A standby-origin Telegram operation also reported delivered without a message ID; that separate reply fix is in progress. After: focused tests cover a verified connected holder, a dark holder, no holder, wrong identity, bounded peer reads, public health privacy, MCP discovery, and Slack aggregation. Live standby verification awaits rollout of this release and is not claimed here.
