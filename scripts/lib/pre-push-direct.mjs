import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { LOCAL_VERIFY_SMOKE_LADDER, LOCAL_VERIFY_SMOKE_SOURCE, LOCAL_VERIFY_SMOKE_TEST, supportsDirectSmoke } from './pre-push-scope.mjs';
const WIRING = [
  'tests/integration/local-verify-routes.test.ts',
  'tests/integration/local-verify-peer-routes.test.ts',
];

function importedPaths(contents, test) {
  const directory = path.posix.dirname(test);
  return ts.preProcessFile(contents, true, true).importedFiles.flatMap(({ fileName }) => {
    if (!fileName.startsWith('.')) return [];
    const resolved = path.posix.normalize(path.posix.join(directory, fileName));
    return [
      resolved,
      resolved.replace(/\.([cm]?)js$/, '.$1ts'),
      resolved + '.ts',
      resolved + '/index.ts',
    ];
  });
}

export function mandatoryDirectSmokeFiles(changed) {
  const files = [...WIRING, ...changed.filter(file => LOCAL_VERIFY_SMOKE_TEST.test(file))];
  if (changed.includes(LOCAL_VERIFY_SMOKE_LADDER)) files.push('tests/unit/feature-ladders-coverage.test.ts');
  return files;
}

/** Keep every required check, then add whole test files within the existing case budget. */
export function boundDirectSmokeCases(changed, casesByFile, root, maxCases) {
  const required = new Set(mandatoryDirectSmokeFiles(changed).map(file => path.join(root, file)));
  const files = [...required];
  let cases = 0;
  for (const file of files) {
    if (!casesByFile[file]) return null;
    cases += casesByFile[file];
  }
  if (cases > maxCases) return null;

  const unitPrefix = path.join(root, 'tests', 'unit') + path.sep;
  const optional = Object.keys(casesByFile).filter(file => !required.has(file)).sort((a, b) =>
    Number(b.startsWith(unitPrefix)) - Number(a.startsWith(unitPrefix)) || a.localeCompare(b));
  for (const file of optional) {
    const count = casesByFile[file];
    if (cases + count > maxCases) continue;
    cases += count;
    files.push(file);
  }
  return { files: files.sort(), cases };
}

/** A local smoke sample. Shared verification still runs the full test inventory. */
export function selectDirectSmokeFiles(changed, candidates, root, tracked, read = fs.readFileSync) {
  if (!supportsDirectSmoke(changed) || !tracked) return null;
  const changedSources = new Set(changed.filter(file => file.startsWith(LOCAL_VERIFY_SMOKE_SOURCE)));
  const required = new Set(mandatoryDirectSmokeFiles(changed));
  const selected = [];
  let foundDirectConsumer = false;
  for (const absolute of candidates) {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) return null;
    if (!tracked.has(relative)) continue;
    const requiredHere = required.delete(relative);
    let imports;
    try { imports = importedPaths(read(absolute, 'utf8'), relative); } catch { return null; }
    const isConsumer = imports.some(file => changedSources.has(file));
    if (isConsumer) foundDirectConsumer = true;
    if (requiredHere || isConsumer) selected.push(absolute);
  }
  return required.size === 0 && foundDirectConsumer ? selected.sort() : null;
}
