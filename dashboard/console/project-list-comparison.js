import { el, setKids } from './ui.js';

const VIEWS = { differences: 'Differences and unchecked rows', matches: 'Verified matches', all: 'All checked rows' };
const STATES = {
  matched: 'Recorded counterpart',
  'projects-only': 'Listed in Projects only in these views',
  'chief-of-staff-only': 'Listed in Chief of Staff only in these views',
  conflict: 'Conflicting recorded links',
  'counterpart-unchecked': 'Counterpart could not be verified',
};
const COVERAGE = { complete: 'checked', partial: 'partially checked', unavailable: 'could not be checked' };
const EXPLANATIONS = {
  matched: 'An authorized binding records the counterpart in these views.',
  'projects-only': 'The checked views establish no confirmed counterpart for this Projects entry.',
  'chief-of-staff-only': 'The checked views establish no confirmed counterpart for this Chief of Staff entry.',
  conflict: 'More than one checked binding points to the same Projects entry. The comparison chooses no winner.',
  'counterpart-unchecked': 'The available evidence cannot establish whether there is a counterpart.',
};

function coverageLine(label, source) {
  const status = Object.hasOwn(COVERAGE, source?.status) ? COVERAGE[source.status] : COVERAGE.unavailable;
  return el('li', { text: `${label} ${status}.` });
}

function rowDetail(row) {
  if (!Object.hasOwn(STATES, row?.state) || !Number.isSafeInteger(row.ordinal)
    || !Array.isArray(row.projects) || !Array.isArray(row.chiefOfStaff)) return null;
  const sides = [['Projects', row.projects], ['Chief of Staff', row.chiefOfStaff]];
  const validEntries = sides.every(([, entries]) => entries.every(entry =>
    typeof entry?.title === 'string' && Number.isSafeInteger(entry.ordinal)));
  if (!validEntries || (row.state === 'conflict' && (row.projects.length !== 1 || row.chiefOfStaff.length < 2))) return null;
  const entries = sides.flatMap(([name, items]) => items.map(entry =>
    el('li', { 'data-comparison-entry': String(entry.ordinal),
      text: `${name} — ${entry.title}${entry.titleTruncated === true ? ' (title shortened)' : ''}` })));
  if (!entries.length) return null;
  const first = entries[0].textContent;
  return el('li', {},
    el('details', { 'data-comparison-row': String(row.ordinal) },
      el('summary', { class: 'link-btn', text: `${STATES[row.state]} · ${first}` }),
      el('ul', {}, entries),
      el('p', { class: 'need-sub', text: EXPLANATIONS[row.state] }),
    ),
  );
}

export function projectListComparison({ sessionToken, isCurrent, onDispose }) {
  const token = sessionToken();
  if (!token.startsWith('dst_')) return null;
  const button = el('button', { class: 'btn-quiet btn-inline', type: 'submit', text: 'Compare project lists' });
  const select = el('select', {}, Object.entries(VIEWS).map(([value, text]) => el('option', { value, text })));
  const form = el('form', { class: 'confirm-row' }, el('label', {}, 'Show ', select), button);
  const status = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
  const results = el('div');
  const node = el('section', { 'aria-label': 'Compare project lists' }, form, status, results);
  let pending = null;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    pending?.abort();
    window.removeEventListener('storage', sessionChanged);
    setKids(results);
    status.textContent = '';
    node.hidden = true;
  };
  const sessionChanged = event => {
    if (event.key === null || (event.key === 'instar_token' && event.newValue !== token)) dispose();
  };
  window.addEventListener('storage', sessionChanged);
  onDispose?.(dispose);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (disposed || pending || isCurrent?.() === false) return;
    if (sessionToken() !== token) { dispose(); return; }
    const view = select.value;
    if (!Object.hasOwn(VIEWS, view)) return;
    const controller = new AbortController();
    pending = controller;
    form.setAttribute('aria-busy', 'true');
    button.disabled = select.disabled = true;
    setKids(results);
    status.textContent = 'Checking the project lists…';
    try {
      const response = await fetch(`/work/projects/compare?view=${view}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (disposed || !node.isConnected || isCurrent?.() === false) return;
      if (sessionToken() !== token) { dispose(); return; }
      if (response.status === 401 || response.status === 403) {
        status.textContent = 'This private session cannot compare project lists.';
        return;
      }
      if (response.status === 429) { status.textContent = 'A comparison is already running. Try again shortly.'; return; }
      if (data?.schemaVersion !== 1 || !Array.isArray(data.rows) || !data.coverage
        || (response.status !== 200 && response.status !== 503)
        || !['complete', 'partial', 'unavailable'].includes(data.status)
        || (response.status === 503 && data.status !== 'unavailable')) {
        status.textContent = 'The comparison could not finish. Try again.';
        return;
      }
      const coverage = data.coverage;
      const oneList = [coverage.projects, coverage.chiefOfStaff]
        .filter(source => source?.status === 'complete' || source?.status === 'partial').length === 1;
      const rows = data.status === 'unavailable' ? [] : data.rows.map(rowDetail).filter(Boolean);
      status.textContent = data.status === 'unavailable' ? 'Neither list could be checked.'
        : oneList ? 'Only one list could be checked.'
          : data.status === 'partial' ? 'The comparison is incomplete.' : 'Both lists were checked.';
      setKids(results,
        el('ul', { class: 'need-sub' }, coverageLine('Projects', coverage.projects), coverageLine('Chief of Staff', coverage.chiefOfStaff)),
        data.truncated === true ? el('p', { class: 'need-sub', text: 'Only the first set of results is shown. Running the comparison again will not show the remaining rows.' }) : null,
        rows.length ? el('ul', { class: 'project-cards' }, rows)
          : data.status === 'unavailable' ? null
            : el('p', { class: 'empty-line', text: view === 'matches' ? 'No verified matches in the checked rows.' : 'No rows to show for this selection.' }),
      );
    } catch {
      if (!disposed && sessionToken() !== token) dispose();
      if (!disposed && isCurrent?.() !== false) status.textContent = 'The comparison could not finish. Try again.';
    } finally {
      pending = null;
      form.removeAttribute('aria-busy');
      button.disabled = select.disabled = false;
    }
  });
  return { node, dispose };
}
