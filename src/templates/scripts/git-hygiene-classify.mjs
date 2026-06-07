#!/usr/bin/env node
// safe-git-allow: shipped runtime script template cannot import TS SafeGitExecutor
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = execGit(['rev-parse', '--show-toplevel']).trim();
const now = new Date().toISOString();

const CATEGORY_ORDER = [
  'source',
  'identity',
  'runtime',
  'generated',
  'sensitive',
  'unknown',
];

const RULES = [
  {
    category: 'generated',
    reason: 'generated install, dependency, binary, cache, or local build artifact',
    patterns: [
      /^\.instar\/shadow-install\//,
      /^\.instar\/bin\//,
      /^\.instar\/playbook\/\.venv\//,
      /(^|\/)node_modules\//,
      /(^|\/)\.cache\//,
      /\.(node|so|dylib|dll)$/,
    ],
  },
  {
    category: 'identity',
    reason: 'portable agent identity, memory, or collaborator-facing agent docs',
    patterns: [
      /^\.instar\/AGENT\.md$/,
      /^\.instar\/MEMORY\.md$/,
      /^\.instar\/USER\.md$/,
      /^AGENTS\.md$/,
      /^CLAUDE\.md$/,
      /^MEMORY\.md$/,
    ],
  },
  {
    category: 'source',
    reason: 'source, spec, hook, job, template, or repo policy file',
    patterns: [
      /^\.gitignore$/,
      /^\.codex\//,
      /^\.claude\//,
      /^\.instar\/context\//,
      /^\.instar\/coordination\//,
      /^\.instar\/hooks\//,
      /^\.instar\/instar-boot\.(cjs|sh)$/,
      /^\.instar\/jobs(\.json)?/,
      /^\.instar\/scripts\//,
      /^docs\//,
      /^playbook-scripts\//,
      /^project-map-report\.json$/,
      /^scripts\//,
      /^skills\//,
      /^specs\//,
      /^src\//,
      /^tests\//,
      /^upgrades\//,
    ],
  },
  {
    category: 'sensitive',
    reason: 'secret, token, key, credential, tunnel, or local auth material',
    patterns: [
      /^\.instar\/agent-tokens\//,
      /^\.instar\/keys\/(?!.*-pub\.pem$)/,
      /^\.instar\/machine\//,
      /^\.instar\/secrets\//,
      /^\.instar\/pairing\//,
      /^\.instar\/cloudflared-/,
      /^\.instar\/config\.json($|[.\-])/,
      /^\.instar\/server-data\/token-ledger\.db/,
      /^\.claude\.json$/,
      /^\.mcp\.json$/,
      /(^|\/)\.env($|\.)/,
      /(token|secret|credential|password|private[-_]?key|auth)/i,
    ],
  },
  {
    category: 'runtime',
    reason: 'local runtime state, ledger, message, session, database, or transient report',
    patterns: [
      /^\.instar\/a2a-/,
      /^\.instar\/audit\//,
      /^\.instar\/autonomous\//,
      /^\.instar\/backups\//,
      /^\.instar\/decision-journal\.jsonl$/,
      /^\.instar\/degradations\.json$/,
      /^\.instar\/discovery\.db/,
      /^\.instar\/episodes\//,
      /^\.instar\/feedback\.json$/,
      /^\.instar\/hook-events\//,
      /^\.instar\/last-self-restart-at\.json$/,
      /^\.instar\/lease-local\.json$/,
      /^\.instar\/ledger\//,
      /^\.instar\/lifeline/,
      /^\.instar\/machine-health\//,
      /^\.instar\/machines\/registry\.json$/,
      /^\.instar\/messages\//,
      /^\.instar\/project-map\.(json|md)$/,
      /^\.instar\/projects-digest\.cache$/,
      /^\.instar\/publishing\.json$/,
      /^\.instar\/recovery-/,
      /^\.instar\/reports\//,
      /^\.instar\/review-history\.jsonl$/,
      /^\.instar\/security\.jsonl$/,
      /^\.instar\/semantic(\.db|\.jsonl|-snapshot\.json)/,
      /^\.instar\/server-data\//,
      /^\.instar\/shared-state\.jsonl/,
      /^\.instar\/stuck-input-events\.jsonl$/,
      /^\.instar\/telegram-/,
      /^\.instar\/threadline\//,
      /^\.instar\/topic-/,
      /^\.instar\/tunnel\.json$/,
      /^\.instar\/usher\//,
      /^\.instar\/views\//,
      /^\.instar\/watchdog-interventions\.jsonl$/,
      /^logs\//,
      /\.(db|db-shm|db-wal|sqlite|sqlite3|lock|pid)$/,
    ],
  },
];

function execGit(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function parseStatus() {
  const raw = execGit(['status', '--porcelain=v1', '-z']);
  if (!raw) return [];
  const parts = raw.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    let file = entry.slice(3);
    let oldPath = null;
    if (code.includes('R') || code.includes('C')) {
      oldPath = parts[i + 1] || null;
      i += 1;
    }
    entries.push({
      code,
      path: normalizePath(file),
      oldPath: oldPath ? normalizePath(oldPath) : null,
      tracked: code !== '??',
    });
  }
  return entries;
}

function normalizePath(file) {
  return file.replaceAll(path.sep, '/');
}

