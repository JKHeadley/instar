#!/usr/bin/env node
/**
 * Stage-B certified-set fingerprint (spec: stage-b-evidence-code-binding).
 *
 * The release gate binds the approved canary evidence to the CODE it certified,
 * not to a version number. This tool owns the code side of that binding:
 *
 *   --check   Recompute the certified set's transitive relative-import closure
 *             and fingerprint; fail (exit 1) naming per-file drift, any closure
 *             member that is neither certified nor excluded-with-reason, and
 *             any stale manifest entry. Run by the publish gate and pre-push.
 *   --write   Rebind the manifest. STRUCTURALLY refuses the dishonest rebind:
 *             if the fingerprint changed, the bundled artifact's canonical
 *             digest must ALSO have changed (fresh evidence) — old evidence can
 *             never be re-stamped onto changed code.
 *
 * The fingerprint has no adversarial value (everything here is editable in one
 * PR, exactly like the verifier itself); it exists to catch HONEST drift and to
 * make every coverage cut an enumerated, reviewed record.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(root, 'src', 'data', 'stageBCertifiedSet.ts');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

export function relativeImportClosure(rootDir, roots) {
  const seen = new Set();
  const work = [...roots];
  while (work.length) {
    const rel = work.pop();
    if (seen.has(rel)) continue;
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) { seen.add(rel); continue; } // reported by the partition check
    seen.add(rel);
    const src = fs.readFileSync(abs, 'utf8');
    // Every relative-specifier form: static import/export-from (either quote),
    // side-effect import, dynamic import(), and require(). Fail-closed claim
    // depends on this breadth — a form the matcher misses escapes coverage.
    const specs = [];
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*(['"])(\.[^'"]+)\1/g)) specs.push(m[2]);
    for (const m of src.matchAll(/require\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g)) specs.push(m[2]);
    for (const spec of specs) {
      let dep = spec.replace(/\.js$/, '.ts');
      let depAbs = path.normalize(path.join(path.dirname(abs), dep));
      if (!fs.existsSync(depAbs) && fs.existsSync(depAbs.replace(/\.ts$/, '/index.ts'))) {
        depAbs = depAbs.replace(/\.ts$/, '/index.ts');
      }
      work.push(path.relative(rootDir, depAbs).split(path.sep).join('/'));
    }
  }
  return [...seen].sort();
}

export function certifiedFingerprint(rootDir, certified) {
  const h = crypto.createHash('sha256');
  for (const rel of [...certified].sort()) {
    h.update(sha256(Buffer.from(rel, 'utf8')));
    h.update(sha256(fs.readFileSync(path.join(rootDir, rel))));
  }
  return h.digest('hex');
}

async function loadGateFromDist() {
  const dist = path.join(root, 'dist', 'core', 'StageBActivationGate.js');
  if (!fs.existsSync(dist)) {
    console.error('[stage-b-fingerprint] dist/core/StageBActivationGate.js missing — run npm run build first');
    process.exit(1);
  }
  return import(dist);
}

function readManifest() {
  // The manifest is a TS data module; parse its JSON payload between markers.
  const src = fs.readFileSync(MANIFEST, 'utf8');
  const m = src.match(/STAGE_B_CERTIFIED_SET[^=]*=\s*(\{[\s\S]*\})\s*as const/);
  if (!m) throw new Error(`cannot parse ${MANIFEST}`);
  return JSON.parse(m[1]);
}

function writeManifest(data) {
  const body = JSON.stringify(data, null, 2);
  fs.writeFileSync(MANIFEST, `/**
 * Stage-B certified-set manifest (spec: stage-b-evidence-code-binding).
 * Maintained ONLY by scripts/stage-b-certified-fingerprint.mjs --write, which
 * refuses to rebind old evidence onto changed code. Every closure member is
 * either certified (fingerprinted) or excluded with a written reason; the
 * --check partition is fail-closed for anything new.
 */
export const STAGE_B_CERTIFIED_SET = ${body} as const;

