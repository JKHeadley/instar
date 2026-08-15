#!/usr/bin/env node
// Zero-cost OpenRouter credits probe. Key custody preserved: fetched from the
// vault in-process, used for one GET, never printed. Prints balance JSON only.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const AGENT_HOME = '/Users/justin/.instar/agents/echo';
const key = execFileSync('node', [path.join(AGENT_HOME, '.instar', 'scripts', 'secret-get.mjs'), 'metered_openrouter_bench'],
  { encoding: 'utf8', cwd: AGENT_HOME }).trim();
if (!key) { console.error('vault returned empty'); process.exit(4); }

const res = await fetch('https://openrouter.ai/api/v1/credits', {
  headers: { Authorization: `Bearer ${key}` },
});
const body = await res.json();
const d = body.data ?? body;
const total = d.total_credits, used = d.total_usage;
console.log(JSON.stringify({
  httpStatus: res.status,
  totalCredits: total,
  totalUsage: used,
  remaining: (typeof total === 'number' && typeof used === 'number') ? +(total - used).toFixed(4) : null,
}));
