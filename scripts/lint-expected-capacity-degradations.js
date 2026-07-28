#!/usr/bin/env node
// safe-git-allow: read-only merge-base/show establish the removal ratchet.
/** Mechanical contract lint for bounded-storage outcome classification. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'docs/capacity-enforcement-contracts.json';
const MARKER_RE = /capacity-enforcement-contract:\s*([a-z0-9][a-z0-9-]*)@(\d+)/g;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function validRelativeSource(value) {
  return typeof value === 'string' && value.startsWith('src/') && !path.isAbsolute(value) && !value.split('/').includes('..');
}

function parseRegistry(raw, label) {
  const findings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { findings: [{ code: 'registry-shape', file: label }], contracts: [], retiredContracts: [] };
  if (raw.version !== 1) findings.push({ code: 'registry-version', file: label });
  if (!Array.isArray(raw.contracts) || raw.contracts.length === 0) findings.push({ code: 'contracts-nonempty', file: label });
  if (raw.retiredContracts !== undefined && !Array.isArray(raw.retiredContracts)) findings.push({ code: 'retired-contracts-shape', file: label });
  const contracts = Array.isArray(raw.contracts) ? raw.contracts : [];
  const retiredContracts = Array.isArray(raw.retiredContracts) ? raw.retiredContracts : [];
  const ids = new Set();
  for (const contract of contracts) {
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) { findings.push({ code: 'contract-shape', file: label }); continue; }
    if (typeof contract.id !== 'string' || !ID_RE.test(contract.id)) findings.push({ code: 'contract-id', file: label, contract: contract.id });
    if (ids.has(contract.id)) findings.push({ code: 'duplicate-contract-id', file: label, contract: contract.id });
    ids.add(contract.id);
    if (!Number.isInteger(contract.revision) || contract.revision < 1) findings.push({ code: 'contract-revision', file: label, contract: contract.id });
    if (!validRelativeSource(contract.sourcePath)) findings.push({ code: 'contract-source-path', file: label, contract: contract.id });
    if (contract.outcomeType !== 'CapacityEnforcementResult') findings.push({ code: 'contract-outcome-type', file: label, contract: contract.id });
    for (const field of ['durableOutcomeBinding', 'aggregateOutcomeBinding']) {
      if (typeof contract[field] !== 'string' || contract[field].trim() === '') findings.push({ code: 'contract-binding', field, file: label, contract: contract.id });
    }
    if (!Array.isArray(contract.requiredSymbols) || contract.requiredSymbols.length === 0 || contract.requiredSymbols.some((v) => typeof v !== 'string' || v.length === 0)) {
      findings.push({ code: 'contract-required-symbols', file: label, contract: contract.id });
    }
  }
  for (const retired of retiredContracts) {
    if (!retired || typeof retired !== 'object' || !ID_RE.test(retired.id ?? '') || !Number.isInteger(retired.revision) || retired.revision < 1 ||
        typeof retired.retiredAt !== 'string' || Number.isNaN(Date.parse(retired.retiredAt)) || typeof retired.reason !== 'string' || retired.reason.trim() === '' ||
        typeof retired.reviewRef !== 'string' || retired.reviewRef.trim() === '') {
      findings.push({ code: 'retired-contract-shape', file: label, contract: retired?.id });
    }
    if (ids.has(retired?.id)) findings.push({ code: 'active-retired-id-collision', file: label, contract: retired?.id });
    ids.add(retired?.id);
  }
  return { findings, contracts, retiredContracts };
}

function readBaseRegistry(root, explicitBase) {
  let base = explicitBase;
  if (!base) {
    for (const candidate of ['upstream/main', 'origin/main']) {
      try { base = execFileSync('git', ['merge-base', 'HEAD', candidate], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); break; }
      catch { /* try next read-only candidate */ }
    }
  }
  if (!base) return null;
  try {
    const text = execFileSync('git', ['show', `${base}:${REGISTRY}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(text);
  } catch { return null; }
}

export function validateCapacityEnforcementContracts(root = ROOT, opts = {}) {
  const registryPath = path.join(root, REGISTRY);
  if (!fs.existsSync(registryPath)) return [{ code: 'registry-missing', file: REGISTRY }];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
  catch { return [{ code: 'registry-invalid-json', file: REGISTRY }]; }
  const parsed = parseRegistry(raw, REGISTRY);
  const findings = [...parsed.findings];
  const byKey = new Map(parsed.contracts.map((c) => [`${c.id}@${c.revision}`, c]));

  const markers = [];
  for (const file of walk(path.join(root, 'src'))) {
    const relative = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(MARKER_RE)) markers.push({ key: `${match[1]}@${match[2]}`, file: relative });
  }
  const markerCounts = new Map();
  for (const marker of markers) {
    markerCounts.set(marker.key, (markerCounts.get(marker.key) ?? 0) + 1);
    const contract = byKey.get(marker.key);
    if (!contract) findings.push({ code: 'unregistered-source-marker', contract: marker.key, file: marker.file });
    else if (contract.sourcePath !== marker.file) findings.push({ code: 'marker-path-mismatch', contract: marker.key, file: marker.file });
  }
  for (const [key, count] of markerCounts) if (count !== 1) findings.push({ code: 'duplicate-source-marker', contract: key, count });

  for (const [key, contract] of byKey) {
    const full = path.join(root, contract.sourcePath);
    if (!fs.existsSync(full)) { findings.push({ code: 'source-missing', contract: key, file: contract.sourcePath }); continue; }
    const source = fs.readFileSync(full, 'utf8');
    if (markerCounts.get(key) !== 1) findings.push({ code: 'marker-missing-or-duplicate', contract: key, file: contract.sourcePath });
    const bindings = [
      contract.outcomeType,
      contract.durableOutcomeBinding,
      contract.aggregateOutcomeBinding,
      ...(contract.requiredSymbols ?? []),
      `@unexpected-capacity-degradation contract=${key}`,
    ];
    for (const binding of bindings) if (typeof binding === 'string' && !source.includes(binding)) findings.push({ code: 'required-binding-missing', contract: key, file: contract.sourcePath, binding });
  }

  const baseRaw = opts.baseRegistry === undefined ? readBaseRegistry(root, opts.diffBase) : opts.baseRegistry;
  if (baseRaw) {
    const base = parseRegistry(baseRaw, 'diff-base');
    const activeIds = new Set(parsed.contracts.map((c) => c.id));
    const retiredById = new Map(parsed.retiredContracts.map((c) => [c.id, c]));
    for (const old of base.contracts) {
      if (activeIds.has(old.id)) continue;
      const tombstone = retiredById.get(old.id);
      if (!tombstone || tombstone.revision < old.revision) findings.push({ code: 'contract-removal-without-reviewed-retirement', contract: old.id });
    }
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootArg = args.indexOf('--root');
  const baseArg = args.indexOf('--diff-base');
  const root = rootArg >= 0 && args[rootArg + 1] ? path.resolve(args[rootArg + 1]) : ROOT;
  const findings = validateCapacityEnforcementContracts(root, { diffBase: baseArg >= 0 ? args[baseArg + 1] : undefined });
  if (findings.length === 0) { console.log('[capacity-enforcement-contracts] PASS'); process.exit(0); }
  console.error('[capacity-enforcement-contracts] Contract violations:');
  for (const finding of findings) console.error(`  ${JSON.stringify(finding)}`);
  process.exit(1);
}
