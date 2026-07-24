#!/usr/bin/env node
// safe-git-allow: pre-commit bootstrap uses read-only diff/show before TypeScript is compiled.
/**
 * Structural ratchet for the Migration-Consumer Completeness standard.
 *
 * The manifest names every enrolled canonical migration producer, every
 * authorization/validation consumer of that authority, and the tests that
 * validate the compatibility boundary. Role markers bind those declarations to
 * actual files. Staged/CI diff mode treats any producer or consumer edit as a
 * contract revision: the manifest revision must increase and every declared
 * producer, consumer, and validator must acknowledge that revision in lockstep.
 *
 * This lint is deliberately mechanical. It proves that the declared dependency
 * set moved in lockstep; review remains the semantic authority for deciding
 * whether the declaration itself is complete.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = 'docs/canonical-migration-contracts.json';
const MARKER_RE = /canonical-migration-(producer|consumer|validator):\s*([a-z0-9][a-z0-9-]*)@(\d+)/g;
const SCAN_ROOTS = ['src', 'tests', 'docs'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md']);

/** @typedef {'producer'|'consumer'|'validator'} MigrationRole */
/**
 * @typedef MigrationContract
 * @property {string} id
 * @property {number} revision
 * @property {string[]} producers
 * @property {string[]} consumers
 * @property {string[]} validators
 */
/** @typedef {{role: MigrationRole, id: string, revision: number, path: string}} MigrationMarker */
/** @typedef {{rule: string, message: string, id?: string, path?: string}} Finding */

const roleField = /** @type {const} */ ({
  producer: 'producers',
  consumer: 'consumers',
  validator: 'validators',
});

/** @param {unknown} manifest @returns {Finding[]} */
export function validateMigrationManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return [{ rule: 'MCC0-manifest-shape', message: 'manifest must be an object' }];
  }
  const candidate = /** @type {{schemaVersion?: unknown, contracts?: unknown}} */ (manifest);
  if (candidate.schemaVersion !== 1) {
    return [{ rule: 'MCC0-manifest-shape', message: 'schemaVersion must equal 1' }];
  }
  if (!Array.isArray(candidate.contracts) || candidate.contracts.length === 0) {
    return [{ rule: 'MCC0-manifest-shape', message: 'contracts must be a non-empty array' }];
  }
  return [];
}

/**
 * @param {{contracts: MigrationContract[], baseContracts?: MigrationContract[], markers: MigrationMarker[], changedFiles: Set<string>, pathExists: (path: string) => boolean}} input
 * @returns {Finding[]}
 */
export function auditMigrationConsumerCompleteness(input) {
  const findings = [];
  const contractsById = new Map();

  for (const contract of input.contracts) {
    if (!contract?.id || contractsById.has(contract.id)) {
      findings.push({
        rule: 'MCC0-invalid-contract-id',
        id: contract?.id,
        message: `contract id must be non-empty and unique: ${contract?.id ?? '(missing)'}`,
      });
      continue;
    }
    contractsById.set(contract.id, contract);
    if (!Number.isInteger(contract.revision) || contract.revision < 1) {
      findings.push({ rule: 'MCC0-invalid-revision', id: contract.id, message: `${contract.id}.revision must be a positive integer` });
    }
    for (const field of ['producers', 'consumers', 'validators']) {
      if (!Array.isArray(contract[field])) {
        findings.push({ rule: 'MCC0-invalid-contract-shape', id: contract.id, message: `${contract.id}.${field} must be an array` });
      }
    }
    if (!Array.isArray(contract.producers) || contract.producers.length === 0) {
      findings.push({ rule: 'MCC0-producer-required', id: contract.id, message: `${contract.id} must declare at least one producer` });
    }
    if (!Array.isArray(contract.consumers) || contract.consumers.length === 0) {
      findings.push({ rule: 'MCC2-consumer-required', id: contract.id, message: `${contract.id} must declare at least one consumer` });
    }
    if (!Array.isArray(contract.validators) || contract.validators.length === 0) {
      findings.push({ rule: 'MCC3-validator-required', id: contract.id, message: `${contract.id} must declare at least one validator` });
    }
  }

  const markersByKey = new Map();
  for (const marker of input.markers) {
    const key = `${marker.id}\0${marker.role}\0${marker.path}`;
    markersByKey.set(key, marker);
    const contract = contractsById.get(marker.id);
    if (!contract) {
      findings.push({
        rule: 'MCC1-unregistered-marker', id: marker.id, path: marker.path,
        message: `${marker.path} declares ${marker.role} for unregistered migration ${marker.id}`,
      });
      continue;
    }
    const field = roleField[marker.role];
    if (!contract[field]?.includes(marker.path)) {
      findings.push({
        rule: 'MCC4-marker-contract-mismatch', id: marker.id, path: marker.path,
        message: `${marker.path} carries a ${marker.role} marker but is absent from ${marker.id}.${field}`,
      });
    }
    if (marker.revision !== contract.revision) {
      findings.push({
        rule: 'MCC5-stale-role-revision', id: marker.id, path: marker.path,
        message: `${marker.path} acknowledges ${marker.id}@${marker.revision}, expected @${contract.revision}`,
      });
    }
  }

  for (const contract of input.contracts) {
    for (const role of /** @type {MigrationRole[]} */ (['producer', 'consumer', 'validator'])) {
      const field = roleField[role];
      for (const declaredPath of contract[field] ?? []) {
        if (!input.pathExists(declaredPath)) {
          findings.push({
            rule: 'MCC4-declared-path-missing', id: contract.id, path: declaredPath,
            message: `${contract.id}.${field} names missing path ${declaredPath}`,
          });
        }
        const key = `${contract.id}\0${role}\0${declaredPath}`;
        if (!markersByKey.has(key)) {
          findings.push({
            rule: 'MCC5-missing-role-marker', id: contract.id, path: declaredPath,
            message: `${declaredPath} must carry canonical-migration-${role}: ${contract.id}@${contract.revision}`,
          });
        }
      }
    }

  }

  if (input.baseContracts) {
    const baseById = new Map(input.baseContracts.map((contract) => [contract.id, contract]));
    for (const base of input.baseContracts) {
      if (!contractsById.has(base.id)) {
        findings.push({
          rule: 'MCC8-contract-removal-forbidden', id: base.id,
          message: `${base.id} existed at the diff base and cannot be silently removed`,
        });
      }
      const head = contractsById.get(base.id);
      if (!head) continue;
      for (const role of /** @type {MigrationRole[]} */ (['producer', 'consumer', 'validator'])) {
        const field = roleField[role];
        for (const basePath of base[field] ?? []) {
          if (!(head[field] ?? []).includes(basePath)) {
            findings.push({
              rule: 'MCC8-role-removal-forbidden', id: base.id, path: basePath,
              message: `${base.id}.${field} cannot silently remove ${basePath}; retire the contract in a separately reviewed migration`,
            });
          }
        }
      }
    }
    for (const contract of input.contracts) {
      const base = baseById.get(contract.id);
      const authorityChanged = [...(contract.producers ?? []), ...(contract.consumers ?? [])]
        .some((file) => input.changedFiles.has(file));
      const revisionChanged = !base || contract.revision !== base.revision;
      if (base && authorityChanged && contract.revision <= base.revision) {
        findings.push({
          rule: 'MCC6-revision-bump-required', id: contract.id,
          message: `${contract.id} producer/consumer surface changed without increasing revision above ${base.revision}`,
        });
      }
      if (base && contract.revision < base.revision) {
        findings.push({
          rule: 'MCC6-revision-regression', id: contract.id,
          message: `${contract.id} revision regressed from ${base.revision} to ${contract.revision}`,
        });
      }
      if (!revisionChanged) continue;
      for (const role of /** @type {MigrationRole[]} */ (['producer', 'consumer', 'validator'])) {
        for (const declaredPath of contract[roleField[role]] ?? []) {
          if (!input.changedFiles.has(declaredPath)) {
            findings.push({
              rule: role === 'validator' ? 'MCC7-lockstep-validator' : 'MCC6-lockstep-authority',
              id: contract.id,
              path: declaredPath,
              message: `${contract.id}@${contract.revision} revision changed without lockstep ${role} acknowledgement in ${declaredPath}`,
            });
          }
        }
      }
    }
  }

  return findings;
}

