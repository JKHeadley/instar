#!/usr/bin/env node
// SubagentStart hook — records subagent spawn events.
// Part of H5: subagent lifecycle tracking.
//
// SubagentStart is command-only (no HTTP hooks).
// Records agent_id and agent_type to tracking state.

const fs = require('node:fs');
const pathMod = require('node:path');

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (!input.agent_id) { process.exit(0); }

    const stateDir = pathMod.join(process.env.CLAUDE_PROJECT_DIR || '.', '.instar', 'state', 'subagent-tracking');
    fs.mkdirSync(stateDir, { recursive: true });

    const sessionId = (input.session_id || 'current').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
    const record = {
      agentId: input.agent_id,
      agentType: input.agent_type || 'unknown',
      sessionId: input.session_id || 'current',
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      lastMessage: null,
      transcriptPath: null,
    };
    fs.appendFileSync(pathMod.join(stateDir, sessionId + '.jsonl'), JSON.stringify(record) + '\n');
  } catch {}
  process.exit(0);
});
