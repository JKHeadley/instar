#!/usr/bin/env node
// safe-git-allow: shipped runtime script template cannot import TS SafeGitExecutor
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = execGit(['rev-parse', '--show-toplevel']).trim();
const now = new Date().toISOString();
const apply = process.argv.includes('--apply');
const noFail = process.argv.includes('--no-fail');
const outDir = flagValue('--out-dir') || '.instar/state';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function execGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: options.encoding || 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', options.stderr || 'ignore'],
  });
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function normalize(file) {
  return file.replaceAll(path.sep, '/');
}

function trackedIgnoredFiles() {
  const raw = execGit(['ls-files', '-z', '--ignored', '--exclude-standard', '-c']);
  return raw.split('\0').filter(Boolean).map(normalize).sort();
}

function classifierReport() {
  const classifierPath = fs.existsSync(path.join(scriptDir, 'git-hygiene-classify.mjs'))
    ? path.join(scriptDir, 'git-hygiene-classify.mjs')
    : path.join(root, 'scripts', 'git-hygiene-classify.mjs');
  const raw = execFileSync(process.execPath, [classifierPath, '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(raw);
}

function checkIgnore(file) {
  try {
    execGit(['check-ignore', '-q', '--', file]);
    return true;
  } catch {
    return false;
  }
}

function markdown(report, trackedIgnored, unignoredLocalOnly, applied) {
  const lines = [];
  lines.push('# Git Maintenance Report');
  lines.push('');
  lines.push(`Generated: ${now}`);
  lines.push(`Repository: ${root}`);
  lines.push(`Branch: ${report.branch || '(unknown)'}`);
  lines.push(`Head: ${report.head}`);
  lines.push(`Mode: ${apply ? 'apply' : 'audit'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Dirty/untracked paths: ${report.dirtyPathCount}`);
  lines.push(`- Tracked files matching ignore rules: ${trackedIgnored.length}`);
  lines.push(`- Unignored local-only dirty paths: ${unignoredLocalOnly.length}`);
  lines.push(`- Tracked sensitive-class paths: ${report.sensitiveTracked.length}`);
  lines.push(`- Files untracked from git index this run: ${applied.length}`);
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('| --- | ---: |');
  for (const [category, count] of Object.entries(report.categories)) {
    lines.push(`| ${category} | ${count} |`);
  }
  lines.push('');

  section(lines, 'Tracked Ignored Files', trackedIgnored);
  section(lines, 'Unignored Local-Only Dirty Paths', unignoredLocalOnly.map((item) => `${item.path} (${item.category})`));
  section(lines, 'Tracked Sensitive-Class Paths', report.sensitiveTracked.map((item) => item.file));
  section(lines, 'Applied Index Repairs', applied);

  lines.push('## Recommended Action');
  lines.push('');
  if (trackedIgnored.length === 0 && unignoredLocalOnly.length === 0 && report.sensitiveTracked.length === 0) {
    lines.push('No git hygiene action required.');
  } else {
    if (trackedIgnored.length > 0 && !apply) {
      lines.push('- Run this script with `--apply` to remove tracked ignored files from the git index while leaving the files on disk.');
    }
    if (unignoredLocalOnly.length > 0) {
      lines.push('- Add ignore rules or intentionally commit the listed local-only paths after review.');
    }
    if (report.sensitiveTracked.length > 0) {
      lines.push('- Review tracked sensitive-class paths before any push.');
    }
  }
  lines.push('');
  return lines.join('\n');
}

function section(lines, title, items) {
  lines.push(`## ${title}`);
  lines.push('');
  if (items.length === 0) {
    lines.push('None.');
    lines.push('');
    return;
  }
  for (const item of items.slice(0, 120)) lines.push(`- ${item}`);
  if (items.length > 120) lines.push(`- ... ${items.length - 120} more`);
  lines.push('');
}

function main() {
  const report = classifierReport();
  let trackedIgnored = trackedIgnoredFiles();
  const localOnly = new Set(['runtime', 'generated', 'sensitive']);
  const unignoredLocalOnly = report.paths.filter((item) => (
    !item.tracked && localOnly.has(item.category) && !checkIgnore(item.path)
  ));

  const applied = [];
  if (apply && trackedIgnored.length > 0) {
    for (const file of trackedIgnored) {
      runGit(['rm', '--cached', '--quiet', '--', file]);
      applied.push(file);
    }
    trackedIgnored = trackedIgnoredFiles();
  }

  const output = {
    generatedAt: now,
    mode: apply ? 'apply' : 'audit',
    repository: root,
    branch: report.branch || null,
    head: report.head,
    dirtyPathCount: report.dirtyPathCount,
    categories: report.categories,
    trackedIgnored,
    unignoredLocalOnly,
    sensitiveTracked: report.sensitiveTracked,
    applied,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'git-maintenance-report.json');
  const mdPath = path.join(outDir, 'git-maintenance-report.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  fs.writeFileSync(mdPath, `${markdown(report, trackedIgnored, unignoredLocalOnly, applied)}\n`);

  const issueCount = trackedIgnored.length + unignoredLocalOnly.length + report.sensitiveTracked.length;
  console.log(`Git maintenance: ${issueCount} issue(s). Report: ${mdPath}`);
  if (applied.length > 0) console.log(`Git maintenance: untracked ${applied.length} ignored file(s) from the git index.`);
  if (issueCount > 0 && !noFail) process.exit(2);
}

main();
