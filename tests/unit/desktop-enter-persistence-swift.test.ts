import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const source = fs.readFileSync(path.resolve(__dirname, '../../src/native/remote-desktop/macos/InstarDesktopHost.swift'), 'utf8');

describe.skipIf(process.platform !== 'darwin')('production Swift Enter persistence boundary, inert dispatch', () => {
  it('refuses invalid duty/producer and failed persistence; valid retries preserve state and dispatch only after commit', () => {
    expect(source).toContain('// BEGIN SECRET ENTER BOUNDARY');
    const block = source.split('// BEGIN SECRET ENTER BOUNDARY')[1].split('// END SECRET ENTER BOUNDARY')[0];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enter-persistence-swift-'));
    try {
      const file = path.join(dir, 'main.swift'), binary = path.join(dir, 'test');
      fs.writeFileSync(file, `import Foundation
import CoreFoundation
${block}
let key = "request.0"
let marker: [String: Any] = ["requestId": "request", "state": "owed", "typistPid": 42, "typistStart": "123.456", "enterPendingAt": 9, "custom": "preserve"]
let initial: [String: Any] = ["markers": [key: marker, "other.0": ["state": "watching"]], "dirty": ["at": 1], "attempts": ["count": 2]]
func equal(_ a: [String: Any], _ b: [String: Any]) -> Bool { NSDictionary(dictionary: a).isEqual(to: b) }
func record(_ state: inout [String: Any], request: String = "request", pid: Int = 42, start: String = "123.456", markerKey: String = "request.0", now: Int64 = 100) -> Bool {
  SecretEnterBoundary.recordIntent(state: &state, key: markerKey, requestId: request, pid: pid, start: start, now: now)
}
let encoded = try! JSONSerialization.data(withJSONObject: initial)
var decodedState = try! JSONSerialization.jsonObject(with: encoded) as! [String: Any]
assert(record(&decodedState))
var decodedFalse = try! JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: ["markers": [key: marker.merging(["relockNow": false]) { _, new in new }]])) as! [String: Any]
assert(record(&decodedFalse))
var refusals = 0
func reject(_ state: [String: Any], request: String = "request", pid: Int = 42, start: String = "123.456", markerKey: String = "request.0") {
  var copy = state
  var dispatched = 0
  let result = SecretEnterBoundary.dispatch(commit: { record(&copy, request: request, pid: pid, start: start, markerKey: markerKey) }, post: { dispatched += 1 })
  assert(!result && dispatched == 0 && equal(copy, state))
  refusals += 1
}
reject([:]); reject(initial, markerKey: "missing.0"); reject(initial, request: "wrong")
reject(initial, pid: 43); reject(initial, pid: 0); reject(initial, start: ""); reject(initial, start: "new-start")
for state in ["executing", "watching", "relocked", "relock-failed", "left-unlocked", "closed-not-applicable"] {
  var changed = marker; changed["state"] = state
  reject(["markers": [key: changed]])
}
for field in ["requestId", "typistPid", "typistStart", "state"] {
  var changed = marker; changed.removeValue(forKey: field)
  reject(["markers": [key: changed]])
}
for malformed: Any in [true, "true", ["requested": true], 0, 1, NSNull()] {
  var stopping = marker; stopping["relockNow"] = malformed
  reject(["markers": [key: stopping]])
}
var explicitlyFalse = initial
var falseMarker = marker; falseMarker["relockNow"] = false
explicitlyFalse["markers"] = [key: falseMarker]
assert(record(&explicitlyFalse))
// Match the actual JSONSerialization store representation as well as Swift values.
for json in [#"{"relockNow":false}"#, #"{"relockNow":0}"#] {
  let decoded = try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
  var row = marker; row["relockNow"] = decoded["relockNow"]
  var state: [String: Any] = ["markers": [key: row]]
  assert(record(&state) == json.contains("false"))
}
// Outer persistence failure AFTER a successful body must still suppress Enter.
var persisted = initial
var events: [String] = []
assert(!SecretEnterBoundary.dispatch(commit: {
  var temporary = persisted
  assert(record(&temporary))
  events.append("rename-failed")
  return nil
}, post: { events.append("ENTER") }))
assert(equal(persisted, initial) && events == ["rename-failed"])
assert(!SecretEnterBoundary.dispatch(commit: { nil }, post: { fatalError("store failed") }))
assert(!SecretEnterBoundary.dispatch(commit: { false }, post: { fatalError("validation failed") }))
// The serial input stream permits another valid attempt on the same duty.
for now: Int64 in [100, 200] {
  events = []
  assert(SecretEnterBoundary.dispatch(commit: {
    events.append("transaction")
    guard record(&persisted, now: now) else { return false }
    events.append("persisted")
    return true
  }, post: { events.append("down"); events.append("up") }))
  assert(events == ["transaction", "persisted", "down", "up"])
  var expected = initial
  var expectedMarker = marker; expectedMarker["enterPendingAt"] = now
  var markers = expected["markers"] as! [String: Any]; markers[key] = expectedMarker; expected["markers"] = markers
  assert(equal(persisted, expected))
}
// Reused duty cannot reuse another producer's identity or mutate an older timestamp on refusal.
reject(persisted, start: "replacement")
print("enter-boundary-executed refusals=" + String(refusals))
`);
      execFileSync('xcrun', ['swiftc', file, '-o', binary], { timeout: 120_000 });
      expect(execFileSync(binary, { encoding: 'utf8', timeout: 5_000 }).trim()).toBe('enter-boundary-executed refusals=24');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'Enter boundary Swift test cleanup' }); }
  }, 130_000);

  it('connects the actual secretType Enter pair to the checked transaction and preserves final safety checks/refusal', () => {
    const secret = source.split('fileprivate static func secretType(')[1].split('private static func abandonField')[0];
    expect(secret).toContain('guard !abort.wasAborted, secureTargetHolds() else');
    expect(secret).toContain('guard SecretEnterBoundary.dispatch(commit:');
    expect(secret).toContain('LockedStore.withLock(root: lockedRoot)');
    expect(secret).toContain('SecretEnterBoundary.recordIntent(state: &state, key: markerKey, requestId: requestId,');
    expect(secret).toContain('pid: Int(getpid()), start: typistStart');
    expect(secret).toContain('let typistStart = LockedStore.processInfo(getpid())?.start ?? ""');
    const boundary = secret.split('guard SecretEnterBoundary.dispatch(commit:')[1];
    const refusal = boundary.split('}) else {')[1].split('}')[0];
    expect(refusal).toContain('abandonField()');
    expect(refusal).toContain('throw HostError.refused("state-unavailable")');
    expect(secret.match(/postKey\(36/g)).toHaveLength(2);
    expect(boundary.split('}, post: {')[1].split('}) else {')[0]).toContain('postKey(36, flags: [], down: true)');
    expect(boundary.split('}, post: {')[1].split('}) else {')[0]).toContain('postKey(36, flags: [], down: false)');
    expect(secret.indexOf('guard !abort.wasAborted, secureTargetHolds() else')).toBeLessThan(secret.indexOf('guard SecretEnterBoundary.dispatch'));
    expect(boundary.indexOf('throw HostError.refused')).toBeLessThan(boundary.indexOf('$0["dirty"] = nil'));
  });
});
