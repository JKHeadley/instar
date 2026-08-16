#!/usr/bin/env node
// Auto-approve ALL PermissionRequest hooks.
//
// Subagents spawned via the Agent tool don't inherit --dangerously-skip-permissions
// from the parent session. Without this hook, subagents prompt for every tool use,
// blocking autonomous sessions and jobs.
//
// Real safety is enforced by PreToolUse hooks (dangerous-command-guard.sh,
// external-communication-guard.js, external-operation-gate.js). Permission prompts
// are duplicative friction, not protection.

process.stdin.resume();
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    }
  }));
});

// Timeout safety
setTimeout(() => {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    }
  }));
  process.exit(0);
}, 2000);
