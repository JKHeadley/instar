#!/usr/bin/env node
// Plan Prompt Relay — detects plan mode entry, relays to Telegram, and BLOCKS
// until the user responds via inline keyboard buttons.
//
// Fires on PreToolUse for EnterPlanMode. Reports to the Instar server
// which relays the plan to Telegram. Then polls /hooks/plan-prompt/status
// until the user responds or a timeout is reached.
//
// If the user chooses option 3 ("Tell Claude what to change"), the hook
// returns {"decision": "block"} to prevent EnterPlanMode from executing.

const http = require('http');
const fs = require('fs');

const logFile = '/tmp/plan-prompt-relay-debug.log';
const log = (msg) => {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
};

const serverUrl = process.env.INSTAR_SERVER_URL || 'http://localhost:4042';
const authToken = process.env.INSTAR_AUTH_TOKEN || '';
const instarSid = process.env.INSTAR_SESSION_ID || '';

// Configurable timeout (default: 120 seconds)
const POLL_TIMEOUT_MS = parseInt(process.env.PLAN_RELAY_TIMEOUT_MS || '120000', 10);
const POLL_INTERVAL_MS = 2000;

log(`Hook fired. SERVER=${serverUrl} SID=${instarSid}`);

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function pollStatus(promptId) {
  const url = new URL(`${serverUrl}/hooks/plan-prompt/status?id=${promptId}`);
  return httpRequest({
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${authToken}` },
  });
}

async function main() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  log(`Stdin: ${data.slice(0, 500)}`);

  let input;
  try { input = JSON.parse(data); }
  catch { process.exit(0); }

  // Report plan mode entry to the server
  const payload = JSON.stringify({
    event: 'PlanModeEntry',
    session_id: input.session_id || '',
    tool_name: input.tool_name || 'EnterPlanMode',
    tool_input: input.tool_input || {},
    instar_sid: instarSid,
    telegram_topic: process.env.INSTAR_TELEGRAM_TOPIC || '',
  });

  const url = new URL(`${serverUrl}/hooks/plan-prompt`);
  let result;
  try {
    result = await httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
    }, payload);
  } catch (err) {
    log(`POST error: ${err.message}`);
    process.exit(0); // Don't block on server errors
  }

  log(`POST result: ${JSON.stringify(result)}`);

  if (!result.ok || !result.promptId) {
    // No topic binding or relay failed — don't block
    process.exit(0);
  }

  const promptId = result.promptId;
  log(`Polling for response: promptId=${promptId} timeout=${POLL_TIMEOUT_MS}ms`);

  // Poll until resolved or timeout
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const status = await pollStatus(promptId);
      if (status.resolved) {
        log(`Resolved: key=${status.key}`);
        // Option 3 = "Tell Claude what to change" → block the plan
        if (status.key === '3') {
          process.stdout.write(JSON.stringify({
            decision: 'block',
            reason: 'User wants to modify the plan before proceeding.',
          }));
        }
        // Options 1 and 2 = allow (hook returns without blocking)
        process.exit(0);
      }
    } catch (err) {
      log(`Poll error: ${err.message}`);
      // Continue polling on transient errors
    }
  }

  // Timeout — allow by default (don't block sessions forever)
  log('Timeout reached — allowing by default');
  process.exit(0);
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(0);
});
