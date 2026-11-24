/** Read-only Accounts witnesses over the actual production model; no DOM mutation or consent authority. */
import { buildAccountsPage } from '../../../dashboard/console/accounts-model.js';
export const ACCOUNTS_READS = Object.freeze(['/subscription-pool?scope=pool', '/subscription-relogin?scope=pool', '/subscription-pool/in-use', '/pool']);
export function validateParentCase(value) {
  if (!value || Object.keys(value).some(key => !['fixtureRunId', 'seedState', 'loading'].includes(key))
    || !/^[a-f0-9]{32}$/.test(value.fixtureRunId) || !['busy', 'empty', 'error'].includes(value.seedState)) throw new Error('Invalid parent-owned Accounts case');
  if (value.loading && (value.seedState !== 'busy' || Object.keys(value.loading).some(k => !['holdId','requestId'].includes(k)) || !['holdId','requestId'].every(k => /^[a-f0-9]{32}$/.test(value.loading[k])))) throw new Error('Invalid parent loading identity');
  return Object.freeze({ fixtureRunId: value.fixtureRunId, seedState: value.seedState, ...(value.loading ? {loading:Object.freeze({...value.loading})} : {}) });
}
export function terminalAccountsPaint() { return observeAccountsView({ terminalOnly: true }); }
export function observeAccountsView({ terminalOnly = false, loadingOnly = false } = {}) {
  const main = document.querySelector('main'), heading = main?.querySelector('.page-title'), list = main?.querySelector('.acct-list');
  const rows = [...(main?.querySelectorAll('.acct-row') ?? [])], notes = [...(main?.querySelectorAll('.card-note') ?? [])];
  const box = node => {
    if (!node) return null;
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    let nativeVisible = false;
    try { nativeVisible = node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch { /* Unsupported visibility observation is unavailable. */ }
    return { connected: node.isConnected, nativeVisible, display: style.display, visibility: style.visibility,
      opacity: Number(style.opacity), contentVisibility: style.contentVisibility, rectCount: node.getClientRects().length,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  };
  const visibility = { main: box(main), heading: box(heading), list: box(list), firstRow: box(rows[0]), notes: notes.map(node => ({ text: node.textContent.trim(), box: box(node) })) };
  const rendered = (fact, zeroHeight = false) => !!fact && fact.connected === true && fact.nativeVisible === true
    && typeof fact.display === 'string' && fact.display !== 'none' && typeof fact.visibility === 'string' && !['hidden', 'collapse'].includes(fact.visibility)
    && Number.isFinite(fact.opacity) && fact.opacity > 0 && fact.contentVisibility !== 'hidden' && fact.rectCount > 0
    && fact.rect.width > 0 && (zeroHeight ? fact.rect.height >= 0 : fact.rect.height > 0);
  const painted = main?.dataset.painted === '1', skeleton = !!main?.querySelector('.page-title.skeleton');
  if (loadingOnly) return !painted && skeleton && heading?.textContent?.trim() === 'Loading accounts' && !rows.length && rendered(visibility.main) && rendered(visibility.heading);
  if (terminalOnly) return !!painted && !!list && !skeleton && rendered(visibility.main) && rendered(visibility.heading)
    && rendered(visibility.list, rows.length === 0) && (!rows.length || rendered(visibility.firstRow));
  const style = getComputedStyle(document.documentElement);
  return {
    painted, listPresent: !!list, skeleton, visibility,
    wholePageUnknown: !!main?.querySelector(':scope > [data-state="unknown"]'),
    headline: heading?.textContent?.trim() ?? '',
    names: [...(main?.querySelectorAll('.acct-row .acct-name') ?? [])].map(node => node.firstChild?.textContent ?? ''),
    rowCount: rows.length, notes: notes.map(node => node.textContent.trim()),
    display: { innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      devicePixelRatio, visualScale: visualViewport?.scale ?? null, visualWidth: visualViewport?.width ?? null, visualHeight: visualViewport?.height ?? null,
      themeAttribute: document.documentElement.getAttribute('data-theme'), prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      prefersLight: matchMedia('(prefers-color-scheme: light)').matches, mediaMax768: matchMedia('(max-width: 768px)').matches,
      backgroundToken: style.getPropertyValue('--bg').trim(), backgroundColor: getComputedStyle(document.body).backgroundColor,
      rootZoom: style.zoom, bodyZoom: getComputedStyle(document.body).zoom },
  };
}
function renderedBox(fact, zeroHeight = false) {
  return !!fact && fact.connected === true && fact.nativeVisible === true && typeof fact.display === 'string' && fact.display !== 'none'
    && typeof fact.visibility === 'string' && !['hidden', 'collapse'].includes(fact.visibility) && Number.isFinite(fact.opacity) && fact.opacity > 0
    && fact.contentVisibility !== 'hidden' && Number.isInteger(fact.rectCount) && fact.rectCount > 0
    && Number.isFinite(fact.rect?.width) && fact.rect.width > 0 && Number.isFinite(fact.rect?.height) && (zeroHeight ? fact.rect.height >= 0 : fact.rect.height > 0);
}
export function assertAccountsWitness(view, { seedState, viewport, theme, loading = false }) {
  if (loading) {
    if (seedState !== 'busy' || !view || view.painted || view.listPresent || view.wholePageUnknown || !Array.isArray(view.names) || view.names.length !== 0 || !view.skeleton || view.headline !== 'Loading accounts' || view.rowCount !== 0 || !renderedBox(view.visibility?.main) || !renderedBox(view.visibility?.heading)) throw new Error('Actual visible loading skeleton is absent');
  } else {
  if (!['busy', 'empty', 'error'].includes(seedState) || !view?.painted || !view.listPresent || view.skeleton || view.wholePageUnknown
    || !Number.isSafeInteger(view.rowCount) || !Array.isArray(view.names) || view.names.length !== view.rowCount || !Array.isArray(view.notes)
    || (seedState === 'busy' ? view.rowCount <= 0 : view.rowCount !== 0)) throw new Error('Accounts DOM does not match the trusted terminal state');
  const visibility = view.visibility;
  if (!visibility || !renderedBox(visibility.main) || !renderedBox(visibility.heading)
    || !renderedBox(visibility.list, seedState !== 'busy') || seedState === 'busy' && !renderedBox(visibility.firstRow)) throw new Error('Accounts terminal content is not rendered visibly');
  }
  const d = view.display;
  if (!d || d.innerWidth !== viewport.width || d.innerHeight !== viewport.height || d.devicePixelRatio !== 1 || d.visualScale !== 1
    || d.themeAttribute !== theme || d.prefersDark !== (theme === 'dark') || d.prefersLight !== (theme === 'light')
    || d.mediaMax768 !== (viewport.width <= 768) || typeof d.backgroundToken !== 'string' || !d.backgroundToken.trim()
    || Number(d.rootZoom) !== 1 || Number(d.bodyZoom) !== 1) throw new Error('Observed theme or standard viewport geometry disagrees');
}
export function deriveAccountsExpectation(seedState, bodies, now) {
  if (!['busy', 'empty', 'error'].includes(seedState) || !Number.isFinite(now) || ACCOUNTS_READS.some(key => !bodies[key])) throw new Error('Actual Accounts read evidence is incomplete');
  const pool = bodies[ACCOUNTS_READS[0]], relogin = bodies[ACCOUNTS_READS[1]], inUse = bodies[ACCOUNTS_READS[2]], machines = bodies[ACCOUNTS_READS[3]];
  const names = Array.isArray(machines.machines) ? Object.fromEntries(machines.machines.map(machine => [machine.machineId, machine.nickname])) : {};
  const page = buildAccountsPage({ ok: true, data: pool }, now, { episodes: relogin.episodes ?? [], blockers: relogin.blockers ?? [], inUse, names, poolMachines: { ok: true, data: machines } });
  const failedCount = Array.isArray(pool.pool?.failed) ? pool.pool.failed.length : 0;
  if (!page.ok || (seedState === 'busy' ? !page.accounts.length || failedCount !== 0 : seedState === 'empty' ? page.accounts.length !== 0 || failedCount !== 0 : page.accounts.length !== 0 || failedCount === 0 || !page.partial)) throw new Error('Real Accounts model does not match the trusted seed state');
  return { seedState, accountCount: page.accounts.length, failedCount, names: page.accounts.map(account => account.name).sort(), headline: page.headline, partial: page.partial ?? null };
}
export function assertAccountsModelWitness(view, expected) {
  if (view.rowCount !== expected.accountCount || JSON.stringify([...view.names].sort()) !== JSON.stringify(expected.names)
    || view.headline !== expected.headline || expected.partial && (!view.notes.includes(expected.partial)
      || !view.visibility?.notes?.some(note => note.text === expected.partial && renderedBox(note.box)))) throw new Error('Observed Accounts content disagrees with the actual read/model result');
}
