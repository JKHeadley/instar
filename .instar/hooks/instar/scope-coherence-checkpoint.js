#!/usr/bin/env node
// Scope Coherence Checkpoint — Stop hook
// The structural zoom-out. Forces agents to step back and check the big picture
// when they've been deep in implementation without reading design docs.
//
// The 232nd Lesson: Implementation depth narrows scope.
// "See code -> wire it -> declare done" vs "read spec -> understand scope -> build right thing"
//
// Calls the Instar server for active job context to make the checkpoint actionable.

// CJS imports — this is a standalone hook script, not an ESM module
//
// ESM-SAFE: dynamic `await import(...)` inside an async IIFE so this runs in
// both CJS and ESM host package types. Bare top-level `require(...)` throws in
// ESM scope when the host has "type":"module" — silently killed this hook on
// every fire. See hook-event-reporter.js header for the documented pattern.

(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const http = await import('node:http');

const STATE_FILE = path.join(process.env.CLAUDE_PROJECT_DIR || '.', '.instar', 'state', 'scope-coherence.json');
const DEPTH_THRESHOLD = 20;
const COOLDOWN_MS = 30 * 60 * 1000;  // 30 minutes
const MIN_AGE_MS = 5 * 60 * 1000;    // 5 minutes

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return { implementationDepth: 0 };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function fetchActiveJob() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:4042/context/active-job', { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch { process.exit(0); }

  try {
    // ALLOW = empty stdout + exit 0. We deliberately do NOT emit
    // {decision:'approve'} on the allow paths: codex's Stop-hook contract treats
    // any non-empty stdout that isn't a recognized block decision as invalid
    // ('hook returned invalid stop hook JSON output'), so an explicit approve-JSON
    // breaks every codex session completion. Claude treats empty == approve, so
    // emitting nothing is byte-equivalent there. Only the BLOCK path writes JSON
    // (codex accepts {decision:'block',...}). Sibling of #604 (autonomous-stop-hook).
    let _input = {};
    try { _input = JSON.parse(data); } catch {}
    if (_input && _input.stop_hook_active) {
      // Re-entry guard: never re-block a correction continuation. (allow = empty)
      process.exit(0);
      return;
    }

    // Never block headless/job sessions — no human to dismiss the block.
    // INSTAR_SESSION_ID is set for all server-spawned sessions.
    if (process.env.INSTAR_SESSION_ID && !process.env.TERM_PROGRAM) {
      process.exit(0);
      return;
    }

    const state = loadState();
    const now = Date.now();
    const depth = state.implementationDepth || 0;

    if (depth < DEPTH_THRESHOLD) {
      process.exit(0);
      return;
    }

    // Check cooldown
    if (state.lastCheckpointPrompt) {
      const elapsed = now - new Date(state.lastCheckpointPrompt).getTime();
      if (elapsed < COOLDOWN_MS) {
        process.exit(0);
        return;
      }
    }

    // Check minimum session age
    if (state.sessionStart) {
      const age = now - new Date(state.sessionStart).getTime();
      if (age < MIN_AGE_MS) {
        process.exit(0);
        return;
      }
    }

    // Fetch active job context from server
    const jobData = await fetchActiveJob();
    const dismissed = state.checkpointsDismissed || 0;
    const docsRead = state.sessionDocsRead || [];

    let jobContext = '';
    if (jobData && jobData.active && jobData.job) {
      jobContext = '\nYou are running the **' + jobData.job.name + '** job.\n' +
        'Scope: ' + (jobData.job.description || 'No description') + '\n' +
        'Are you still within the job\'s boundaries?\n';
    }

    let docsContext = '';
    if (docsRead.length > 0) {
      const recent = docsRead.slice(-5).map(d => d.split('/').pop());
      docsContext = '\nDocs read this session: ' + recent.join(', ');
    } else {
      docsContext = '\nNo design docs, specs, or proposals have been read this session.';
    }

    let escalation = '';
    if (dismissed >= 3) {
      escalation = '\n\nYou\'ve dismissed ' + dismissed + ' scope checkpoints. ' +
        'Dismissing scope checks during deep implementation is how scope collapse happens.';
    }

    const reason = 'SCOPE COHERENCE CHECK\n\n' +
      'You\'ve been deep in implementation for ' + depth + ' actions without reading design documents.\n' +
      'Implementation depth narrows perception.\n' +
      jobContext +
      '\nStep back and ask yourself:\n' +
      '\n1. WHO AM I? What role am I filling right now?\n' +
      '2. WHAT AM I WORKING ON? What\'s the full scope? Is there a spec or proposal?\n' +
      '3. BIG PICTURE — How does this fit into the larger system?\n' +
      '4. HIGHER-LEVEL ELEMENTS — What architectural or cross-system aspects am I missing?\n' +
      '5. COMPLETENESS — Am I considering all elements, or have I collapsed the scope?\n' +
      docsContext + escalation +
      '\n\nOptions: Read the relevant spec/proposal, confirm scope awareness, or /grounding';

    // Record that we prompted
    state.lastCheckpointPrompt = new Date().toISOString();
    state.checkpointsDismissed = dismissed + 1;
    saveState(state);

    process.stdout.write(JSON.stringify({ decision: 'block', reason: reason }));
  } catch {
    // On any error, allow (empty stdout) — never emit approve-JSON (codex-unsafe).
  }
  process.exit(0);
})();

