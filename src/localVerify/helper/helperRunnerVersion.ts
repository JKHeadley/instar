/**
 * The helper's RUNNER VERSION (docs/specs/local-verify-borrowed-slices-count.md, Build decisions
 * "Version means the helper's runner version"): a content hash of the helper's own runner and
 * sandbox-driver source, computed the way the verifier's version is (../verifierVersion.ts).
 *
 * Instar's release number moves several times a day and says nothing about how a helper runs a
 * test, so it is not used. This hash changes exactly when something that shapes a helper's
 * results changes: then learned-list trials run again (learnedList.ts), the "compared on" record
 * starts over (comparedFiles.ts), and the run machine resets that helper's evidence.
 *
 * Inputs, hashed in a fixed order:
 *  - the REAL local import graph (type-only imports skipped, as the build erases them) from the
 *    helper service and the sandbox drivers (RUNNER_ROOTS), by package-relative path and content;
 *  - the files that run INSIDE the sandbox (RUNNER_TEMPLATES): the root-owned runner, the check
 *    script, the progress reporter and the sandbox property probe.
 * Not inputs: the files that shape the sandbox's walls and size (the Lima template, wsl.conf, the
 * egress rules, the provisioning script). Those are the sandbox settings' hash, part of the image
 * identity (runnerDriverBase.ts `sandboxSettingsHash`), which resets evidence by its own rule.
 * Nothing ambient is hashed (no node version of the host: tests run on the sandbox's pinned node,
 * which the provisioning script names).
 *
 * Works on an install (`dist/**.js`) and from source (`src/**.ts`); the two give different
 * values, as the verifier's version does.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localImportGraph } from '../verifierVersion.js';
import { helperTemplatePath } from './runnerDriverBase.js';

/** The graph roots: the service that runs slices and builds answers, and every sandbox driver. */
export const RUNNER_ROOTS: readonly string[] = Object.freeze(['HelperService', 'runnerDriverBase', 'limaDriver', 'wslDriver', 'sandboxDriver']);

/** The shipped files that run inside the sandbox. */
export const RUNNER_TEMPLATES: readonly string[] = Object.freeze([
  'instar-helper-runner.sh', 'instar-helper-checks.sh', 'instar-helper-progress-reporter.mjs', 'instar-helper-property-probe.cjs',
]);

function rootFile(dir: string, name: string): string | null {
  for (const ext of ['.js', '.ts']) {
    const f = path.join(dir, name + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** The directory this module was loaded from (the installed helper code). */
export function installedHelperDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export interface RunnerVersionInputs {
  /** Override for tests: read one sandbox-side file by its template name. */
  readTemplate?: (name: string) => string;
}

/**
 * `hr1:<hex>` over the helper's local import graph and its sandbox-side files. Deterministic:
 * package-relative paths in sorted order, each file framed by its path.
 */
export function computeHelperRunnerVersion(dir: string = installedHelperDir(), inputs: RunnerVersionInputs = {}): string {
  const roots = RUNNER_ROOTS.map((n) => rootFile(dir, n)).filter((f): f is string => f !== null);
  const files = localImportGraph(roots);
  const root = path.resolve(dir, '..', '..', '..');
  const read = inputs.readTemplate ?? ((n: string) => fs.readFileSync(helperTemplatePath(n), 'utf-8'));
  const h = crypto.createHash('sha256');
  h.update('local-verify-helper-runner-v1\0');
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    h.update(`file:${rel}\0`);
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  for (const n of RUNNER_TEMPLATES) {
    h.update(`template:${n}\0`);
    h.update(read(n));
    h.update('\0');
  }
  return `hr1:${h.digest('hex').slice(0, 32)}`;
}
