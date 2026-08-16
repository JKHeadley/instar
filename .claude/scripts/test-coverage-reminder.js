#!/usr/bin/env node
/**
 * Test Coverage Reminder — PostToolUse hook that fires after Edit/Write
 * on instar source files. Tracks whether test files have been modified
 * in the current session and warns if source changes lack test coverage.
 *
 * Uses a temp file to track state across hook invocations within a session.
 */

const fs = require('fs');
const path = require('path');

const INSTAR_SRC = '/Users/justin/Documents/Projects/instar/src/';
const INSTAR_TESTS = '/Users/justin/Documents/Projects/instar/tests/';
const STATE_FILE = '/tmp/instar-test-coverage-state.json';

// Read hook input from stdin
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const filePath = input.tool_input?.file_path || '';

    // Load or initialize state
    let state = { srcFiles: [], testFiles: [], reminded: false, lastRemindAt: 0 };
    try {
      if (fs.existsSync(STATE_FILE)) {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      }
    } catch { /* start fresh */ }

    const isSourceFile = filePath.startsWith(INSTAR_SRC) && filePath.endsWith('.ts');
    const isTestFile = filePath.includes('/tests/') && filePath.endsWith('.test.ts');

    if (isSourceFile && !state.srcFiles.includes(filePath)) {
      state.srcFiles.push(filePath);
    }
    if (isTestFile && !state.testFiles.includes(filePath)) {
      state.testFiles.push(filePath);
    }

    // Check: source files changed but no test files yet
    // Only remind every 10 minutes max to avoid noise
    const now = Date.now();
    const timeSinceRemind = now - (state.lastRemindAt || 0);
    const shouldRemind = state.srcFiles.length > 0
      && state.testFiles.length === 0
      && state.srcFiles.length >= 2  // Don't nag on the first edit
      && timeSinceRemind > 10 * 60 * 1000;

    if (shouldRemind) {
      state.lastRemindAt = now;
      const fileList = state.srcFiles.slice(-3).map(f => path.basename(f)).join(', ');
      process.stderr.write(
        `\n⚠️  TEST COVERAGE REMINDER: ${state.srcFiles.length} source file(s) modified (${fileList}) ` +
        `but no test files created yet. Every change needs regression tests.\n\n`
      );
    }

    // Save state
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    // Don't block on errors
  }
});