export type StageBCertifiedSet = typeof STAGE_B_CERTIFIED_SET;
`);
}

function partitionProblems(man, closure) {
  const problems = [];
  const certified = new Set(man.certified);
  const excluded = new Set(man.excluded.map((e) => e.file));
  for (const f of closure) {
    if (!certified.has(f) && !excluded.has(f)) problems.push(`unclassified closure member: ${f} — add it to certified, or to excluded with a reason`);
    if (certified.has(f) && excluded.has(f)) problems.push(`${f} is both certified and excluded`);
  }
  for (const f of man.certified) {
    if (!fs.existsSync(path.join(root, f))) problems.push(`certified file missing on disk: ${f}`);
    if (!closure.includes(f)) problems.push(`certified file no longer in the closure: ${f} — remove or re-root`);
  }
  for (const e of man.excluded) {
    if (!e.reason || e.reason.trim().length < 8) problems.push(`excluded entry without a real reason: ${e.file}`);
    if (!closure.includes(e.file)) problems.push(`excluded entry no longer in the closure: ${e.file} — remove the stale exclusion`);
  }
  return problems;
}

const mode = process.argv[2];
if (!['--check', '--write', '--init'].includes(mode ?? '')) {
  console.error('usage: stage-b-certified-fingerprint.mjs --check | --write | --init');
  process.exit(2);
}

const gateMod = await loadGateFromDist();
const shipped = gateMod.bundledStageBReleaseEvidence();
if (!shipped) { console.error('[stage-b-fingerprint] no bundled evidence'); process.exit(1); }
const evidenceDigest = gateMod.canonicalShippedArtifactDigest(shipped.artifact);

if (mode === '--init') {
  if (fs.existsSync(MANIFEST)) { console.error('[stage-b-fingerprint] manifest exists; use --write'); process.exit(1); }
  console.error('[stage-b-fingerprint] --init requires a hand-authored partition first; see the spec');
  process.exit(1);
}

const man = readManifest();
const closure = relativeImportClosure(root, man.roots);
const problems = partitionProblems(man, closure);
const fingerprint = certifiedFingerprint(root, man.certified.filter((f) => fs.existsSync(path.join(root, f))));

if (mode === '--check') {
  if (fingerprint !== man.fingerprint) {
    for (const f of man.certified) {
      const abs = path.join(root, f);
      if (fs.existsSync(abs) && man.fileHashes && man.fileHashes[f] && man.fileHashes[f] !== sha256(fs.readFileSync(abs))) {
        problems.push(`certified source drifted: ${f}`);
      }
    }
    problems.push(`fingerprint mismatch: manifest ${man.fingerprint.slice(0, 12)}… vs computed ${fingerprint.slice(0, 12)}… — the certified Stage-B code changed since the approved canary. Run and approve a fresh canary, embed its evidence, then rebind with --write.`);
  }
  if (evidenceDigest !== man.artifactDigest) {
    problems.push(`bundled evidence is not the artifact this manifest vouches for (digest ${evidenceDigest.slice(0, 12)}… vs manifest ${man.artifactDigest.slice(0, 12)}…) — rebind with --write.`);
  }
  if (problems.length) {
    console.error(`[stage-b-fingerprint] CHECK FAILED (${problems.length}):`);
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log(`[stage-b-fingerprint] OK — ${man.certified.length} certified, ${man.excluded.length} excluded (each with a reason), closure ${closure.length}, evidence ${evidenceDigest.slice(0, 12)}…`);
  process.exit(0);
}

// --write: rebind. Refuse re-stamping old evidence onto changed code.
if (problems.length) {
  console.error('[stage-b-fingerprint] refusing to write over an unresolved partition:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
if (fingerprint !== man.fingerprint && evidenceDigest === man.artifactDigest) {
  console.error('[stage-b-fingerprint] REFUSED: the certified code changed but the bundled evidence is the same artifact this manifest already vouches for.');
  console.error('  Old canary evidence cannot be re-stamped onto changed code. Run and approve a fresh canary, embed its signed evidence, then --write.');
  process.exit(1);
}
const fileHashes = {};
for (const f of man.certified) fileHashes[f] = sha256(fs.readFileSync(path.join(root, f)));
writeManifest({ ...man, fingerprint, artifactDigest: evidenceDigest, fileHashes, boundAt: new Date().toISOString().slice(0, 10) });
console.log(`[stage-b-fingerprint] manifest rebound: fingerprint ${fingerprint.slice(0, 12)}…, evidence ${evidenceDigest.slice(0, 12)}…`);
