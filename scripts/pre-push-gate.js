#!/usr/bin/env node
/**
 * Fast pre-push gate — runs BEFORE the test suite to catch common issues early.
 *
 * Checks:
 *   1. NEXT.md exists and has required sections (saves ~4min if missing)
 *   2. package.json version was incremented from the latest published guide
 *
 * This is intentionally lightweight — no imports from src/, no TypeScript,
 * no test framework. Just reads files and exits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const upgradesDir = path.join(ROOT, 'upgrades');
const nextPath = path.join(ROOT, 'upgrades', 'NEXT.md');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version;

const REQUIRED_SECTIONS = [
  '## What Changed',
  '## What to Tell Your User',
  '## Summary of New Capabilities',
];

const MIN_LENGTH = 200;

let errors = [];
let warnings = [];

// ── 1. NEXT.md validation ─────────────────────────────────────────────

const versionedGuidePath = path.join(upgradesDir, `${version}.md`);
const versionedGuideExists = fs.existsSync(versionedGuidePath);
const nextExists = fs.existsSync(nextPath);

if (versionedGuideExists) {
  // Already finalized — validate the versioned guide instead
  const content = fs.readFileSync(versionedGuidePath, 'utf-8');
  for (const section of REQUIRED_SECTIONS) {
    if (!content.includes(section)) {
      errors.push(`${version}.md missing "${section}" section`);
    }
  }
  if (content.length < MIN_LENGTH) {
    errors.push(`${version}.md is too short (${content.length} chars, need ${MIN_LENGTH}+)`);
  }
} else if (nextExists) {
  const content = fs.readFileSync(nextPath, 'utf-8');

  for (const section of REQUIRED_SECTIONS) {
    if (!content.includes(section)) {
      errors.push(`NEXT.md missing "${section}" section`);
    }
  }

  if (content.length < MIN_LENGTH) {
    errors.push(`NEXT.md is too short (${content.length} chars, need ${MIN_LENGTH}+)`);
  }

  // Check for unfilled template placeholders
  if (content.includes('<!-- Describe what changed')) {
    errors.push(`NEXT.md "What Changed" still has template placeholder`);
  }
  if (content.includes('[Feature name]') || content.includes('[Brief, friendly description')) {
    errors.push(`NEXT.md "What to Tell Your User" still has template placeholder`);
  }
  if (content.includes('[Capability]') && content.includes('[Endpoint, command')) {
    errors.push(`NEXT.md "Summary of New Capabilities" still has template placeholder`);
  }
} else {
  errors.push(
    `No upgrade guide found. Create upgrades/NEXT.md with sections: ${REQUIRED_SECTIONS.join(', ')}`
  );
}

// ── 2. Version increment check ────────────────────────────────────────

// Find the latest published version from existing upgrade guides
const publishedVersions = fs.existsSync(upgradesDir)
  ? fs.readdirSync(upgradesDir)
      .map(f => /^(\d+)\.(\d+)\.(\d+)\.md$/.exec(f))
      .filter(Boolean)
      .map(m => ({
        str: `${m[1]}.${m[2]}.${m[3]}`,
        parts: [+m[1], +m[2], +m[3]],
      }))
      .sort((a, b) => {
        for (let i = 0; i < 3; i++) {
          if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
        }
        return 0;
      })
  : [];

const latestPublished = publishedVersions.length > 0
  ? publishedVersions[publishedVersions.length - 1]
  : null;

if (latestPublished) {
  const [curMaj, curMin, curPatch] = version.split('.').map(Number);
  const [pubMaj, pubMin, pubPatch] = latestPublished.parts;

  if (curMaj === pubMaj && curMin === pubMin && curPatch === pubPatch) {
    warnings.push(
      `package.json version (${version}) matches the latest published guide (${latestPublished.str}). ` +
      `Did you forget to bump the version? Run: npm version patch|minor|major`
    );
  } else if (
    curMaj < pubMaj ||
    (curMaj === pubMaj && curMin < pubMin) ||
    (curMaj === pubMaj && curMin === pubMin && curPatch < pubPatch)
  ) {
    errors.push(
      `package.json version (${version}) is LOWER than the latest published guide (${latestPublished.str}). ` +
      `Version must be incremented, not decremented.`
    );
  }
}

// ── 3. Test file change check ─────────────────────────────────────────
// If source files changed, at least one test file should also change.
// This prevents shipping code changes without regression tests.

try {
  const { execSync } = await import('node:child_process');
  // Get files changed since the remote tracking branch
  const remoteBranch = execSync('git rev-parse --abbrev-ref @{u} 2>/dev/null || echo origin/main', { encoding: 'utf-8' }).trim();
  const changedFiles = execSync(`git diff --name-only ${remoteBranch}...HEAD 2>/dev/null || git diff --name-only HEAD~1`, { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  const srcChanges = changedFiles.filter(f => f.startsWith('src/') && f.endsWith('.ts'));
  const testChanges = changedFiles.filter(f => f.includes('tests/') && f.endsWith('.test.ts'));

  if (srcChanges.length > 0 && testChanges.length === 0) {
    warnings.push(
      `${srcChanges.length} source file(s) changed but no test files were added or modified. ` +
      `Every code change should include regression tests. Files changed:\n` +
      srcChanges.slice(0, 5).map(f => `      • ${f}`).join('\n') +
      (srcChanges.length > 5 ? `\n      • ...and ${srcChanges.length - 5} more` : '')
    );
  }
} catch {
  // Git commands may fail in CI or detached HEAD — skip gracefully
}

// ── Report ────────────────────────────────────────────────────────────

if (errors.length > 0 || warnings.length > 0) {
  console.log('\n  Pre-Push Gate');
  console.log(`  ${'─'.repeat(40)}`);
}

if (errors.length > 0) {
  console.log('');
  for (const e of errors) {
    console.log(`  ❌ ${e}`);
  }
  console.log('\n  Fix these before pushing. This saves ~4 minutes vs. discovering them in the test suite.\n');
  process.exit(1);
}

if (warnings.length > 0) {
  console.log('');
  for (const w of warnings) {
    console.log(`  ⚠️  ${w}`);
  }
  console.log('');
}

// If we get here, gate passed — print nothing (let the test suite output take over)
