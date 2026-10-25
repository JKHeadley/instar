import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, EchoWindowLedgerStore, runNativeAdmissionAdapter } from '../../src/core/WindowLifecycleObligationLedger.js';
import { validAdmissionPackage, writeAdmissionStore } from '../helpers/betweenWindowAdmissionFixture.js';

describe('window lifecycle native adapter', () => {
  it('runs the real package/result contract, persists exact bytes/output, and rejects replay', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-native-')); writeAdmissionStore(stateDir);
    const store = new EchoWindowLedgerStore(stateDir); store.save(createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [] } }));
    const record = runNativeAdmissionAdapter({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', stateDir, package: validAdmissionPackage(), nonce: 'native-pass-0001' });
    expect((record.output as { admitted: boolean }).admitted).toBe(true); expect(record.inputBytes).toBe(JSON.stringify(validAdmissionPackage()));
    store.appendNativeEvaluation('echo', 'echo-window-lifecycle', record); expect(() => store.appendNativeEvaluation('echo', 'echo-window-lifecycle', record)).toThrow('nonce-replay');
  });
  it.each([
    ['wrong topic', (p: any) => { p.fullHistoryReceipts[0].topicId = 1; }],
    ['absent row', (p: any) => { p.fullHistoryReceipts[0].messageId = 999999; }],
    ['mismatch omission', (p: any) => { p.knownCorpusMismatches = []; }],
  ])('refuses %s through the installed evaluator', (_name, mutate) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-native-refuse-')); writeAdmissionStore(stateDir); const pkg = validAdmissionPackage() as any; mutate(pkg);
    const result = runNativeAdmissionAdapter({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', stateDir, package: pkg, nonce: `native-refuse-${Math.random().toString(16).slice(2)}` });
    expect((result.output as { admitted: boolean }).admitted).toBe(false);
  });
  it('refuses malformed store and invalid compatibility nonce', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-native-bad-')); fs.writeFileSync(path.join(stateDir, 'telegram-messages.jsonl'), '{bad');
    expect((runNativeAdmissionAdapter({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', stateDir, package: validAdmissionPackage(), nonce: 'native-malformed-1' }).output as { admitted: boolean }).admitted).toBe(false);
    expect(() => runNativeAdmissionAdapter({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', stateDir, package: {}, nonce: 'bad' })).toThrow('invalid-native-evaluation-nonce');
    expect(() => runNativeAdmissionAdapter({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', stateDir, package: {}, nonce: 'native-version-1', installedContractVersion: 'older-contract' })).toThrow('native-evaluator-incompatible');
  });
});