/** @param {string} root */
function scanMarkers(root) {
  /** @type {MigrationMarker[]} */
  const markers = [];
  const visit = (relativeDir) => {
    const absoluteDir = path.join(root, relativeDir);
    if (!fs.existsSync(absoluteDir)) return;
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) visit(relativePath);
        continue;
      }
      if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
      const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
      MARKER_RE.lastIndex = 0;
      let match;
      while ((match = MARKER_RE.exec(text)) !== null) {
        markers.push({ role: /** @type {MigrationRole} */ (match[1]), id: match[2], revision: Number(match[3]), path: relativePath });
      }
    }
  };
  for (const scanRoot of SCAN_ROOTS) visit(scanRoot);
  return markers;
}

/** @param {string} root @param {string[]} args */
function diffContext(root, args) {
  let gitArgs = null;
  let base = null;
  const baseIndex = args.indexOf('--diff-base');
  if (args.includes('--staged')) {
    base = 'HEAD';
    gitArgs = ['diff', '--cached', '--name-only', '--diff-filter=ACMR'];
  } else if (baseIndex >= 0 && args[baseIndex + 1]) {
    base = args[baseIndex + 1];
    gitArgs = ['diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD'];
  }
  if (!gitArgs) return { changedFiles: new Set(), baseContracts: undefined };
  const output = execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
  let baseContracts = [];
  try {
    const raw = execFileSync('git', ['show', `${base}:${MANIFEST_PATH}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.contracts)) baseContracts = parsed.contracts;
  } catch { /* first registry ship: no base manifest */ }
  return {
    changedFiles: new Set(output.split('\n').map((line) => line.trim()).filter(Boolean)),
    baseContracts,
  };
}

function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 && args[rootIndex + 1] ? path.resolve(args[rootIndex + 1]) : SCRIPT_ROOT;
  const manifestAbsolute = path.join(root, MANIFEST_PATH);
  if (!fs.existsSync(manifestAbsolute)) {
    console.error(`MCC0-manifest-missing: ${MANIFEST_PATH}`);
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestAbsolute, 'utf8'));
  } catch (error) {
    console.error(`MCC0-manifest-invalid: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const shapeFindings = validateMigrationManifest(manifest);
  if (shapeFindings.length > 0) {
    console.error(`${shapeFindings[0].rule}: ${shapeFindings[0].message}`);
    process.exit(1);
  }
  const diff = diffContext(root, args);
  const findings = auditMigrationConsumerCompleteness({
    contracts: manifest.contracts,
    baseContracts: diff.baseContracts,
    markers: scanMarkers(root),
    changedFiles: diff.changedFiles,
    pathExists: (relativePath) => fs.existsSync(path.join(root, relativePath)),
  });
  if (findings.length === 0) {
    console.log('lint-migration-consumer-completeness: clean');
    return;
  }
  console.error(`lint-migration-consumer-completeness: ${findings.length} finding(s)`);
  for (const finding of findings) {
    console.error(`  ${finding.rule}${finding.path ? ` ${finding.path}` : ''}: ${finding.message}`);
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
