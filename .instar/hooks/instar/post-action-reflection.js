#!/usr/bin/env node
// Post-action reflection — evolution awareness after significant actions.
// PostToolUse hook for Bash. When the agent commits, deploys, or
// completes a task, captures the step for Living Skills and injects
// a brief reminder to capture learnings.
//
// "Every action is an opportunity to learn. Most of that learning is lost
// because nobody paused to ask: what did this teach me?"

const fs = require('node:fs');
const pathMod = require('node:path');

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Significant action patterns — moments worth reflecting on
    const significantPatterns = [
      /git\s+commit/i,
      /git\s+push/i,
      /npm\s+publish/i,
      /curl/i,
      /docker/i,
      /deploy/i,
      /prisma/i,
      /psql/i,
      /npm\s+run\s+build/i,
      /npm\s+test/i,
      /instar\s+server\s+restart/i,
    ];

    const isSignificant = significantPatterns.some(p => p.test(command));

    // Living Skills: capture step to pending journal if enabled
    const cwd = input.cwd || process.cwd();
    const sessionId = process.env.INSTAR_SESSION_ID || '';
    const jobSlug = process.env.INSTAR_JOB_SLUG || '';

    if (isSignificant && sessionId && jobSlug) {
      // Check for sentinel file (created by JobScheduler when livingSkills.enabled)
      const instarDir = process.env.INSTAR_STATE_DIR || pathMod.join(cwd, '.instar');
      const sentinelPath = pathMod.join(instarDir, 'state', 'execution-journal', '_ls-enabled-' + jobSlug);

      try {
        if (fs.existsSync(sentinelPath)) {
          // Sanitize command before writing
          const REDACT = [
            /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi,
            /Authorization:\s*[^\s"']*/gi,
            /(api[_-]?key|apikey|api_secret)\s*[:=]\s*\S+/gi,
            /(password|passwd|secret|token)\s*[:=]\s*\S+/gi,
            /sk-[A-Za-z0-9]{20,}/g,
            /ghp_[A-Za-z0-9]{36}/g,
            /xox[baprs]-[A-Za-z0-9\-]+/g,
          ];
          let sanitized = command;
          for (const p of REDACT) { p.lastIndex = 0; sanitized = sanitized.replace(p, '[REDACTED]'); }
          sanitized = sanitized.slice(0, 500);

          const pendingFile = pathMod.join(instarDir, 'state', 'execution-journal', '_pending.' + sessionId + '.jsonl');
          fs.mkdirSync(pathMod.dirname(pendingFile), { recursive: true });
          const entry = {
            sessionId,
            jobSlug,
            timestamp: new Date().toISOString(),
            command: sanitized,
            source: 'hook',
          };
          fs.appendFileSync(pendingFile, JSON.stringify(entry) + '\n');
        }
      } catch { /* Living Skills capture failure is non-critical */ }
    }

    // Only show reflection reminder for the most significant actions
    const reflectionPatterns = [
      /git\s+commit/i,
      /git\s+push/i,
      /npm\s+publish/i,
      /curl\s+-X\s+POST.*\/deploy/i,
      /instar\s+server\s+restart/i,
    ];

    if (!reflectionPatterns.some(p => p.test(command))) process.exit(0);

    const reminder = [
      'POST-ACTION REFLECTION — Quick evolution check:',
      '',
      'Before moving on, consider:',
      '- Did this teach you something worth recording? → /learn',
      '- Did you notice a gap in your capabilities? → /gaps',
      '- Did you discover an improvement opportunity? → /evolve',
      '- Did you make a commitment to follow up? → /commit-action',
      '',
      'Skip if nothing notable. The value is in the pause, not the output.',
    ].join('\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: reminder }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
