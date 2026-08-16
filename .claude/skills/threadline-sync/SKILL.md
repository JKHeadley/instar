---
name: threadline-sync
description: Compare standalone threadline-mcp package against built-in Threadline and sync features
metadata:
  user_invocable: "false"
---

# Threadline Implementation Sync

## Purpose

Keep two Threadline implementations in sync. The standalone `threadline-mcp` (packages/threadline-mcp/) is published to npm; the built-in Threadline (src/threadline/) is integrated with Instar. Features developed in one should propagate to the other.

## Procedure

Read the auth token:

```
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
```

### Step 1: Compare Feature Sets

Read both implementations:
- `packages/threadline-mcp/src/server.ts` — standalone (check version: `cat packages/threadline-mcp/package.json | grep version`)
- `src/threadline/ThreadlineMCPServer.ts` — built-in
- `src/threadline/ThreadlineBootstrap.ts` — bootstrap/registration

Compare:
- Tool count and names (standalone has 11 tools as of v0.3.0)
- Relational features: ContactStore, ProfileStore, HistoryStore, notes, trust levels
- Security: prompt injection framing, challenge-response auth
- Resilience: reconnect with backoff, write serialization
- Any features the built-in has that standalone doesn't (session resume, autonomy gates)

### Step 2: Identify Sync Opportunities

Which features from the standalone should be backported to the built-in?
Prioritize by: (a) user-facing impact, (b) implementation effort, (c) compatibility risk.

### Step 3: Check for Divergence Risks

Are the two implementations drifting in incompatible ways?
- Different message envelope formats?
- Different auth protocols?
- Different tool naming conventions?

### Step 4: Take Action

For LOW-EFFORT backports (< 30 min each):
- Implement them directly. Write the code, build, test.

For MEDIUM/HIGH-EFFORT backports:
- Create evolution proposals with clear specs.

### Step 5: Write Handoff

```
echo "Threadline sync at $(date). Standalone: vX.X.X (N tools). Built-in: N tools. Features synced: [list]. Proposals created: [list]. Next sync targets: [list]." > .instar/state/job-handoff-threadline-sync.md
```

## Important

- The standalone package is published to npm — do NOT modify it in this job. Only modify the built-in implementation.
- Always read the current source, don't assume.
- If you implement a backport, run existing tests to verify nothing breaks.
