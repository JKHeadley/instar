/**
 * Version-skew alert routing — closes the 2026-05-27 wrong-topic class.
 *
 * Failure shape: when the lifeline received HTTP 426 (server ahead of
 * lifeline version) while forwarding a message that arrived in some topic
 * T_INBOUND, the user-visible "Heads up: my server auto-updated to vN…"
 * alert was sent TO T_INBOUND. Update-class messages are supposed to land
 * in the dedicated Agent Updates topic, never in whatever conversation the
 * user happened to be typing in.
 *
 * Spec: docs/specs/UPDATE-MESSAGE-TOPIC-ROUTING-SPEC.md (Fix 1).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const lifelineSrc = fs.readFileSync(
  path.join(repoRoot, 'src', 'lifeline', 'TelegramLifeline.ts'),
  'utf-8',
);

function sliceMethod(needle: string, length: number = 4000): string {
  const idx = lifelineSrc.indexOf(needle);
  if (idx < 0) throw new Error(`needle not found: ${needle}`);
  return lifelineSrc.slice(idx, idx + length);
}

describe('Version-skew alert routing — resolveUpdatesAlertTopic helper', () => {
  it('exists as a private method on TelegramLifeline', () => {
    expect(lifelineSrc).toMatch(
      /private\s+resolveUpdatesAlertTopic\s*\(\s*\)\s*:\s*number\s*\|\s*null\s*\{/,
    );
  });

  it('reads agent-updates-topic from the server state file', () => {
    const body = sliceMethod('private resolveUpdatesAlertTopic(');
    expect(body).toContain('agent-updates-topic.json');
    expect(body).toMatch(/this\.projectConfig\.stateDir/);
    expect(body).toContain("'state'");
    expect(body).toContain('fs.readFileSync');
  });

  it('falls back to lifelineTopicId when Updates topic is unset', () => {
    const body = sliceMethod('private resolveUpdatesAlertTopic(');
    // Return path ends with the lifeline-topic fallback when state read
    // produces nothing usable.
    expect(body).toMatch(/return this\.lifelineTopicId\s*\?\?\s*null/);
  });

  it('logs a warning instead of throwing when state read fails', () => {
    const body = sliceMethod('private resolveUpdatesAlertTopic(');
    expect(body).toContain('try {');
    expect(body).toContain('catch');
    expect(body).toMatch(/console\.warn\(\s*['"`]\[Lifeline\]/);
  });

  it('validates the parsed value is a positive number before returning it', () => {
    const body = sliceMethod('private resolveUpdatesAlertTopic(');
    expect(body).toMatch(/typeof\s+parsed\s*===\s*['"]number['"]/);
    expect(body).toMatch(/parsed\s*>\s*0/);
  });
});

describe('Version-skew alert routing — handleVersionSkew picks Updates topic, not inbound', () => {
  it('resolves destination via resolveUpdatesAlertTopic, not the inbound topic', () => {
    const handler = sliceMethod('private handleVersionSkew(', 6000);
    // The destination resolution must go through the helper.
    expect(handler).toContain('this.resolveUpdatesAlertTopic()');
    // The send must use the resolved id, never the inbound parameter.
    // Match the exact call shape: sendToTopic(alertTopicId, ...).
    expect(handler).toMatch(/sendToTopic\s*\(\s*alertTopicId\s*,/);
    // Defensive: the inbound parameter name must NOT appear as the first
    // argument to a sendToTopic call inside this method.
    const sendCallsToInbound = handler.match(
      /sendToTopic\s*\(\s*(?:inboundTopicId|topicId)\s*,/g,
    );
    expect(sendCallsToInbound).toBeNull();
  });

  it('renames the inbound parameter from topicId to inboundTopicId for clarity', () => {
    expect(lifelineSrc).toMatch(
      /private\s+handleVersionSkew\s*\(\s*err\s*:\s*ForwardVersionSkewError\s*,\s*inboundTopicId\s*:\s*number\s*\)/,
    );
  });

  it('caller in forwardToServer still passes the inbound topic for diagnostics', () => {
    const fwd = lifelineSrc.slice(
      lifelineSrc.indexOf('private async forwardToServer('),
      lifelineSrc.indexOf('private resolveUpdatesAlertTopic('),
    );
    // Caller signature unchanged — the inbound topic flows through for
    // logging context.
    expect(fwd).toMatch(/this\.handleVersionSkew\s*\(\s*err\s*,\s*topicId\s*\)/);
  });

  it('drops the alert (does not pick inbound topic) when neither Updates nor Lifeline topic is set', () => {
    const handler = sliceMethod('private handleVersionSkew(', 6000);
    // When resolveUpdatesAlertTopic returns null, the handler must NOT
    // fall back to inboundTopicId. It must log and skip.
    expect(handler).toMatch(/alertTopicId\s*!==\s*null/);
    expect(handler).toContain('version-skew alert dropped');
    // The else branch must reference inboundTopicId only in the log, not
    // as a sendToTopic destination.
    const elseBranch = handler.slice(handler.indexOf('alertTopicId !== null'));
    expect(elseBranch).not.toMatch(/sendToTopic\s*\(\s*inboundTopicId/);
  });

  it('preserves the 24h dedupe behavior under the new routing', () => {
    const handler = sliceMethod('private handleVersionSkew(', 6000);
    expect(handler).toContain('versionSkewAlertSentAt');
    expect(handler).toContain('ALERT_DEDUPE_MS');
    expect(handler).toMatch(/24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('initiateRestart is still called regardless of where the alert went', () => {
    const handler = sliceMethod('private handleVersionSkew(', 6000);
    expect(handler).toContain("this.initiateRestart('versionSkew',");
  });
});
