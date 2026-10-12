#!/usr/bin/env node
// Response Review — Stop hook for the Coherence Gate response review pipeline.
//
// Thin client: reads stdin JSON, posts to the Instar server's /review/evaluate
// endpoint, and returns the verdict. All review logic lives server-side.
//
// Unlike other stop hooks, this does NOT skip when stop_hook_active is true.
// The CoherenceGate handles retry tracking and exhaustion internally.
// The hook always passes the stopHookActive flag so the server can decide.

//
// ESM-SAFE: dynamic `await import(...)` inside an async IIFE so this runs in
// both CJS and ESM host package types. Bare top-level `require(...)` throws in
// ESM scope when the host has "type":"module" — silently killed this hook on
// every fire. See hook-event-reporter.js header for the documented pattern.

(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const http = await import('node:http');

// Read config for port and auth token. Token: env first (SessionManager injects
// INSTAR_AUTH_TOKEN per spawned session — survives secret-externalization), legacy
// plaintext-config fallback with a string-type guard so the { secret: true }
// placeholder produced by SecretMigrator can never leak as a Bearer.
let serverPort = 4042;
let authToken = process.env.INSTAR_AUTH_TOKEN || '';
try {
  const configPath = path.join(process.env.CLAUDE_PROJECT_DIR || '.', '.instar', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const cfg = JSON.parse(raw);
  serverPort = cfg.port || 4042;
  if (!authToken && typeof cfg.authToken === 'string') authToken = cfg.authToken;
} catch {}

// Check if response review is enabled in config
let reviewEnabled = false;
try {
  const configPath = path.join(process.env.CLAUDE_PROJECT_DIR || '.', '.instar', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const cfg = JSON.parse(raw);
  reviewEnabled = cfg.responseReview && cfg.responseReview.enabled;
} catch {}

if (!reviewEnabled) {
  process.exit(0);
}

  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch { process.exit(0); }

  try {
    const input = JSON.parse(data);
    const message = input.last_assistant_message || '';

    // Skip empty or very short messages (greetings, etc.)
    if (!message || message.length < 20) {
      process.exit(0);
    }

    // Determine channel from environment
    const topicId = process.env.INSTAR_TELEGRAM_TOPIC;
    const sessionId = process.env.INSTAR_SESSION_ID || 'unknown';
    const channel = topicId ? 'telegram' : 'direct';
    const isExternalFacing = !!topicId; // Telegram = external

    // Build the review request
    const body = JSON.stringify({
      message,
      sessionId,
      stopHookActive: !!input.stop_hook_active,
      context: {
        channel,
        topicId: topicId ? parseInt(topicId, 10) : undefined,
        recipientType: 'primary-user',
        isExternalFacing,
      },
    });

    // Call the review endpoint with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch('http://127.0.0.1:' + serverPort + '/review/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        // Server error — fail open (approve)
        process.exit(0);
      }

      const result = await res.json();

      if (!result.pass) {
        // BLOCK — return feedback to the agent for revision
        const reason = result.feedback || 'Response did not pass coherence review.';
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason,
        }));
        process.exit(2);
      }

      // PASS — optionally include warnings
      if (result.warnings && result.warnings.length > 0) {
        process.stderr.write('[response-review] Warnings: ' + result.warnings.join('; ') + '\n');
      }

      process.exit(0);
    } catch {
      // Network error or timeout — fail open
      clearTimeout(timeout);
      process.exit(0);
    }
  } catch {
    // JSON parse error on stdin — fail open
    process.exit(0);
  }
})();

