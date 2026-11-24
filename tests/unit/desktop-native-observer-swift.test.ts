import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const source = fs.readFileSync(path.resolve(__dirname, '../../src/native/remote-desktop/macos/InstarDesktopHost.swift'), 'utf8');

describe.skipIf(process.platform !== 'darwin')('actual Swift observation block with inert dispatch', () => {
  it('executes direct/fallback/no-method/overflow/invalid-init and matching watch/final witnesses', () => {
    const block = source.split('// BEGIN GUARD OBSERVATION')[1].split('// END GUARD OBSERVATION')[0];
    const code = block.slice(block.indexOf('\n'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-observer-swift-'));
    try {
      const file = path.join(dir, 'main.swift'), binary = path.join(dir, 'test');
      fs.writeFileSync(file, `import Foundation\nimport Darwin\n${code}\n
var calls = 0
var o = GuardDispatchObservation(attemptId: "12345678-1234-1234-1234-123456789abc:1", key: "12345678-1234-1234-1234-123456789abc.0", pid: 42, start: "123.456")
assert(o.dispatch(direct: { calls += 1 }, fallback: { fatalError("wrong path") }))
assert(o.count == 1 && calls == 1)
assert(o.dispatch(direct: nil, fallback: { calls += 1 }))
assert(o.count == 2 && calls == 2)
assert(!o.dispatch(direct: nil, fallback: nil))
assert(o.count == 2)
let watch = o.checkpoint()
let end = o.witness(phase: "final", terminal: "closed-not-applicable")
assert(watch["count"] as? Int64 == 2 && end["checkpointCount"] as? Int64 == 2)
assert(end["complete"] as? Bool == true && end["attemptId"] as? String == watch["attemptId"] as? String)
o.count = GuardDispatchObservation.limit
assert(o.dispatch(direct: { calls += 1 }, fallback: nil))
assert(calls == 3 && !o.complete && o.count == GuardDispatchObservation.limit)
var invalid = GuardDispatchObservation(attemptId: "", key: "", pid: 0, start: "")
assert(invalid.dispatch(direct: nil, fallback: { calls += 1 }))
assert(!invalid.complete && calls == 4)
print("native-observer-executed")
var life = GuardDispatchObservation(attemptId: "12345678-1234-1234-1234-123456789abc:2", key: "12345678-1234-1234-1234-123456789abc.0", pid: Int(getpid()), start: "fixture-start")
let begin = life.checkpoint()
print(String(data: try! JSONSerialization.data(withJSONObject: begin), encoding: .utf8)!)
fflush(stdout)
if CommandLine.arguments.contains("--abrupt") { kill(getpid(), SIGKILL) }
print(String(data: try! JSONSerialization.data(withJSONObject: life.witness(phase: "final", terminal: "closed-not-applicable")), encoding: .utf8)!)
`);
      execFileSync('xcrun', ['swiftc', file, '-o', binary], { timeout: 120_000 });
      const lines = execFileSync(binary, { encoding: 'utf8', timeout: 5_000 }).trim().split('\n');
      expect(lines[0]).toBe('native-observer-executed');
      const watch = JSON.parse(lines[1]), final = JSON.parse(lines[2]);
      expect(final).toMatchObject({ attemptId: watch.attemptId, pid: watch.pid, start: watch.start, checkpointCount: watch.count, phase: 'final' });
      const killed = spawnSync(binary, ['--abrupt'], { encoding: 'utf8', timeout: 5_000 });
      expect(killed.signal).toBe('SIGKILL');
      expect(killed.stdout.trim().split('\n')).toHaveLength(2); // positive checkpoint, no counterfeit terminal seal
      expect(killed.stdout).not.toContain('"phase":"final"');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'Swift observer test cleanup' }); }
  }, 130_000);
  it('wires every real dispatch and native transition without putting recorder I/O in the lock funnel', () => {
    const funnel = source.split('private static func lockNow()')[1].split('private static func transition')[0];
    expect(funnel.match(/guardObservation.dispatch/g)).toHaveLength(2);
    expect(funnel).not.toMatch(/withLock|write|FileManager|sleep\(/);
    const transition = source.split('private static func transition')[1].split('private static func readMarker')[0];
    expect(transition).toContain('guardObservation.checkpoint()');
    expect(transition).toContain('guardObservation.witness(phase: "final", terminal: to)');
    const emergency = source.split('private static func emergencyLock')[1].split('private static func beat')[0];
    expect(emergency).toContain('lockNow()');
    expect(emergency).not.toContain('guardFinalObservation');
    // Every terminal transition in the current single-threaded native state machine exits immediately.
    const terminalCalls = source.match(/transition\(root: root, key: key, from: \[[^\]]+\], to: "(?:closed-not-applicable|relock-failed|relocked)"[\s\S]*?exit\(0\)/g) ?? [];
    expect(terminalCalls.length).toBe(8);
    for (const call of terminalCalls) expect(call).not.toContain('lockNow()');
  });
});
