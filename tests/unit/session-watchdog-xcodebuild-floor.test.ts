import { describe, expect, it } from 'vitest';
import {
  activeXcodeDeveloperDir,
  classifyTestRunnerCommand,
  classifyTestRunnerProtection,
  MAX_TEST_RUNNER_ABSOLUTE_MS,
  MAX_TEST_RUNNER_PROTECTION_MS,
} from '../../src/monitoring/SessionWatchdog.js';

// fb-412e8332-ee1: the watchdog SIGINTed a healthy `xcodebuild test` run at 1013s.
const DEV = '/Applications/Xcode-26.6.0.app/Contents/Developer';
const XB = `${DEV}/usr/bin/xcodebuild`;

describe('SessionWatchdog test-runner floor: Xcode test runs (fb-412e8332-ee1)', () => {
  it.each([
    // The exact killed run, as ps shows it.
    `${XB} test -project apps/instar-ios/InstarApp.xcodeproj -scheme InstarApp -destination platform=iOS Simulator,name=iPhone 17`,
    `${XB} -project App.xcodeproj -scheme App -destination id=ABC test`,
    `${XB} -quiet -workspace App.xcworkspace -scheme App test-without-building -only-testing:AppUITests`,
    `${XB} -scheme App CODE_SIGNING_ALLOWED=NO test`,
    `${XB} build-for-testing test-without-building -scheme App`,
    '/usr/bin/xcodebuild test -scheme App',
    `${XB} -scheme App -only-testing:AppTests/FooTests test`,
    `${XB} -scheme App -skip-testing:AppUITests -retry-tests-on-failure test-without-building`,
    `${XB} -scheme App -test-iterations=3 -run-tests-until-failure test`,
    `${DEV}/usr/bin/xctest -XCTest AppTests/testFoo /tmp/Build/AppTests.xctest`,
  ])('protects a real Xcode test run: %s', (command) => {
    expect(classifyTestRunnerCommand(command, DEV)).toBe('test-runner');
  });

  it('the floor (not just the classifier) protects the run at the age it was killed', () => {
    // The shim path is host-independent; developer-dir paths depend on xcode-select.
    expect(classifyTestRunnerProtection('/usr/bin/xcodebuild test -scheme App', 1_013_000, [], 'unknown'))
      .toEqual({ protected: true, reason: 'test-runner' });
  });

  it('matches a developer dir that contains spaces', () => {
    const dev = '/Applications/Xcode 26 beta.app/Contents/Developer';
    expect(classifyTestRunnerCommand(`${dev}/usr/bin/xcodebuild test -scheme App`, dev)).toBe('test-runner');
  });

  it.each([
    // Basename only: identity cannot be checked.
    'xcodebuild test -scheme App',
    // Lookalikes outside the active developer dir.
    '/tmp/evil/usr/bin/xcodebuild test -scheme App',
    '/Applications/Xcode-OLD.app/Contents/Developer/usr/bin/xcodebuild test -scheme App',
    `${XB}-wrapper test -scheme App`,
    `/usr/local/bin/xcodebuild test`,
    // Right binary, no test action: `test` is an option's value, or a build.
    `${XB} -scheme test build`,
    `${XB} -project test -scheme App build`,
    `${XB} build -scheme App`,
    `${XB} archive -scheme App`,
    `${XB} -list`,
    `${XB} -only-testing:AppTests build`,
    `${XB} -retry-tests-on-failure build`,
    `${XB} TEST_FLAG=test build`,
    // Unrelated commands that mention xcodebuild.
    `echo ${XB} test`,
    `grep -r xcodebuild test src`,
    `${DEV}/usr/bin/xctest -h`,
    `${DEV}/usr/bin/xcrun simctl list`,
  ])('does not protect a lookalike or non-test command: %s', (command) => {
    expect(classifyTestRunnerCommand(command, DEV)).toBeNull();
  });

  it('protects nothing Xcode-shaped when there is no active developer dir', () => {
    expect(classifyTestRunnerCommand(`${XB} test -scheme App`, null)).toBeNull();
    // The SIP-protected shim stays identifiable without a developer dir.
    expect(classifyTestRunnerCommand('/usr/bin/xcodebuild test -scheme App', null)).toBe('test-runner');
  });

  it('stays bounded: a hung run is handed back to the judge past the stated bounds', () => {
    const live = `/usr/bin/xcodebuild test -scheme App`;
    expect(classifyTestRunnerProtection(live, MAX_TEST_RUNNER_PROTECTION_MS, [], 'unknown')?.protected).toBe(true);
    expect(classifyTestRunnerProtection(live, MAX_TEST_RUNNER_PROTECTION_MS + 1, [], 'stalled')).toEqual({ protected: false });
    expect(classifyTestRunnerProtection(live, MAX_TEST_RUNNER_PROTECTION_MS + 1, [], 'progressed'))
      .toEqual({ protected: true, reason: 'test-runner', extendedByProgress: true });
    expect(classifyTestRunnerProtection(live, MAX_TEST_RUNNER_ABSOLUTE_MS + 1, [], 'progressed')).toEqual({ protected: false });
  });

  it('protects a shell wrapper only while the Xcode test run is below it', () => {
    const wrapper = '/bin/zsh -lc cd apps/instar-ios && xcodebuild test -scheme App';
    expect(classifyTestRunnerProtection(wrapper, 1_013_000, ['/usr/bin/xcodebuild test -scheme App'], 'unknown'))
      .toEqual({ protected: true, reason: 'test-runner-ancestor' });
    expect(classifyTestRunnerProtection(wrapper, 1_013_000, ['/usr/bin/xcodebuild build -scheme App'], 'unknown')).toBeNull();
  });

  it('resolves the active developer dir once and returns an absolute path or null', () => {
    const dir = activeXcodeDeveloperDir();
    expect(dir === null || dir.startsWith('/')).toBe(true);
    expect(activeXcodeDeveloperDir()).toBe(dir);
  });
});
