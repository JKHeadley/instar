/**
 * Unit tests for NativeHealDegradationBridge — translates
 * NativeModuleHealer HealEvents into DegradationReporter.report()
 * calls so heal failures surface on the user-visible alert path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  NativeModuleHealer,
  type HealEventListener,
  type HealEvent,
} from '../../src/memory/NativeModuleHealer.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { bridgeNativeHealToDegradation } from '../../src/monitoring/NativeHealDegradationBridge.js';

function makeHealEvent(overrides: Partial<HealEvent> = {}): HealEvent {
  return {
    component: 'SemanticMemory',
    timestamp: new Date().toISOString(),
    success: false,
    nodeVersion: 'v22.11.0',
    installPrefix: '/opt/instar/shadow-install',
    errorTail: 'npm exited 1',
    ...overrides,
  };
}

/** Fanout helper: trigger every registered listener with a synthesized event. */
function fanout(event: HealEvent): void {
  const listeners = (NativeModuleHealer as unknown as {
    listeners: Set<HealEventListener>;
  }).listeners;
  for (const l of listeners) l(event);
}

describe('NativeHealDegradationBridge', () => {
  let tmpDir: string;
  let reporter: DegradationReporter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-heal-bridge-test-'));
    NativeModuleHealer.resetForTesting();
    NativeModuleHealer.configure({ stateDir: tmpDir });
    DegradationReporter.resetForTesting();
    reporter = DegradationReporter.getInstance();
    reporter.configure({
      stateDir: tmpDir,
      agentName: 'test-agent',
      instarVersion: '0.0.0-test',
    });
  });

  it('reports a degradation when the healer emits a failure event', () => {
    const reportSpy = vi.spyOn(reporter, 'report');
    bridgeNativeHealToDegradation(reporter);

    fanout(makeHealEvent({ success: false }));

    expect(reportSpy).toHaveBeenCalledTimes(1);
    const arg = reportSpy.mock.calls[0][0];
    expect(arg.feature).toBe('SemanticMemory');
    expect(arg.primary).toContain('better-sqlite3');
    expect(arg.fallback).toContain('SemanticMemory');
    expect(arg.reason).toContain('v22.11.0');
    expect(arg.reason).toContain('/opt/instar/shadow-install');
    expect(arg.reason).toContain('npm exited 1');
    expect(arg.impact).toContain('knowledge graph');
  });

  it('does not report on a successful heal', () => {
    const reportSpy = vi.spyOn(reporter, 'report');
    bridgeNativeHealToDegradation(reporter);

    fanout(makeHealEvent({ success: true, errorTail: undefined }));

    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('dedupes by component within a single process', () => {
    const reportSpy = vi.spyOn(reporter, 'report');
    bridgeNativeHealToDegradation(reporter);

    fanout(makeHealEvent({ component: 'SemanticMemory' }));
    fanout(makeHealEvent({ component: 'SemanticMemory', errorTail: 'second failure' }));
    fanout(makeHealEvent({ component: 'TopicMemory' }));

    expect(reportSpy).toHaveBeenCalledTimes(2);
    expect(reportSpy.mock.calls[0][0].feature).toBe('SemanticMemory');
    expect(reportSpy.mock.calls[1][0].feature).toBe('TopicMemory');
  });

  it('uses a generic impact line for unknown components', () => {
    const reportSpy = vi.spyOn(reporter, 'report');
    bridgeNativeHealToDegradation(reporter);

    fanout(makeHealEvent({ component: 'SomeFutureFeature' }));

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0][0].impact).toContain('npm rebuild better-sqlite3');
  });

  it('omits prefix and tail gracefully when fields are missing', () => {
    const reportSpy = vi.spyOn(reporter, 'report');
    bridgeNativeHealToDegradation(reporter);

    fanout(makeHealEvent({ installPrefix: undefined, errorTail: undefined }));

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0][0].reason).not.toContain('prefix=');
    expect(reportSpy.mock.calls[0][0].reason).not.toContain('undefined');
  });

  it('returns an unsubscribe function that detaches the listener', () => {
    const reportSpy = vi.spyOn(reporter, 'report');
    const unsubscribe = bridgeNativeHealToDegradation(reporter);
    unsubscribe();

    fanout(makeHealEvent());

    expect(reportSpy).not.toHaveBeenCalled();
  });
});

describe('NativeModuleHealer.onHealEvent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-heal-listener-test-'));
    NativeModuleHealer.resetForTesting();
    NativeModuleHealer.configure({ stateDir: tmpDir });
  });

  it('invokes registered listeners after persisting a heal event', () => {
    const listener = vi.fn();
    NativeModuleHealer.onHealEvent(listener);

    // Force the early-exit "no install prefix" branch so we get a real
    // HealEvent without spawning npm. Spy on the private resolver and
    // make it return null — heal then logs the failure event and notifies
    // listeners through the production code path.
    const spy = vi
      .spyOn(NativeModuleHealer as unknown as { findBetterSqlite3InstallPrefix: () => string | null }, 'findBetterSqlite3InstallPrefix')
      .mockReturnValue(null);
    try {
      NativeModuleHealer.healBetterSqlite3Sync('UnitTestComponent');
    } finally {
      spy.mockRestore();
    }

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0];
    expect(event.component).toBe('UnitTestComponent');
    expect(event.success).toBe(false);
    expect(event.errorTail).toContain('install prefix');
  });

  it('swallows listener errors so the heal path is not broken', () => {
    const throwing = vi.fn(() => {
      throw new Error('listener boom');
    });
    const safe = vi.fn();
    NativeModuleHealer.onHealEvent(throwing);
    NativeModuleHealer.onHealEvent(safe);

    const spy = vi
      .spyOn(NativeModuleHealer as unknown as { findBetterSqlite3InstallPrefix: () => string | null }, 'findBetterSqlite3InstallPrefix')
      .mockReturnValue(null);
    try {
      expect(() => NativeModuleHealer.healBetterSqlite3Sync('SafetyTest')).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(safe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes cleanly', () => {
    const listener = vi.fn();
    const unsubscribe = NativeModuleHealer.onHealEvent(listener);
    unsubscribe();

    const spy = vi
      .spyOn(NativeModuleHealer as unknown as { findBetterSqlite3InstallPrefix: () => string | null }, 'findBetterSqlite3InstallPrefix')
      .mockReturnValue(null);
    try {
      NativeModuleHealer.healBetterSqlite3Sync('UnsubscribeTest');
    } finally {
      spy.mockRestore();
    }

    expect(listener).not.toHaveBeenCalled();
  });
});
