/**
 * framework-agnosticism — ENFORCES that warm-session A2A / live-injection works
 * for EVERY agentic framework, not just claude-code.
 *
 * This is the review-process gate for the requirement "the warm-session solution
 * must work with ALL current and future frameworks." The compiler already
 * enforces exhaustiveness on the `Record<IntelligenceFramework, …>` maps (you
 * cannot construct the injection-process registry or the launch BUILDERS without
 * every framework key), but a Record permits an EMPTY entry — these tests close
 * that gap and pin the allowlist⇄registry invariant so nobody can quietly
 * hardcode a single framework's process name back into the inject allowlist.
 *
 * If a new framework is added to IntelligenceFramework/SUPPORTED_FRAMEWORKS, the
 * compiler forces an injection-process entry + a launch builder, and these tests
 * force them to be NON-EMPTY — so warm sessions stay framework-general by
 * construction, not by anyone remembering to make them so.
 */

import { describe, it, expect } from 'vitest';
import { SUPPORTED_FRAMEWORKS } from '../../src/core/TopicFrameworksStore.js';
import {
  INJECTION_SHELL_PROCESSES,
  allFrameworkInjectionProcessNames,
  injectionProcessNamesForFramework,
} from '../../src/core/frameworkInjectionProcesses.js';
import { ALLOWED_INJECTION_PROCESSES } from '../../src/messaging/types.js';
import { buildInteractiveLaunch } from '../../src/core/frameworkSessionLaunch.js';

describe('framework-agnosticism: warm-session live-inject covers ALL frameworks', () => {
  it('every supported framework declares at least one interactive injection-process name', () => {
    for (const fw of SUPPORTED_FRAMEWORKS) {
      const names = injectionProcessNamesForFramework(fw);
      expect(
        names.length,
        `framework "${fw}" has no injection process names in FRAMEWORK_INJECTION_PROCESS_NAMES — ` +
          `a warm-session A2A worker running ${fw} would have its follow-up inject REFUSED ` +
          `("Unsafe foreground process"). Add ${fw}'s pane process name(s).`,
      ).toBeGreaterThan(0);
    }
  });

  it('every supported framework has an interactive launch builder (warm worker can be spawned)', () => {
    for (const fw of SUPPORTED_FRAMEWORKS) {
      expect(
        () => buildInteractiveLaunch(fw, { binaryPath: `/usr/local/bin/${fw}` }),
        `framework "${fw}" has no interactive launch builder — a warm A2A worker in ${fw} cannot be launched`,
      ).not.toThrow();
    }
  });

  it('the inject allowlist is DERIVED from the registry (shells ∪ framework registry), not hardcoded', () => {
    const expected = [...new Set([...INJECTION_SHELL_PROCESSES, ...allFrameworkInjectionProcessNames()])].sort();
    expect([...ALLOWED_INJECTION_PROCESSES].sort()).toEqual(expected);
  });

  it('no allowlist entry exists outside the shell list or the framework registry', () => {
    const shells = new Set(INJECTION_SHELL_PROCESSES);
    const frameworkNames = new Set(allFrameworkInjectionProcessNames());
    for (const p of ALLOWED_INJECTION_PROCESSES) {
      expect(
        shells.has(p) || frameworkNames.has(p),
        `"${p}" is in ALLOWED_INJECTION_PROCESSES but is neither a shell nor a registered framework ` +
          `process name. Add it to FRAMEWORK_INJECTION_PROCESS_NAMES instead of hardcoding it.`,
      ).toBe(true);
    }
  });

  it('preserves the macOS claude.exe pane-command quirk via the registry', () => {
    expect(injectionProcessNamesForFramework('claude-code')).toContain('claude.exe');
    expect(ALLOWED_INJECTION_PROCESSES).toContain('claude.exe');
  });
});
