/**
 * An enforcement ref may not escape the project root.
 *
 * `FILE_RE`'s character class permits `.` and `/`, so it permitted `..` — and every
 * extracted ref is joined onto `projectDir` and existence-probed, with the boolean
 * echoed back in `danglingRefs`. That made registry prose an existence oracle for paths
 * outside the project. Authorship is narrow (whoever ships a release writes the packed
 * constitution), which is why this is low severity rather than none — but it was free to
 * close, and it contradicted the resolver module's own contract that exactly one place
 * constructs a registry-adjacent path.
 *
 * The subtle part, and the reason the prefix allowlist was not already enough: a prefix
 * match is satisfied by `tests/../../../etc/x.json`. Containment has to be tested BEFORE
 * the prefix, not after it.
 */
import { describe, it, expect } from 'vitest';
import {
  extractEnforcementRefs,
  isContainedRef,
} from '../../src/core/StandardEnforcementExtractor.js';

function article(appliedThrough: string) {
  return { name: 'X', family: 'F', rule: 'r', appliedThrough } as never;
}

describe('enforcement refs are contained to the project root', () => {
  it('drops a traversal ref while keeping the legitimate one beside it', () => {
    const refs = extractEnforcementRefs(
      article('Enforced by `tests/../../../../etc/hosts.json` and `tests/unit/real.test.ts`.'),
    );
    expect(refs.files).not.toContain('tests/../../../../etc/hosts.json');
    // The legitimate ref in the SAME sentence still resolves — a containment check that
    // dropped everything on one bad neighbour would be its own defect.
    expect(refs.files).toContain('tests/unit/real.test.ts');
  });

  it('a traversal that also satisfies the prefix allowlist is still refused', () => {
    // The case a prefix-only check waves through, and the reason containment must run
    // first: this starts with `tests/`, so `isEnforcementPath` accepted it on prefix alone.
    const refs = extractEnforcementRefs(article('Enforced by `tests/../../../../tmp/probe.json`.'));
    expect(refs.files).toEqual([]);
  });

  it('refuses every ABSOLUTE form — they escape without containing ".."', () => {
    // Three shapes, because the first draft caught only two. Codey's review named UNC,
    // which reaches a remote root with no drive letter and no "..".
    expect(isContainedRef('/etc/passwd'), 'POSIX absolute').toBe(false);
    expect(isContainedRef('C:\\Windows\\x.json'), 'Windows drive root, backslash').toBe(false);
    expect(isContainedRef('C:/Windows/x.json'), 'Windows drive root, forward slash').toBe(false);
    expect(isContainedRef('\\\\server\\share\\x.json'), 'UNC').toBe(false);
    expect(isContainedRef('//server/share/x.json'), 'UNC, forward slashes').toBe(false);
    // And the false-positive guard: a legitimate relative ref must still pass, or this
    // predicate would silently drop every real enforcement ref it is meant to admit.
    expect(isContainedRef('tests/unit/a.test.ts'), 'ordinary relative ref').toBe(true);
    expect(isContainedRef('src/core/C.ts'), 'a capital letter is not a drive root').toBe(true);
  });

  it('isContainedRef judges the segment, not the substring', () => {
    // `..` as a SEGMENT escapes; `..` inside a name does not. A substring check would
    // reject the second, which is a legitimate filename shape.
    expect(isContainedRef('tests/unit/a.test.ts')).toBe(true);
    expect(isContainedRef('src/core/my..weird.name.ts')).toBe(true);
    expect(isContainedRef('tests/../secrets.json')).toBe(false);
    expect(isContainedRef('../outside.json')).toBe(false);
  });
});
