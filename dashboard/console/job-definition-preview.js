import { askPin, el, operatorSession, operatorSessionRemainingMs, setKids } from './ui.js';

const PATH = '/jobs/reconcile?preview=job-definitions';
const SOURCES = { legacy: 'Legacy job list', 'portable-journal': 'Portable job journal', 'manifest-inventory': 'Schedule manifests' };
const ROW_SOURCES = { legacy: SOURCES.legacy, manifest: SOURCES['manifest-inventory'] };
const COVERAGE = { complete: 'checked', invalid: 'could not be verified', unchecked: 'unchecked' };
const DISPOSITIONS = {
  'loader-effective': 'Selected by the file loader',
  suppressed: 'Withheld by the file loader',
  unknown: 'Selection unknown',
  invalid: 'Definition invalid',
};
const REASONS = {
  'portable-owned': 'The portable job journal controls this definition.',
  'portable-invalid': 'The portable job journal could not be verified.',
  'manifest-unverified': 'A schedule manifest exists, but its selection is unverified.',
  incomplete: 'The input check was incomplete.',
};
const EXECUTORS = { prompt: 'Prompt', skill: 'Skill', script: 'Script', agentmd: 'Agent instructions' };

function label(table, key) {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null;
}

function renderRow(row) {
  const source = label(ROW_SOURCES, row?.source);
  const disposition = label(DISPOSITIONS, row?.disposition);
  if (!source || !disposition) return null;
  const slug = typeof row.slug === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(row.slug) ? row.slug : 'Unnamed definition';
  const executor = label(EXECUTORS, row.executor);
  const reason = label(REASONS, row.reason);
  return el('li', { class: 'job-preview-row' },
    el('strong', { text: slug }),
    el('p', { class: 'need-sub', text: [source, disposition, executor,
      row.enabled === true ? 'Enabled in this file' : row.enabled === false ? 'Disabled in this file' : null].filter(Boolean).join(' · ') }),
    reason ? el('p', { class: 'need-sub', text: reason }) : null,
  );
}

export function jobDefinitionPreview({ sessionToken, isCurrent, onDispose }) {
  const bearer = sessionToken();
  if (!bearer) return null;
  const start = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Preview job migration' });
  const more = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Next page', hidden: true });
  const close = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Close preview', hidden: true });
  const status = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
  const results = el('div');
  const node = el('section', { class: 'list-section', 'aria-label': 'Job migration preview' },
    el('div', { class: 'list-head' }, start, close), status, results, more);
  let disposed = false;
  let pending = null;
  let unlocking = false;
  let cursor = null;
  let proof = null;
  let deniedProof = null;
  let expiry = null;
  let proofWatch = null;

  const current = () => !disposed && isCurrent?.() !== false && sessionToken() === bearer;
  const reset = (message = '') => {
    pending?.abort();
    pending = null;
    clearTimeout(expiry);
    clearInterval(proofWatch);
    expiry = proofWatch = null;
    proof = cursor = null;
    more.hidden = true;
    close.hidden = true;
    start.disabled = more.disabled = false;
    node.removeAttribute('data-interaction-open');
    node.removeAttribute('aria-busy');
    setKids(results);
    status.textContent = message;
  };
  const lock = () => reset('Unlock again to preview job definitions.');
  const storageChanged = event => {
    if (event.key === null || (event.key === 'instar_token' && event.newValue !== bearer)) dispose();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('instar-owner-locked', lock);
    window.removeEventListener('storage', storageChanged);
    reset();
    node.hidden = true;
  };
  window.addEventListener('instar-owner-locked', lock);
  window.addEventListener('storage', storageChanged);
  onDispose?.(dispose);

  async function load(next) {
    if (!current() || pending || unlocking) return;
    const continuation = next ? cursor : null;
    if (next && (!continuation || !proof || operatorSession() !== proof)) { lock(); return; }
    if (!next) {
      reset();
      let unlocked = operatorSession();
      const requiresFreshUnlock = !!unlocked && unlocked === deniedProof;
      if (!unlocked || requiresFreshUnlock) {
        unlocking = true;
        start.disabled = true;
        try {
          const answer = await askPin({
            title: 'Preview job migration',
            explain: 'Unlock to inspect the job definitions on this machine.',
            adapter: 'session',
            fresh: requiresFreshUnlock,
          });
          unlocked = answer?.session;
        } catch { unlocked = null; }
        finally { unlocking = false; start.disabled = false; }
      }
      if (!current() || !node.isConnected || !unlocked || operatorSession() !== unlocked) return;
      proof = unlocked;
      expiry = setTimeout(lock, operatorSessionRemainingMs());
      proofWatch = setInterval(() => { if (!current() || operatorSession() !== proof) lock(); }, 250);
    }

    const controller = new AbortController();
    const requestProof = proof;
    pending = controller;
    close.hidden = false;
    node.setAttribute('aria-busy', 'true');
    node.setAttribute('data-interaction-open', '');
    start.disabled = more.disabled = true;
    setKids(results);
    status.textContent = 'Checking job definitions on this machine…';
    try {
      const response = await fetch(continuation ? PATH + '&cursor=' + encodeURIComponent(continuation) : PATH, {
        headers: { Authorization: `Bearer ${bearer}`, 'X-Instar-Operator-Session': requestProof },
        cache: 'no-store', signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (pending !== controller || !current() || !node.isConnected) return;
      if (operatorSession() !== requestProof) { lock(); return; }
      if (response.status === 401 || response.status === 403) { deniedProof = requestProof; lock(); return; }
      if (response.status === 409) { reset('The job definitions changed or the page expired. Start a fresh preview.'); return; }
      if (response.status === 429) { status.textContent = 'Another preview is running. Try again shortly.'; return; }
      if (response.status === 503) { reset('The job definition preview is unavailable on this machine.'); return; }
      if (response.status !== 200 || data?.schemaVersion !== 1 || !Array.isArray(data.rows)) {
        status.textContent = 'The preview could not finish. Try again.';
        return;
      }
      const rows = data.rows.map(renderRow).filter(Boolean);
      cursor = typeof data.cursor === 'string' && data.cursor.length > 0 && data.cursor.length <= 2048 ? data.cursor : null;
      more.hidden = !cursor;
      status.textContent = data.complete === false ? 'Some job definitions could not be checked.' : 'Job definitions checked on this machine.';
      setKids(results,
        el('ul', { class: 'need-sub' }, Object.entries(SOURCES).map(([key, name]) =>
          el('li', { text: `${name}: ${label(COVERAGE, data.coverage?.[key]) ?? 'unchecked'}.` }))),
        el('p', { class: 'need-sub', text: 'The live scheduler, accountable owners, and job mappings could not be verified. Other machines were not checked.' }),
        rows.length ? el('ul', { class: 'project-cards' }, rows) : el('p', { class: 'empty-line', text: 'No job definitions are shown on this page.' }),
        data.truncated === true && !cursor ? el('p', { class: 'need-sub', text: 'Some rows could not be shown. This preview has no next page.' }) : null,
      );
    } catch {
      if (pending === controller && current()) status.textContent = 'The preview could not finish. Try again.';
    } finally {
      if (pending === controller) {
        pending = null;
        node.removeAttribute('aria-busy');
        start.disabled = more.disabled = false;
      }
    }
  }
  start.addEventListener('click', () => { void load(false); });
  more.addEventListener('click', () => { void load(true); });
  close.addEventListener('click', () => { reset(); start.focus(); });
  return { node, dispose };
}
