/** Parent-owned cancellation, trusted producer joins and acknowledgments. Never kills only the worker. */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { validateRendererConfig } from './rendererIdentity.mjs';
import { providerBinding, providerLoadingAction } from './fixtureResponseEvidence.mjs';
import { assessRendererEvidence } from './assessRendererEvidence.mjs';
const DEFAULT_WORKER = fileURLToPath(new URL('./rendererWorker.mjs', import.meta.url));
export function runRendererWorker(rawConfig, { fixtureEvidenceProvider, signal, spawnWorker = spawn, now = () => performance.now(), schedule = setTimeout, clear = clearTimeout, onEvent = () => {} } = {}) {
  const config = validateRendererConfig(rawConfig), start = now(), deadline = start + 60_000;
  // This closure comes only from the in-process fixture. Nothing in stdin or candidate data installs it.
  const parentCaseBinding = providerBinding(fixtureEvidenceProvider, config.fixtureOrigin);
  const stepMs = config.stepRemainingMs ?? 20 * 60_000, events = [];
  let child, result, assessment, exited = false, exitCode, exitSignal, timerFired = false, cancelSent = false, settled = false, finishing = false, screenTimer, stepTimer;
  let stdout = '', stderr = '';
  const record = event => { const entry = { elapsedMs: now() - start, ...event }; events.push(entry); onEvent(entry); };
  const checkDeadline = () => { if (cancelSent || timerFired || now() >= deadline || now() >= start + stepMs || signal?.aborted) throw new Error('Parent screen deadline or cancellation'); };
  const downgradeOwnedAssessment = reason => {
    if (!assessment) return;
    assessment.assessment.status = 'unavailable'; assessment.assessment.reason = reason;
    if (assessment.filename) {
      try { fs.writeFileSync(assessment.filename, JSON.stringify(assessment.assessment, null, 2), { mode: 0o600 }); }
      catch { assessment.assessment.recordUnavailable = true; }
    }
  };
  let settle;
  const completion = new Promise(resolve => { settle = () => {
    if (settled) return; settled = true; clear(screenTimer); clear(stepTimer); signal?.removeEventListener('abort', aborted);
    const cleaned = ['closed-gracefully', 'closed-forced', 'no-browser-started'].includes(result?.cleanup?.status);
    const status = !cancelSent && !timerFired && now() < deadline && exited && exitCode === 0 && result?.status === 'capture-produced'
      && cleaned && assessment?.assessment.status === 'measured' ? 'measured' : 'unavailable';
    if (status !== 'measured' && assessment?.assessment.status === 'measured') {
      downgradeOwnedAssessment('parent-final-deadline-or-cancellation');
    }
    resolve({ status, result, assessment, timerFired, cancelSent, workerExitObserved: exited, exitCode, exitSignal, elapsedMs: now() - start,
      overrunMs: Math.max(0, now() - deadline), events, stdout, stderr,
      ...(cleaned && exited ? {} : { recoveryOwnership: { runDir: config.runDir, workerPid: child?.pid, worker: child, reason: 'Actual cleanup or worker exit is unconfirmed; retain this run.' } }) });
  }; });
  const cancel = reason => {
    if (cancelSent) return; cancelSent = true;
    if (parentCaseBinding.loading) { try { providerLoadingAction(fixtureEvidenceProvider,config.fixtureOrigin,'cancel'); } catch {} } record({ kind: 'parent-cancel', reason });
    try { child?.send({ type: 'renderer-cancel', reason }, error => { if (error) record({ kind: 'cancel-channel-unavailable' }); }); }
    catch { record({ kind: 'cancel-channel-unavailable' }); }
  };
  const aborted = () => cancel('parent-abort');
  const finish = async () => {
    if (finishing || settled) return; finishing = true;
    try {
      if (exited && exitCode === 0 && result?.status === 'capture-produced') {
        checkDeadline(); record({ kind: 'parent-validation-start' });
        assessment = await assessRendererEvidence({ provider: fixtureEvidenceProvider, fixtureOrigin: config.fixtureOrigin, runDir: config.runDir,
          viewport: config.viewport, theme: config.theme, seedNow: config.seedNow, expectedSeedState: parentCaseBinding.seedState, manifestPath: result.manifest, checkDeadline });
        checkDeadline(); record({ kind: 'parent-validation-complete', status: assessment.assessment.status });
      }
    } catch (error) {
      // A post-await refusal must retain and downgrade the actual file just written by this parent.
      if (assessment?.filename) downgradeOwnedAssessment(error.message);
      else assessment = error.assessment ?? { assessment: { status: 'unavailable', reason: error.message } };
      record({ kind: 'parent-validation-failed', reason: error.message });
    }
    settle();
  };
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) { cancel('parent-abort'); settle(); return completion; }
  try {
    child = spawnWorker(process.execPath, [DEFAULT_WORKER], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: config.runDir, TMPDIR: config.runDir, LANG: 'en_US.UTF-8', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    record({ kind: 'worker-started', pid: child.pid });
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => {
      if (message?.type === 'renderer-loading') {
        try { checkDeadline(); if(!['check','release'].includes(message.action))throw new Error('Unsupported worker loading action'); const value=providerLoadingAction(fixtureEvidenceProvider,config.fixtureOrigin,message.action,parentCaseBinding.loading); checkDeadline(); child.send({type:'renderer-loading-result',id:message.id,value}); }
        catch(error){try {child.send({type:'renderer-loading-result',id:message.id,error:error.message});}catch{} cancel('loading-sequence-unavailable');}
      }
      if (message?.type === 'renderer-event') record({ kind: 'worker-event', event: message.event });
      if (message?.type === 'renderer-complete') { result = message.result; record({ kind: 'worker-ack', status: result?.status, cleanup: result?.cleanup }); if (result?.cleanup?.status === 'cleanup-unconfirmed') finish(); }
    });
    child.once('error', error => { record({ kind: 'worker-error', message: error.message }); finish(); });
    child.once('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; record({ kind: 'worker-exit', code, signal }); finish(); });
    screenTimer = schedule(() => { timerFired = true; cancel('screen-deadline'); }, Math.max(0, deadline - now()));
    stepTimer = schedule(() => { timerFired = true; cancel('step-deadline'); record({ kind: 'parent-cleanup-unconfirmed' }); settle(); }, Math.max(0, start + stepMs - now()));
    child.send({ type: 'renderer-case', parentCase: { fixtureRunId: parentCaseBinding.runId, seedState: parentCaseBinding.seedState, ...(parentCaseBinding.loading ? {loading:parentCaseBinding.loading} : {}) } }, error => { if (error) cancel('parent-case-unavailable'); });
    child.stdin.end(JSON.stringify({ ...rawConfig, stepRemainingMs: stepMs }));
  } catch (error) { record({ kind: 'parent-start-failed', message: error.message }); finish(); }
  return completion;
}
