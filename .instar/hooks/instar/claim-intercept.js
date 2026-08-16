#!/usr/bin/env node
// Claim Intercept — PostToolUse hook for catching false operational claims.
//
// The Proprioceptive Stack for Instar agents.
// Agents sometimes falsely deny capabilities they actually have.
// This hook cross-checks denial claims against Canonical State
// (quick-facts.json, project-registry.json) and injects corrections.
//
// Architecture: Two-layer detection
//   Layer 1: Regex fast-path (<1ms) — catches explicit denial patterns
//   Layer 2: Canonical State cross-check — verifies claims against ground truth
//
// Design principles:
//   - Never blocks — injects warnings via additionalContext
//   - Reads canonical state files directly (no server dependency)
//   - Only checks topically relevant output (skip pure code, grep, cat)
//   - Rate-limited to prevent latency stacking

const _r = require;
const fs = _r('fs');
const path = _r('path');

const STATE_DIR = path.join('.instar', 'state');
const RATE_FILE = path.join(STATE_DIR, '.claim-intercept-last.tmp');
const RATE_LIMIT_MS = 10000; // 10 seconds between checks
const LOG_FILE = path.join(STATE_DIR, 'claim-intercept.log');

// ── Denial pattern templates ───────────────────────────────────
// These catch explicit claims of inability or missing capability.

