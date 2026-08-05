/**
 * Tests for the self-heal-first + tone-gate routing path in
 * DegradationReporter. See upgrades/side-effects/agent-health-alert-authority-routing.md.
 *
 * The flow under test:
 *   report() → reportEvent() → if a healer is registered, run it FIRST.
 *     - heal succeeded → suppress user alert (telegramSender NOT called)
 *     - heal failed / no healer → compose narrative → tone gate review
 *       - gate passes → send the candidate
 *       - gate blocks → send the safe-template fallback
 *
 * The gate is mocked so we can drive specific decisions deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MessagingToneGate } from '../../src/core/MessagingToneGate.js';

function gateThatPasses(): MessagingToneGate {
  return {
    review: vi.fn(async () => ({ pass: true, rule: '', issue: '', suggestion: '', latencyMs: 1 })),
  } as unknown as MessagingToneGate;
}

function gateThatBlocks(rule: string): MessagingToneGate {
  return {
    review: vi.fn(async () => ({
      pass: false,
      rule,
      issue: 'blocked for testing',
      suggestion: 'use the fallback',
      latencyMs: 1,
    })),
  } as unknown as MessagingToneGate;
}

const event = {
  feature: 'TestFeature',
  primary: 'Primary path',
  fallback: 'Fallback path',
  reason: 'Primary failed',
  impact: 'User sees X',
};

describe('DegradationReporter — self-heal-first', () => {
  let tmpDir: string;

  beforeEach(() => {
    DegradationReporter.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'degradation-self-heal-'));
  });

  afterEach(() => {
    DegradationReporter.resetForTesting();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/degradation-reporter-self-heal.test.ts' });
  });

  // ── C1: bounded-attention-notification-surface ──────────────
  // The gate that makes routine degradation reports stop reaching the operator.
  // Measured 2026-08-04: 25 of 64 daily attention messages were these, and zero
  // were actionable. Operator-approved default (topic 7848, "Silent").

  it('C1: does NOT alert the user by default — notifyUser is opt-in', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });
    const telegramSender = vi.fn(async () => undefined);
    const feedbackSubmitter = vi.fn(async () => undefined);
    // notifyUser deliberately OMITTED — this is the shipped default.
    reporter.connectDownstream({
      feedbackSubmitter,
      telegramSender,
      alertTopicId: 1234,
      toneGate: gateThatPasses(),
    });

    reporter.report(event);
    await new Promise((r) => setTimeout(r, 10));

    expect(telegramSender).not.toHaveBeenCalled();
    // The RECORD is preserved — only delivery stops. A gate that also dropped
    // the record would be data loss, not noise reduction.
    expect(feedbackSubmitter).toHaveBeenCalled();
  });

  it('C1 CONTROL: with notifyUser:true the SAME event alerts', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });
    const telegramSender = vi.fn(async () => undefined);
    reporter.connectDownstream({
      telegramSender,
      alertTopicId: 1234,
      notifyUser: true,
      toneGate: gateThatPasses(),
    });

    reporter.report(event);
    await new Promise((r) => setTimeout(r, 10));

    // Without this control the test above would pass equally well against a
    // reporter whose alert path was simply broken.
    expect(telegramSender).toHaveBeenCalled();
  });

  it('C1: an explicit notifyUser:false is honoured', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });
    const telegramSender = vi.fn(async () => undefined);
    reporter.connectDownstream({
      telegramSender,
      alertTopicId: 1234,
      notifyUser: false,
      toneGate: gateThatPasses(),
    });

    reporter.report(event);
    await new Promise((r) => setTimeout(r, 10));

    expect(telegramSender).not.toHaveBeenCalled();
  });

  it('suppresses user alert when self-heal succeeds', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });
    const telegramSender = vi.fn(async () => undefined);
    reporter.connectDownstream({
      telegramSender,
      alertTopicId: 1234,
      notifyUser: true, // C1: these tests exercise the ALERT path; the gate now defaults OFF
      toneGate: gateThatPasses(),
    });
    reporter.registerHealer('TestFeature', vi.fn(async () => true));

    reporter.report(event);
    // Allow the async reportEvent path to flush
    await new Promise((r) => setTimeout(r, 10));

    expect(telegramSender).not.toHaveBeenCalled();
  });

  it('proceeds to alert when self-heal fails', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });
    const telegramSender = vi.fn(async () => undefined);
    reporter.connectDownstream({
      telegramSender,
      alertTopicId: 1234,
      notifyUser: true, // C1: these tests exercise the ALERT path; the gate now defaults OFF
      toneGate: gateThatPasses(),
    });
    reporter.registerHealer('TestFeature', vi.fn(async () => false));

    reporter.report(event);
    await new Promise((r) => setTimeout(r, 10));

    expect(telegramSender).toHaveBeenCalledTimes(1);
  });

  it('proceeds to alert when no healer is registered', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });
    const telegramSender = vi.fn(async () => undefined);
    reporter.connectDownstream({
      telegramSender,
      alertTopicId: 1234,
      notifyUser: true, // C1: these tests exercise the ALERT path; the gate now defaults OFF
      toneGate: gateThatPasses(),
    });

    reporter.report(event);
    await new Promise((r) => setTimeout(r, 10));

    expect(telegramSender).toHaveBeenCalledTimes(1);
  });

  it('falls back to the safe template when the tone gate blocks', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });
    const telegramSender = vi.fn(async () => undefined);
    reporter.connectDownstream({
      telegramSender,
      alertTopicId: 1234,
      notifyUser: true, // C1: these tests exercise the ALERT path; the gate now defaults OFF
      toneGate: gateThatBlocks('B12_HEALTH_ALERT_INTERNALS'),
    });
    // No healer → proceeds to gate path

    reporter.report(event);
    await new Promise((r) => setTimeout(r, 10));

    expect(telegramSender).toHaveBeenCalledTimes(1);
    const sentText = telegramSender.mock.calls[0]![1] as string;
    expect(sentText).toMatch(/Something on my end stopped working/);
    expect(sentText).toMatch(/\?$/); // ends with question mark — CTA contract
  });

  it('passes the candidate through unchanged when the tone gate passes', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });
    const telegramSender = vi.fn(async () => undefined);
    reporter.connectDownstream({
      telegramSender,
      alertTopicId: 1234,
      notifyUser: true, // C1: these tests exercise the ALERT path; the gate now defaults OFF
      toneGate: gateThatPasses(),
    });

    reporter.report(event);
    await new Promise((r) => setTimeout(r, 10));

    expect(telegramSender).toHaveBeenCalledTimes(1);
    const sentText = telegramSender.mock.calls[0]![1] as string;
    // narrativeFor() output, not the safe template
    expect(sentText).toContain('User sees X');
  });

  it('treats a thrown healer as failure and proceeds to alert', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });
    const telegramSender = vi.fn(async () => undefined);
    reporter.connectDownstream({
      telegramSender,
      alertTopicId: 1234,
      notifyUser: true, // C1: these tests exercise the ALERT path; the gate now defaults OFF
      toneGate: gateThatPasses(),
    });
    reporter.registerHealer('TestFeature', vi.fn(async () => {
      throw new Error('healer crashed');
    }));

    reporter.report(event);
    await new Promise((r) => setTimeout(r, 10));

    expect(telegramSender).toHaveBeenCalledTimes(1);
  });

  it('sends candidate as-is when no toneGate is wired (fail-open)', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test', instarVersion: '0.0.0' });
    const telegramSender = vi.fn(async () => undefined);
    reporter.connectDownstream({
      telegramSender,
      alertTopicId: 1234,
      notifyUser: true, // C1: these tests exercise the ALERT path; the gate now defaults OFF
      // toneGate omitted — backwards compat path
    });

    reporter.report(event);
    await new Promise((r) => setTimeout(r, 10));

    expect(telegramSender).toHaveBeenCalledTimes(1);
  });
});
