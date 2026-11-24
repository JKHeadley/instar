/** Readiness checks shared by the worker and focused tests. No browser launch. */
export function assertLoadedBundledFonts(fonts) {
  const family = value => typeof value === 'string' ? value.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase() : '';
  const loaded = new Set((fonts.faces ?? []).filter(face => face.status === 'loaded').map(face => family(face.family)));
  if (!fonts.inter || !fonts.mono || !loaded.has('inter') || !loaded.has('jetbrains mono')) throw new Error('Matching bundled fixture font faces did not load');
}
export function observeRendererErrors(page, failures) {
  page.on('pageerror', error => failures.push({ kind: 'page-error', message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error') failures.push({ kind: 'console-error', message: message.text() });
  });
}
export async function finalizeRendererReadiness(manifest, failures, responseJobs) {
  // Close occurs before this drain in the worker. Also consume work appended by existing jobs.
  let consumed = 0;
  while (consumed < responseJobs.length) {
    const batch = responseJobs.slice(consumed); consumed += batch.length;
    const results = await Promise.allSettled(batch);
    for (const result of results) if (result.status === 'rejected') failures.push({ kind: 'response-recording-failed' });
  }
  manifest.pageFailures = [...failures];
  if (failures.length || manifest.process?.aliveAfterClose || manifest.closeFailed) manifest.status = 'unavailable';
}
