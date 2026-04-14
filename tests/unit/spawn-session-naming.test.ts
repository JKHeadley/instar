/**
 * Tests for human-readable tmux session names for Slack-spawned sessions.
 *
 * Bug: tmux session names were always ${agent}-interactive-${Date.now()},
 * making it impossible to tell which Slack channel a session is for.
 * Fix: propagate Slack channel name through spawnInteractiveSession.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_MANAGER_SRC = path.join(process.cwd(), 'src/core/SessionManager.ts');
const SERVER_SRC = path.join(process.cwd(), 'src/commands/server.ts');

describe('SessionManager.spawnInteractiveSession — Slack channel naming', () => {
  const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');

  it('options accept slackChannelName', () => {
    // options type in spawnInteractiveSession signature or adjacent
    const signature = source.slice(
      source.indexOf('spawnInteractiveSession('),
      source.indexOf('spawnInteractiveSession(') + 400,
    );
    expect(signature).toContain('slackChannelName');
  });

  it('uses slackChannelName to construct the tmux session name when provided', () => {
    const methodStart = source.indexOf('spawnInteractiveSession(');
    const methodEnd = source.indexOf('\n  async ', methodStart + 200);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : methodStart + 4000);
    // Must reference slackChannelName in the naming logic
    expect(method).toContain('slackChannelName');
    // Must produce a readable prefix like "slack-"
    expect(method).toMatch(/slack-/);
  });
});

describe('server.ts — Slack spawn passes channel name through', () => {
  const source = fs.readFileSync(SERVER_SRC, 'utf-8');

  it('passes slackChannelName to spawnInteractiveSession', () => {
    // The slack→session spawn path invokes spawnInteractiveSession — must include slackChannelName
    const spawnCall = source.slice(
      source.indexOf('spawnInteractiveSession('),
      source.indexOf('spawnInteractiveSession(') + 600,
    );
    expect(spawnCall).toContain('slackChannelName');
  });

  it('passes channelName to registerChannelSession', () => {
    // After the successful spawn, registerChannelSession should receive the channelName
    // Find one of the registerChannelSession call sites near spawnInteractiveSession
    const registrations = [...source.matchAll(/registerChannelSession\([^)]*\)/g)];
    expect(registrations.length).toBeGreaterThan(0);
    // At least one registerChannelSession call must include a channel name argument
    // (third positional arg OR an object with channelName). We look for 3-arg form with comma count >= 2.
    const hasNamed = registrations.some(m => {
      const args = m[0].slice('registerChannelSession('.length, -1);
      // 2+ commas means 3+ args (channelId, sessionName, channelName)
      return args.split(',').length >= 3;
    });
    expect(hasNamed).toBe(true);
  });
});
