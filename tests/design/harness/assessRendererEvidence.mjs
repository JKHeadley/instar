import {assertNativeLoadingWitness} from './accountsLoading.mjs';
import { ACCOUNTS_READS, assertAccountsWitness, deriveAccountsExpectation, assertAccountsModelWitness, validateParentCase } from './accountsReadiness.mjs';
/** Trusted parent assessment. The worker cannot provide its own producer ledger or final measured result. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DECLARED_HEADER_PROBES, providerBinding, providerLoadingAction, isDeclaredHeaderProbe, joinFixtureProbeEvidence, digest } from './fixtureResponseEvidence.mjs';
import { pngDimensions } from './rendererIdentity.mjs';
function privateFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Invalid private artifact path');
  const filename = path.resolve(root, relative), actual = fs.realpathSync(filename);
  if (actual !== filename || !actual.startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(actual).isFile()) throw new Error('Artifact is outside its owned folder');
  return actual;
}
async function verifiedFile(root, row) {
  if (!row || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Required actual body evidence is missing');
  const bytes = await fs.promises.readFile(privateFile(root, row.file));
  if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) throw new Error('Actual artifact bytes disagree with their evidence');
  return bytes;
}
export async function assessRendererEvidence({ provider, fixtureOrigin, runDir, viewport, theme, seedNow, expectedSeedState, manifestPath, checkDeadline }) {
  let failureFolder, workerDigest, ownedAssessmentWritten = false;
  try {
  checkDeadline(); const binding = providerBinding(provider, fixtureOrigin);
  const canonicalRun = fs.realpathSync(runDir), absoluteManifest = fs.realpathSync(manifestPath);
  if (absoluteManifest !== path.resolve(manifestPath) || !absoluteManifest.startsWith(canonicalRun + path.sep)) throw new Error('Worker manifest is outside the owned run');
  const folder = path.dirname(absoluteManifest), raw = fs.readFileSync(absoluteManifest);
  failureFolder = folder; workerDigest = digest(raw);
  const manifest = JSON.parse(raw);
  const parentCase = validateParentCase(manifest.parentCase);
  if (parentCase.fixtureRunId !== binding.runId || parentCase.seedState !== binding.seedState || expectedSeedState !== undefined && expectedSeedState !== binding.seedState) throw new Error('Trusted fixture case changed or mismatched');
  if(JSON.stringify(parentCase.loading??null)!==JSON.stringify(binding.loading??null))throw new Error('Loading case binding mismatch');
  assertAccountsWitness(manifest.readiness, { loading:!!binding.loading, seedState: binding.seedState, viewport, theme });
  if (manifest.status !== 'capture-produced' || manifest.fixtureOrigin !== fixtureOrigin || manifest.lifetime?.canceled
    || manifest.process?.aliveAfterClose !== false || !manifest.cleanup?.exitObserved
    || !['closed-gracefully', 'closed-forced'].includes(manifest.cleanup.status)
    || !Array.isArray(manifest.pageFailures) || manifest.pageFailures.length || !Array.isArray(manifest.responses)) throw new Error('Worker capture is unavailable or unconfirmed');
  const capture = await verifiedFile(folder, manifest.capture), dimensions = pngDimensions(capture);
  if (dimensions.width !== viewport.width || dimensions.height !== viewport.height) throw new Error('Actual capture geometry disagrees with the standard');
  const axeBytes = await fs.promises.readFile(privateFile(folder, manifest.accessibility?.file));
  if (digest(axeBytes) !== manifest.accessibility?.sha256 || manifest.accessibility?.status !== 'measured' || manifest.accessibility?.mergeAuthority !== false) throw new Error('Axe measurement is unconfirmed');
  const accountBodies = {};
  const joined = [], emittedBodies = [], seen = new Set(), observedProbes = new Set();
  for (const row of manifest.responses) {
    checkDeadline();
    const url = new URL(row.url);
    if (url.origin !== fixtureOrigin || url.username || url.password || !Number.isInteger(row.status) || row.status < 200 || row.status >= 300) throw new Error('Unexpected response origin or status');
    if (isDeclaredHeaderProbe(row.method, row.url, fixtureOrigin)) {
      const result = joinFixtureProbeEvidence(provider, fixtureOrigin, row);
      if (seen.has(result.evidence.responseId)) throw new Error('Duplicate response correlation ID');
      seen.add(result.evidence.responseId); observedProbes.add(url.pathname); joined.push(result.evidence); emittedBodies.push(result);
    } else {
      if (row.bodyEvidence || row.bodyUnavailable) throw new Error('An undeclared body cannot use producer evidence');
      const actual = await verifiedFile(folder, row);
      const key = url.pathname + url.search;
      if (row.method === 'GET' && ACCOUNTS_READS.includes(key) && !Object.hasOwn(accountBodies, key)) accountBodies[key] = JSON.parse(actual.toString('utf8'));
    }
  }
  if (DECLARED_HEADER_PROBES.some(probe => !observedProbes.has(probe))) throw new Error('A required actual door probe was not observed');
  const expectedAccounts = deriveAccountsExpectation(binding.seedState, accountBodies, Date.parse(seedNow));
  if(binding.loading){assertNativeLoadingWitness(manifest.loading?.native,binding.loading);const attempts=manifest.responses.filter(row=>row.url===fixtureOrigin+ACCOUNTS_READS[0]);if(attempts.length!==1 || attempts[0].loadingRequestId!==binding.loading.requestId)throw new Error('Actual loading response attempt is mismatched');}
  const loading = binding.loading ? providerLoadingAction(provider,fixtureOrigin,'assess',manifest.loading) : null;
  if(loading) assertAccountsWitness(manifest.afterLoading,{seedState:binding.seedState,viewport,theme});
  assertAccountsModelWitness(loading ? manifest.afterLoading : manifest.readiness, expectedAccounts);
  if (providerBinding(provider, fixtureOrigin).seedState !== binding.seedState) throw new Error('Fixture state changed during assessment');
  checkDeadline();
  const bodyFolder = path.join(folder, 'fixture-emitted'); fs.mkdirSync(bodyFolder, { mode: 0o700 });
  for (const result of emittedBodies) {
    const filename = path.join(bodyFolder, `${result.evidence.sha256}.bin`);
    if (fs.existsSync(filename)) { if (digest(fs.readFileSync(filename)) !== result.evidence.sha256) throw new Error('Stored emitted bytes disagree'); }
    else await fs.promises.writeFile(filename, result.bytes, { mode: 0o600, flag: 'wx' });
    result.evidence.file = path.relative(folder, filename);
  }
  checkDeadline();
  const assessment = { schema: 'design-parent-response-assessment/1', status: 'measured', workerManifestSha256: digest(raw), captureSha256: manifest.capture.sha256,
    fixtureOrigin, fixtureRunId: binding.runId, accountsReadiness: expectedAccounts, loadingWitness: loading, displayWitness: manifest.readiness.display, bodyEvidence: joined, accessibility: 'measurement-only-not-pass' };
  const filename = path.join(folder, 'parent-assessment.json');
  await fs.promises.writeFile(filename, JSON.stringify(assessment, null, 2), { mode: 0o600, flag: 'wx' });
  ownedAssessmentWritten = true;
  try { checkDeadline(); } catch (error) {
    assessment.status = 'unavailable'; assessment.reason = 'parent-deadline-or-cancellation';
    await fs.promises.writeFile(filename, JSON.stringify(assessment, null, 2), { mode: 0o600 }); throw error;
  }
  return { filename, assessment };
  } catch (error) {
    const assessment = { schema: 'design-parent-response-assessment/1', status: 'unavailable', reason: error.message, workerManifestSha256: workerDigest ?? null };
    let filename;
    if (failureFolder) {
      filename = path.join(failureFolder, ownedAssessmentWritten ? 'parent-assessment.json' : `parent-assessment-unavailable-${randomBytes(8).toString('hex')}.json`);
      try { await fs.promises.writeFile(filename, JSON.stringify(assessment, null, 2), { mode: 0o600, ...(ownedAssessmentWritten ? {} : { flag: 'wx' }) }); }
      catch { filename = undefined; assessment.recordUnavailable = true; }
    }
    error.assessment = { filename, assessment }; throw error;
  }
}
