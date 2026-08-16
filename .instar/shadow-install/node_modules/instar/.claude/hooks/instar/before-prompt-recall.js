#!/usr/bin/env node
/**
 * before-prompt-recall — Claude Code UserPromptSubmit hook.
 *
 * Per OpenClaw import T2.2: a bounded pre-reply memory recall pass. Reads the
 * user's prompt from stdin, POSTs to instar's /internal/prompt-recall, and
 * echoes the resulting context block to stdout (which Claude Code injects
 * as additional context for the upcoming turn).
 *
 * The hook is synchronous from Claude Code's perspective — Claude Code waits
 * for stdout before continuing. The server's PromptBuildRecall enforces a
 * recallTimeoutMs (default 2000) so the hook is bounded.
 *
 * Default-off behavior: if the server is not configured (`promptBuildRecall.enabled: false`),
 * the endpoint returns `source: 'no-recall'` with empty contextText, and this
 * hook emits nothing. Cold path is free.
 *
 * Spec: docs/specs/OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.md
 */

const serverUrl = process.env.INSTAR_SERVER_URL || 'http://localhost:4042';
const authToken = process.env.INSTAR_AUTH_TOKEN || '';
const instarSid = process.env.INSTAR_SESSION_ID || '';

if (!authToken) {
  process.exit(0);
}

let data = '';
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', async () => {
  let userMessage = '';
  let sessionId = instarSid || undefined;
  try {
    const input = JSON.parse(data);
    userMessage = String(input.prompt || input.user_prompt || '');
    if (input.session_id) sessionId = String(input.session_id);
  } catch {
    process.exit(0);
  }

  if (!userMessage) {
    process.exit(0);
  }

  try {
    const { request } = await import('node:http');
    const url = new URL(serverUrl + '/internal/prompt-recall');
    const body = JSON.stringify({ userMessage, sessionId });

    const result = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Authorization': 'Bearer ' + authToken,
          },
          timeout: 3000,
        },
        (res) => {
          let chunks = '';
          res.on('data', (c) => { chunks += c; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(chunks));
            } catch {
              resolve({ contextText: '' });
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    if (result && typeof result.contextText === 'string' && result.contextText) {
      process.stdout.write(result.contextText + '\n');
    }
  } catch {
    // Best effort. Compaction proceeds even if recall fails.
  }
  process.exit(0);
});
