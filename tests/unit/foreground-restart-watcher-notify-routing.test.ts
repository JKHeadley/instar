/**
 * ForegroundRestartWatcher → Agent Updates topic routing.
 *
 * Failure shape: the `onRestartDetected` callback wired in commands/server.ts
 * fires `notify('IMMEDIATE', 'system', "Applying update to vN — restarting now…")`
 * without passing an explicit topicId. The central `notify()` helper defaults
 * an unset topicId to `agent-attention-topic`, so the heads-up landed in
 * Attention rather than the dedicated Agent Updates topic. Every other
 * update-class emitter routes to Updates; this one slipped through.
 *
 * Spec: docs/specs/UPDATE-MESSAGE-TOPIC-ROUTING-SPEC.md (Fix 2).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');
const serverSrc = fs.readFileSync(
  path.join(repoRoot, 'src', 'commands', 'server.ts'),
  'utf-8',
);

function sliceForegroundRestartBlock(): string {
  const start = serverSrc.indexOf('new ForegroundRestartWatcher');
  expect(start).toBeGreaterThan(0);
  // Match the closing `});` after `restartWatcher.start();` block. A
  // generous 3000-char window is plenty for the construction block.
  return serverSrc.slice(start, start + 3000);
}

describe('ForegroundRestartWatcher onRestartDetected → Agent Updates routing', () => {
  it('reads agent-updates-topic from state before notifying', () => {
    const block = sliceForegroundRestartBlock();
    // The callback must look up the Updates topic id.
    expect(block).toMatch(
      /state\.get<number>\(\s*['"]agent-updates-topic['"]\s*\)/,
    );
  });

  it('passes the resolved Updates topic as the explicit notify topicId argument', () => {
    const block = sliceForegroundRestartBlock();
    // The notify call must include a fourth-argument topic. Match the
    // resolved variable name flowing in. We don't constrain the variable
    // name beyond "*Updates*" to allow future renames.
    expect(block).toMatch(
      /notify\(\s*['"]IMMEDIATE['"]\s*,\s*['"]system['"]\s*,[\s\S]*?Applying update to v[\s\S]*?,\s*[A-Za-z_$][\w$]*[\s,]*\)/,
    );
  });

  it('falls through to central-notify default when Updates topic is unset (|| undefined)', () => {
    const block = sliceForegroundRestartBlock();
    // Use `|| undefined` (not `?? undefined`) so the unset/zero case
    // produces `undefined` and central-notify's existing default (Attention)
    // applies — no regression for agents without an Updates topic.
    expect(block).toMatch(
      /state\.get<number>\(\s*['"]agent-updates-topic['"]\s*\)\s*\|\|\s*undefined/,
    );
  });

  it('does NOT call notify with only the three-argument signature any more', () => {
    const block = sliceForegroundRestartBlock();
    // Find the specific notify() call for "Applying update to vN" and
    // assert it does not look like the old 3-arg form.
    const callMatch = block.match(
      /notify\(\s*['"]IMMEDIATE['"]\s*,\s*['"]system['"]\s*,[\s\S]*?Applying update to v[\s\S]*?\)/,
    );
    expect(callMatch).toBeTruthy();
    const call = callMatch![0];
    // Old shape was: notify('IMMEDIATE', 'system', `…`)
    // New shape adds the topicId argument. Count commas at the top level
    // of the call argument list. With backticks, the template literal
    // counts as one argument; the explicit topicId adds one more comma.
    // A simple heuristic: there must be at least one comma AFTER the
    // closing backtick of the message template literal.
    const lastBacktickIdx = call.lastIndexOf('`');
    expect(lastBacktickIdx).toBeGreaterThan(0);
    const afterMessage = call.slice(lastBacktickIdx + 1);
    expect(afterMessage).toMatch(/,/);
  });
});
