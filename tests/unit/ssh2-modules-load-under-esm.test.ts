/**
 * The mutual-SSH / peer-execution modules must actually LOAD under Node's ESM loader.
 *
 * INCIDENT (2026-07-26). Two inter-agent channels were down. One was the relay
 * (see relayConnectionObserver). The other was mutual-SSH, and it had been failing
 * at EVERY server boot, warning-level only, surfaced nowhere:
 *
 *   [mutual-ssh] initialization blocked: The requested module 'ssh2' does not
 *     provide an export named 'Server'
 *   [peer-execution] disabled-grant cleanup blocked: Named export 'utils' not
 *     found. The requested module 'ssh2' is a CommonJS module...
 *
 * `ssh2` is CommonJS. It genuinely has `Server`, `utils` and `Client` as runtime
 * properties, but Node's ESM loader cannot statically detect them, so a NAMED value
 * import throws at module-load time. Five files did exactly that, so five modules
 * threw on import and the whole channel silently never initialised.
 *
 * ── WHY THIS IS A SOURCE SCAN AND NOT AN IMPORT TEST ────────────────────────────
 *
 * The obvious guard — import each module and assert it does not throw — was written
 * first, passed, and was WRONG. Reverting a file to the broken named import left all
 * eight assertions green:
 *
 *   $ npx vitest run tests/unit/ssh2-modules-load-under-esm.test.ts
 *     ✓ tests/unit/ssh2-modules-load-under-esm.test.ts (8 tests)   # against BROKEN source
 *
 *   $ node --input-type=module -e "import { Server } from 'ssh2';"
 *     SyntaxError: Named export 'Server' not found. The requested module 'ssh2' is
 *     a CommonJS module, which may not support all module.exports as named exports.
 *
 * Vitest transforms modules through Vite, which rewrites CJS interop so a named
 * import resolves. Production runs the compiled output under Node's own ESM loader,
 * which does not. So an in-process import assertion is STRUCTURALLY INCAPABLE of
 * observing this bug class — it does not merely miss it, it cannot see it. `tsc`
 * is equally blind (exit 0 against the broken source), because the TYPES are real;
 * only the runtime binding is not.
 *
 * That leaves a source scan. It is a text check, with a text check's known weakness
 * — prose that *describes* a forbidden shape can trip it. That is mitigated by
 * stripping comments and string literals before matching, and by asserting on
 * import statements only. The trade is deliberate and is the honest one: a scan that
 * really fires beats an import test that reads better and proves nothing.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/**
 * Packages that are CommonJS at runtime, so a named VALUE import throws under Node
 * ESM even though TypeScript accepts it. Add to this list when a new CJS dependency
 * is introduced; the scan then covers every file at once.
 */
const CJS_ONLY_PACKAGES = ['ssh2'] as const;

/** Remove comments and string literals so prose describing a bad import cannot trip the scan. */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => {
      // Preserve the module specifier itself — it is what we match on.
      return CJS_ONLY_PACKAGES.some((p) => m === `'${p}'` || m === `"${p}"`) ? m : "''";
    });
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface Offence { file: string; statement: string; pkg: string; }

function findNamedValueImports(): Offence[] {
  const offences: Offence[] = [];
  for (const file of walkTsFiles(SRC_DIR)) {
    const code = stripNonCode(fs.readFileSync(file, 'utf-8'));
    for (const pkg of CJS_ONLY_PACKAGES) {
      // `import { X } from 'pkg'` / `import X, { Y } from 'pkg'` — but NOT `import type { X }`,
      // which is erased at compile time and therefore safe.
      const re = new RegExp(`import\\s+(?!type\\s)[^;]*?\\{[^}]*\\}[^;]*?from\\s*['"]${pkg}['"]`, 'g');
      for (const match of code.matchAll(re)) {
        if (/\{\s*type\s/.test(match[0]) && !/\{[^}]*[A-Za-z_$][^}]*\}/.test(match[0].replace(/type\s+\w+/g, ''))) {
          continue; // inline `{ type Foo }` only — still type-erased
        }
        offences.push({ file: path.relative(SRC_DIR, file), statement: match[0].trim(), pkg });
      }
    }
  }
  return offences;
}

describe('CommonJS packages are never named-value-imported under ESM', () => {
  it('REGRESSION: no source file takes a named value import from a CJS-only package', () => {
    const offences = findNamedValueImports();
    expect(
      offences,
      offences.length
        ? `Named value import from a CommonJS package — this throws at load under Node ESM ` +
          `(tsc and vitest both pass it). Use \`import pkg from '${offences[0].pkg}'\` then destructure.\n` +
          offences.map((o) => `  ${o.file}: ${o.statement}`).join('\n')
        : '',
    ).toEqual([]);
  });

  it('the values ssh2 is used for are reachable the way the source now takes them', async () => {
    const ssh2 = (await import('ssh2')).default;
    expect(typeof ssh2.Server).toBe('function');
    expect(typeof ssh2.Client).toBe('function');
    expect(typeof ssh2.utils).toBe('object');
    expect(typeof ssh2.utils.parseKey).toBe('function');
  });

  /**
   * Dead-check guards. The assertion above passes trivially against a scanner that
   * finds nothing because it is broken — an empty walk, a regex that matches
   * nothing, or a strip step that deletes the whole file. Each is checked.
   */
  it('the scanner actually reads the tree it claims to scan', () => {
    const files = walkTsFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('MachineSshEndpoint.ts'))).toBe(true);
  });

  it('the scanner DETECTS the exact statement this incident shipped', () => {
    // The pre-fix line from src/core/MachineSshEndpoint.ts, verbatim.
    const bad = "import { Server, utils, type Connection } from 'ssh2';";
    const re = new RegExp(`import\\s+(?!type\\s)[^;]*?\\{[^}]*\\}[^;]*?from\\s*['"]ssh2['"]`);
    expect(re.test(stripNonCode(bad))).toBe(true);
  });

  it('the scanner ALLOWS the two safe forms — it is not a blanket ban on the word', () => {
    const re = new RegExp(`import\\s+(?!type\\s)[^;]*?\\{[^}]*\\}[^;]*?from\\s*['"]ssh2['"]`);
    // Default import: the fix.
    expect(re.test(stripNonCode("import ssh2 from 'ssh2';"))).toBe(false);
    // Type-only import: erased at compile time, cannot throw at runtime.
    expect(re.test(stripNonCode("import type { Connection, Server } from 'ssh2';"))).toBe(false);
  });

  it('comments and strings describing a bad import do not trip the scan', () => {
    // This file's own header contains the forbidden shape. If stripping regressed,
    // the scan would flag innocent files for merely documenting the hazard.
    const prose = `
      // import { Server } from 'ssh2';
      /* the old line was: import { Server, utils } from 'ssh2'; */
      const doc = "import { Server } from 'ssh2';";
      import ssh2 from 'ssh2';
    `;
    const re = new RegExp(`import\\s+(?!type\\s)[^;]*?\\{[^}]*\\}[^;]*?from\\s*['"]ssh2['"]`, 'g');
    expect([...stripNonCode(prose).matchAll(re)]).toHaveLength(0);
  });
});
