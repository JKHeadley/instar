/**
 * stallEvidence — the canonical assertion helper for stall-coverage evidence
 * tests (docs/specs/framework-stall-coverage-matrix.md §2.2/§3.2).
 *
 * An `expectStallDetectorFires` call carries the framework + classId next to a
 * RAW stall-signature fixture and wires the REAL detector into `detect` — the
 * validator's evidence-containment check accepts this as the canonical form of
 * the identifier + `stall-class:` marker requirement.
 */

export function expectStallDetectorFires(args: {
  framework: string;
  classId: string;
  fixture: string;
  detect: (fixtureText: string) => boolean;
}): void {
  if (args.detect(args.fixture) !== true) {
    throw new Error(
      `stall-evidence: detector did not fire for framework '${args.framework}', ` +
        `stall-class '${args.classId}' — the fixture no longer matches the real detector logic`,
    );
  }
}
