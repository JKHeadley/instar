#!/usr/bin/env node
// InstructionsLoaded hook — records which instruction files loaded.
// Part of H4: identity verification for Claude Code sessions.
//
// Fires for each CLAUDE.md file that loads. Records to a tracking file
// so the session-start hook can verify expected files were present.

const fs = require('node:fs');
const pathMod = require('node:path');

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const stateDir = pathMod.join(process.env.CLAUDE_PROJECT_DIR || '.', '.instar', 'state', 'instructions-tracking');
    fs.mkdirSync(stateDir, { recursive: true });

    const sessionId = (input.session_id || 'current').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
    const record = {
      timestamp: new Date().toISOString(),
      filePath: input.file_path || '',
      memoryType: input.memory_type || '',
      loadReason: input.load_reason || '',
      sessionId: input.session_id || 'current',
    };
    fs.appendFileSync(pathMod.join(stateDir, sessionId + '.jsonl'), JSON.stringify(record) + '\n');
  } catch {}
  process.exit(0);
});
