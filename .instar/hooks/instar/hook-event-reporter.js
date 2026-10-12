#!/usr/bin/env node
// Hook Event Reporter — command hook replacement for HTTP hooks.
//
// Claude Code HTTP hooks (type: "http") silently fail to fire as of v2.1.78.
// This command hook achieves the same result: POST hook event data to the
// Instar server, which populates claudeSessionId for session resumption.
//
// NOTE: Uses `await import('node:http')` instead of `require('http')` so this
// script works regardless of the host package.json's module type. A plain
// `require` throws in ESM scope (when the host has "type": "module"); a plain
// `import` is a syntax error in CJS scope. Dynamic import works in both.

const serverUrl = process.env.INSTAR_SERVER_URL || 'http://localhost:4042';
const authToken = process.env.INSTAR_AUTH_TOKEN || '';
const instarSid = process.env.INSTAR_SESSION_ID || '';

if (!authToken || !instarSid) {
  process.exit(0);
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', async () => {
  try {
    const { request } = await import('node:http');
    const input = JSON.parse(data);
    const payload = JSON.stringify({
      event: input.hook_event || (input.tool_name ? 'PostToolUse' : 'Unknown'),
      session_id: input.session_id || '',
      tool_name: input.tool_name || '',
      // green-pr-automerge Layer 2: forward the session cwd so the server can
      // resolve the ending session's branch (without it, Layer 2 ships inert).
      // (Reconciled with the init.ts copy — keep BOTH in sync.)
      cwd: input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd() || '',
      // scope-accretion ADVISORY ledger (spec autonomous-scope-accretion-
      // completion.md R18): forward the Write/Edit file path for attribution
      // detail. Optional + designed-benign: the receiver stores extra fields
      // as-is and a payload without it remains valid.
      file_path: (input.tool_input && (input.tool_input.file_path || input.tool_input.path)) || '',
      // jev-circles-shadow (docs/specs/jev-circles-shadow.md): the session's own
      // transcript path, so the server can build the measured action window
      // (commands, results AND failures — a failed tool fires PostToolUseFailure,
      // which this hook never sees). A path, never content.
      transcript_path: input.transcript_path || '',
    });

    const url = new URL(serverUrl + '/hooks/events?instar_sid=' + instarSid);
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken,
      },
      timeout: 3000,
    }, (res) => {
      res.resume();
    });

    req.on('error', () => {});
    req.write(payload);
    req.end();

    setTimeout(() => process.exit(0), 50);
  } catch (e) {
    process.exit(0);
  }
});

setTimeout(() => process.exit(0), 2000);