const DENIAL_PATTERNS = [
  /(?:I |i )(?:can'?t|cannot|am (?:not |un)able to)\s+(.{5,80})/i,
  /(?:don'?t|do not) have (?:access|credentials|a?n? ?(?:api|token|key|tool|script|capability))\s*(?:for|to)?\s*(.{3,60})?/i,
  /(?:no |not )(?:available|configured|set up|installed|deployed|running|accessible)\b/i,
  /(?:isn'?t|is not|aren'?t|are not) (?:available|configured|set up|working|running|accessible)\b/i,
  /(?:blocked|unavailable|disabled|suspended|broken|offline|unreachable)\b/i,
  /(?:need|require)s? (?:the user|human|manual|someone) to/i,
  /(?:outside|beyond) (?:my|the agent'?s?) (?:capabilities|scope|access|authority)/i,
  /(?:no |don'?t have (?:a |any )?)(?:way|mechanism|method|means) to/i,
  /(?:not |never )(?:been )?(?:set up|configured|registered|deployed)/i,
];

// ── Topic relevance filter ─────────────────────────────────────
// Skip pure code output, file reads, grep results.

const EXEMPT_PATTERNS = [
  /^\s*\d+[:\|]/m,                   // Line-numbered output (cat -n, grep -n)
  /^diff --git/m,                     // Git diffs
  /^\+\+\+|^---/m,                    // Diff headers
  /^commit [a-f0-9]{40}/m,            // Git log
  /node_modules\//,                   // Node modules paths
  /\.test\.[jt]s/,                    // Test file output
];

function isExempt(text) {
  return EXEMPT_PATTERNS.some(p => p.test(text));
}

// ── Rate limiter ───────────────────────────────────────────────

function checkRateLimit() {
  try {
    if (fs.existsSync(RATE_FILE)) {
      const mtime = fs.statSync(RATE_FILE).mtimeMs;
      if (Date.now() - mtime < RATE_LIMIT_MS) return false;
    }
    fs.mkdirSync(path.dirname(RATE_FILE), { recursive: true });
    fs.writeFileSync(RATE_FILE, '');
    return true;
  } catch { return true; }
}

// ── Canonical State loader ─────────────────────────────────────

function loadCanonicalState() {
  const state = { facts: [], projects: [], antiPatterns: [] };
  try {
    const factsPath = path.join(STATE_DIR, 'quick-facts.json');
    if (fs.existsSync(factsPath)) {
      state.facts = JSON.parse(fs.readFileSync(factsPath, 'utf-8'));
    }
  } catch {}
  try {
    const projPath = path.join(STATE_DIR, 'project-registry.json');
    if (fs.existsSync(projPath)) {
      state.projects = JSON.parse(fs.readFileSync(projPath, 'utf-8'));
    }
  } catch {}
  try {
    const apPath = path.join(STATE_DIR, 'anti-patterns.json');
    if (fs.existsSync(apPath)) {
      state.antiPatterns = JSON.parse(fs.readFileSync(apPath, 'utf-8'));
    }
  } catch {}
  return state;
}

// ── Cross-check claims against canonical state ─────────────────

function findContradictions(text, state) {
  const contradictions = [];
  const textLower = text.toLowerCase();

  // Check if any denied capability contradicts a quick fact
  for (const fact of state.facts) {
    const answerWords = fact.answer.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const questionWords = fact.question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const allWords = [...answerWords, ...questionWords];

    // If the denial text mentions something related to a known fact
    for (const word of allWords) {
      if (textLower.includes(word)) {
        // Check if the text contains a denial near this word
        const wordIdx = textLower.indexOf(word);
        const context = textLower.substring(Math.max(0, wordIdx - 100), Math.min(textLower.length, wordIdx + 100));
        if (DENIAL_PATTERNS.some(p => p.test(context))) {
          contradictions.push({
            claim: 'Denied capability related to: ' + word,
            fact: fact.question + ' → ' + fact.answer,
            source: 'quick-facts.json (verified: ' + (fact.lastVerified || 'unknown') + ')',
          });
          break; // One contradiction per fact is enough
        }
      }
    }
  }

  // Check if denial mentions a registered project
  for (const proj of state.projects) {
    const projName = proj.name.toLowerCase();
    if (textLower.includes(projName)) {
      const nameIdx = textLower.indexOf(projName);
      const context = textLower.substring(Math.max(0, nameIdx - 100), Math.min(textLower.length, nameIdx + 100));
      if (DENIAL_PATTERNS.some(p => p.test(context))) {
        contradictions.push({
          claim: 'Denied access/capability for project: ' + proj.name,
          fact: proj.name + ' is registered at ' + proj.dir + (proj.deploymentTargets ? ' (deploys to: ' + proj.deploymentTargets.join(', ') + ')' : ''),
          source: 'project-registry.json',
        });
      }
    }
  }

  return contradictions;
}

// ── Main ───────────────────────────────────────────────────────

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';

    // Only check Bash, Write, Edit output
    if (!['Bash', 'Write', 'Edit'].includes(toolName)) process.exit(0);

    // Extract text content
    let text = '';
    if (toolName === 'Bash') {
      text = (input.tool_input || {}).command || '';
      // Also check stdout if available
      const result = input.tool_result || '';
      if (typeof result === 'string') text += ' ' + result;
    } else if (toolName === 'Write') {
      text = (input.tool_input || {}).content || '';
    } else if (toolName === 'Edit') {
      text = (input.tool_input || {}).new_string || '';
    }

    if (!text || text.length < 40) process.exit(0);
    if (isExempt(text)) process.exit(0);

    // Quick scan: does the text even contain a denial pattern?
    const hasDenial = DENIAL_PATTERNS.some(p => p.test(text));
    if (!hasDenial) process.exit(0);

    // Rate limit before loading canonical state
    if (!checkRateLimit()) process.exit(0);

    // Cross-check against canonical state
    const state = loadCanonicalState();
    if (state.facts.length === 0 && state.projects.length === 0) process.exit(0);

    const contradictions = findContradictions(text, state);
    if (contradictions.length === 0) process.exit(0);

    // Build warning message
    const details = contradictions.map(c =>
      '  CLAIM: ' + c.claim + '\n' +
      '  FACT:  ' + c.fact + '\n' +
      '  FROM:  ' + c.source
    ).join('\n\n');

    const warning = 'CLAIM-INTERCEPT: CONTRADICTION DETECTED\n\n' +
      'Your output contains claims that contradict canonical state:\n\n' +
      details + '\n\n' +
      'Do NOT repeat false claims. Revise your statement to match operational reality.\n' +
      'Canonical state is compiled from verified registries. If you believe it is wrong,\n' +
      'verify with: GET /state/quick-facts or check .instar/state/ files directly.';

    // Log the interception
    try {
      const logEntry = '[' + new Date().toISOString() + '] ' +
        'tool=' + toolName + ' | ' +
        'contradictions=' + contradictions.length + ' | ' +
        'claims=' + contradictions.map(c => c.claim.substring(0, 50)).join('; ') + '\n';
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, logEntry);
    } catch {}

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: warning }));
  } catch {}
  process.exit(0);
});
