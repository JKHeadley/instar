#!/usr/bin/env node
// safe-git-allow: read-only base-ref diff inspection for pull-request lint
/** L1 UX-impact declaration lint. Exit 0=pass/out-of-scope, 1=violation, 2=internal error. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; }
const base = arg('--base');
const head = arg('--head') || 'HEAD';
const body = arg('--body') || '';
const scope = (arg('--scope') || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
const pusher = (arg('--pusher') || '').trim().toLowerCase();
const reportPath = arg('--report');
if (process.env.INSTAR_UX_LINT === 'off') { console.log('UX lint disabled by literal kill switch'); process.exit(0); }
if (!base) { console.error('::error::UX lint requires a base ref'); process.exit(2); }
try {
  const names = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const commits = execFileSync('git', ['log', '--format=%an <%ae>%n%cn <%ce>', `${base}..${head}`], { encoding: 'utf8' }).toLowerCase();
  const authorInScope = scope.length === 0
    || (Boolean(pusher) && scope.includes(pusher))
    || scope.some((token) => commits.includes(token));
  const report = { version: 1, base, head, authorInScope, scope, allowlistedPaths: [], exempt: false, internalError: false };
  const writeReport = () => { if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); };
  if (!authorInScope) { report.outOfScopeAuthor = true; await writeReport(); console.log('UX lint: out-of-scope author'); process.exit(0); }
  const allowlisted = names.filter((p) => p === 'src/server/routes.ts' || p === 'src/commands/server.ts' || p.startsWith('src/messaging/') || p.startsWith('src/dashboard/') || p.startsWith('src/templates/'));
  report.allowlistedPaths = allowlisted;
  if (allowlisted.length === 0) { await writeReport(); console.log('UX lint: out of scope'); process.exit(0); }
  const diff = execFileSync('git', ['diff', '--unified=0', `${base}...${head}`, '--', ...allowlisted], { encoding: 'utf8' });
  const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  const refactorOnly = !allowlisted.some((p) => p.startsWith('src/templates/') || p === 'src/server/routes.ts' || p === 'src/commands/server.ts')
    && !/(?:^|\s)[`'\"](?:[^`'\"]+)[`'\"]/.test(added);
  const section = body.match(/^## UX Impact\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im)?.[1]?.trim() || '';
  if (/UX-Impact:\s*refactor-only/i.test(section) && refactorOnly) { report.exempt = true; report.exemption = 'refactor-only'; await writeReport(); console.log('UX lint PASS: deterministic refactor-only exemption'); process.exit(0); }
  if (!section) { console.error('::error::UX Impact section is required for user-facing paths'); process.exit(1); }
  if (/UX-Impact:\s*none/i.test(section)) { console.error('::error::UX-Impact: none is not allowed for allowlisted paths'); process.exit(1); }
  if (!/who\s+sees|what\s+(?:the\s+)?user|first[- ]contact|user[- ]visible/i.test(section)) {
    console.error('::error::UX Impact must describe audience, visible behavior, and first contact'); process.exit(1);
  }
  const quoted = [...section.matchAll(/[`'"“]([^`'"”]+)[`'"”]/g)].map((m) => m[1]);
  if (!quoted.some((q) => q.length > 2 && diff.includes(q))) {
    console.error('::error::UX Impact must quote a concrete string from the diff'); process.exit(1);
  }
  await writeReport();
  console.log(`UX lint PASS: ${allowlisted.length} allowlisted path(s)`);
  process.exit(0);
} catch (error) {
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify({ version: 1, internalError: true, message: error instanceof Error ? error.message : String(error) })}\n`);
  console.error(`::error::UX lint internal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