function classify(file) {
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(file))) {
      return { category: rule.category, reason: rule.reason };
    }
  }
  return { category: 'unknown', reason: 'no classifier rule matched' };
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function topDir(file) {
  const parts = file.split('/');
  if (parts[0] === '.instar' && parts.length > 1) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function remoteSummary() {
  let branch = '';
  let upstream = '';
  let remote = '';
  let head = '';
  try {
    branch = execGit(['branch', '--show-current']).trim();
  } catch {}
  try {
    upstream = execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
  } catch {
    upstream = '(none)';
  }
  try {
    remote = execGit(['config', '--get', 'remote.origin.url']).trim();
  } catch {
    remote = '(none)';
  }
  try {
    head = execGit(['rev-parse', '--short', 'HEAD']).trim();
  } catch {
    head = '(unknown)';
  }
  return { branch, upstream, remote, head };
}

function trackedSensitiveFiles() {
  const raw = execGit(['ls-files']);
  return raw
    .split('\n')
    .filter(Boolean)
    .map(normalizePath)
    .map((file) => ({ file, ...classify(file) }))
    .filter((item) => item.category === 'sensitive');
}

function renderMarkdown(classified) {
  const remote = remoteSummary();
  const lines = [];
  lines.push('# Git Hygiene Classification Report');
  lines.push('');
  lines.push(`Generated: ${now}`);
  lines.push(`Repository: ${ROOT}`);
  lines.push(`Branch: ${remote.branch || '(unknown)'}`);
  lines.push(`Head: ${remote.head}`);
  lines.push(`Upstream: ${remote.upstream}`);
  lines.push(`Remote: ${remote.remote}`);
  lines.push('');
  lines.push('## Working Tree Summary');
  lines.push('');
  lines.push(`Dirty/untracked paths: ${classified.length}`);
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('| --- | ---: |');
  for (const category of CATEGORY_ORDER) {
    lines.push(`| ${category} | ${classified.filter((item) => item.category === category).length} |`);
  }
  lines.push('');
  lines.push('## Tracked vs Untracked');
  lines.push('');
  lines.push('| State | Count |');
  lines.push('| --- | ---: |');
  for (const [state, count] of countBy(classified, (item) => (item.tracked ? 'tracked' : 'untracked'))) {
    lines.push(`| ${state} | ${count} |`);
  }
  lines.push('');
  lines.push('## Top Dirty Areas');
  lines.push('');
  lines.push('| Area | Count |');
  lines.push('| --- | ---: |');
  for (const [area, count] of countBy(classified, (item) => topDir(item.path)).slice(0, 30)) {
    lines.push(`| ${area} | ${count} |`);
  }
  lines.push('');

  const sensitiveTracked = trackedSensitiveFiles();
  lines.push('## Sensitive Tracked Paths');
  lines.push('');
  if (sensitiveTracked.length === 0) {
    lines.push('No tracked paths matched the sensitive classifier.');
  } else {
    lines.push(`Tracked sensitive-class paths: ${sensitiveTracked.length}`);
    lines.push('');
    for (const item of sensitiveTracked.slice(0, 80)) {
      lines.push(`- ${item.file}`);
    }
    if (sensitiveTracked.length > 80) {
      lines.push(`- ... ${sensitiveTracked.length - 80} more`);
    }
  }
  lines.push('');

  for (const category of CATEGORY_ORDER) {
    const items = classified.filter((item) => item.category === category);
    lines.push(`## ${category[0].toUpperCase()}${category.slice(1)}`);
    lines.push('');
    if (items.length === 0) {
      lines.push('No paths.');
      lines.push('');
      continue;
    }
    lines.push('| Code | Tracked | Path | Reason |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of items.slice(0, 120)) {
      lines.push(`| ${item.code.trim() || 'modified'} | ${item.tracked ? 'yes' : 'no'} | ${item.path} | ${item.reason} |`);
    }
    if (items.length > 120) {
      lines.push(`| ... | ... | ${items.length - 120} more paths omitted | ... |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderJson(classified) {
  const remote = remoteSummary();
  const categories = Object.fromEntries(CATEGORY_ORDER.map((category) => [
    category,
    classified.filter((item) => item.category === category).length,
  ]));
  const trackedStates = Object.fromEntries(countBy(classified, (item) => (item.tracked ? 'tracked' : 'untracked')));
  const topAreas = Object.fromEntries(countBy(classified, (item) => topDir(item.path)).slice(0, 30));
  const sensitiveTracked = trackedSensitiveFiles();
  return {
    generatedAt: now,
    repository: ROOT,
    branch: remote.branch || null,
    head: remote.head,
    upstream: remote.upstream,
    remote: remote.remote,
    dirtyPathCount: classified.length,
    categories,
    trackedStates,
    topAreas,
    sensitiveTracked,
    paths: classified,
  };
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null;
  const json = process.argv.includes('--json');
  const status = parseStatus();
  const classified = status.map((item) => ({ ...item, ...classify(item.path) }));
  const output = json
    ? `${JSON.stringify(renderJson(classified), null, 2)}\n`
    : `${renderMarkdown(classified)}\n`;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output);
    console.log(outPath);
  } else {
    process.stdout.write(output);
  }
}

main();
