#!/usr/bin/env node
// safe-git-allow: read-only base-ref diff inspection for pull-request lint
/** L1 UX-impact declaration lint. Exit 0=pass/out-of-scope, 1=violation, 2=internal error. */
import { execFileSync } from 'node:child_process';

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; }
const base = arg('--base');
const head = arg('--head') || 'HEAD';
const body = arg('--body') || '';
if (process.env.INSTAR_UX_LINT === 'off') { console.log('UX lint disabled by literal kill switch'); process.exit(0); }
if (!base) { console.error('::error::UX lint requires a base ref'); process.exit(2); }
try {
  const names = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const allowlisted = names.filter((p) => p === 'src/server/routes.ts' || p === 'src/commands/server.ts' || p.startsWith('src/messaging/') || p.startsWith('src/dashboard/') || p.startsWith('src/templates/'));
  if (allowlisted.length === 0) { console.log('UX lint: out of scope'); process.exit(0); }
  const section = body.match(/^## UX Impact\s*\n([\s\S]*?)(?=^##\s|$)/im)?.[1]?.trim() || '';
  if (!section) { console.error('::error::UX Impact section is required for user-facing paths'); process.exit(1); }
  if (/UX-Impact:\s*none/i.test(section)) { console.error('::error::UX-Impact: none is not allowed for allowlisted paths'); process.exit(1); }
  if (!/who\s+sees|what\s+(?:the\s+)?user|first[- ]contact|user[- ]visible/i.test(section)) {
    console.error('::error::UX Impact must describe audience, visible behavior, and first contact'); process.exit(1);
  }
  const diff = execFileSync('git', ['diff', '--unified=0', `${base}...${head}`, '--', ...allowlisted], { encoding: 'utf8' });
  const quoted = [...section.matchAll(/[`"“]([^`"”]+)[`"”]/g)].map((m) => m[1]);
  if (!quoted.some((q) => q.length > 2 && diff.includes(q))) {
    console.error('::error::UX Impact must quote a concrete string from the diff'); process.exit(1);
  }
  console.log(`UX lint PASS: ${allowlisted.length} allowlisted path(s)`);
  process.exit(0);
} catch (error) {
  console.error(`::error::UX lint internal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
