#!/usr/bin/env node
// Claim Intercept — Stop hook for catching false claims in direct responses.
//
// Complements the PostToolUse claim-intercept hook by checking the agent's
// direct text responses (the words between tool calls). This closes the gap
// where tool output is checked but conversational text goes unchecked.
//
// Architecture:
//   Stop hook — fires when the agent finishes a response turn.
//   Receives last_assistant_message from stdin.
//   Cross-checks against Canonical State.
//   If contradiction found: BLOCKS the stop (exit 2) to force correction.
//
// Guard against infinite loops:
//   If stop_hook_active is true, we're in a correction continuation — skip.

const _r = require;
const fs = _r('fs');
const path = _r('path');

const STATE_DIR = path.join('.instar', 'state');
const RATE_FILE = path.join(STATE_DIR, '.claim-intercept-last.tmp');
const RATE_LIMIT_MS = 10000;
const LOG_FILE = path.join(STATE_DIR, 'claim-intercept.log');

// Same denial patterns as PostToolUse hook
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

function loadCanonicalState() {
  const state = { facts: [], projects: [] };
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
  return state;
}

function findContradictions(text, state) {
  const contradictions = [];
  const textLower = text.toLowerCase();

  for (const fact of state.facts) {
    const answerWords = fact.answer.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const questionWords = fact.question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const allWords = [...answerWords, ...questionWords];

    for (const word of allWords) {
      if (textLower.includes(word)) {
        const wordIdx = textLower.indexOf(word);
        const context = textLower.substring(Math.max(0, wordIdx - 100), Math.min(textLower.length, wordIdx + 100));
        if (DENIAL_PATTERNS.some(p => p.test(context))) {
          contradictions.push({
            claim: 'Denied capability related to: ' + word,
            fact: fact.question + ' → ' + fact.answer,
            source: 'quick-facts.json',
          });
          break;
        }
      }
    }
  }

  for (const proj of state.projects) {
    const projName = proj.name.toLowerCase();
    if (textLower.includes(projName)) {
      const nameIdx = textLower.indexOf(projName);
      const context = textLower.substring(Math.max(0, nameIdx - 100), Math.min(textLower.length, nameIdx + 100));
      if (DENIAL_PATTERNS.some(p => p.test(context))) {
        contradictions.push({
          claim: 'Denied access/capability for project: ' + proj.name,
          fact: proj.name + ' is registered at ' + proj.dir,
          source: 'project-registry.json',
        });
      }
    }
  }

  return contradictions;
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);

    // Guard: if we're already in a Stop hook continuation, skip
    if (input.stop_hook_active) process.exit(0);

    const message = input.last_assistant_message || '';
    if (!message || message.length < 80) process.exit(0);

    // Quick scan for denial patterns
    const hasDenial = DENIAL_PATTERNS.some(p => p.test(message));
    if (!hasDenial) process.exit(0);

    // Rate limit
    if (!checkRateLimit()) process.exit(0);

    // Cross-check against canonical state
    const state = loadCanonicalState();
    if (state.facts.length === 0 && state.projects.length === 0) process.exit(0);

    const contradictions = findContradictions(message, state);
    if (contradictions.length === 0) process.exit(0);

    // Build correction prompt
    const details = contradictions.map(c =>
      '  CLAIM: ' + c.claim + '\n' +
      '  FACT:  ' + c.fact + '\n' +
      '  FROM:  ' + c.source
    ).join('\n\n');

    const reason = 'CLAIM-INTERCEPT (Response-Level): FALSE CLAIM DETECTED\n\n' +
      'Your last response contained claims that contradict canonical state:\n\n' +
      details + '\n\n' +
      'You MUST correct this. Issue a brief correction acknowledging the error.\n' +
      'Do NOT repeat the false claim. State what is actually true.\n' +
      'Canonical state: .instar/state/quick-facts.json, project-registry.json';

    // Log the interception
    try {
      const logEntry = '[' + new Date().toISOString() + '] ' +
        'RESPONSE-LEVEL | contradictions=' + contradictions.length + ' | ' +
        'claims=' + contradictions.map(c => c.claim.substring(0, 50)).join('; ') + '\n';
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, logEntry);
    } catch {}

    // BLOCK the stop — force the agent to correct itself
    process.stdout.write(JSON.stringify({ decision: 'block', reason: reason }));
    process.exit(2);
  } catch {}
  process.exit(0);
});
