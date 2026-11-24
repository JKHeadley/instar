// Private Work view for A1's read-only search. Never turn a returned URL or
// excerpt into markup, and never put the search text in browser history.
import { el, setKids } from './ui.js';
import { hashFor, parseConversationRef } from './chats-model.js';

const POSITION_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const PR_REPO = 'JKHeadley/instar';
const PR_STATES = { OPEN: 'Open when checked', MERGED: 'Merged when checked' };
const COVERAGE_LABELS = {
  present: 'Searched', fresh: 'Searched', partial: 'Partly searched', stale: 'Older results',
  unavailable: 'Unavailable', unknown: 'Could not verify coverage', unsearched: 'Not searched',
};
const SOURCES = [
  ['gitRefs', 'Git refs'], ['specs', 'Specs'], ['decisions', 'Decisions'], ['documents', 'Documents'],
  ['projects', 'Projects'], ['cards', 'Cards'], ['commitments', 'Commitments'], ['jobs', 'Jobs'],
];

function answerLink(row) {
  if (row?.kind === 'conversation' && typeof row.ref === 'string') {
    const ref = parseConversationRef(row.ref);
    if (ref?.kind !== 'app' || typeof row.messageId !== 'string' || !POSITION_ID.test(row.messageId)) return null;
    return el('li', { class: 'work-discovery-hit' },
      el('a', { class: 'link-btn', text: typeof row.title === 'string' && row.title ? row.title : 'App conversation',
        href: `${hashFor(ref)}&m=${encodeURIComponent(row.messageId)}` }),
      el('p', { class: 'need-sub', text: 'Conversation lead' }),
      typeof row.snippet === 'string' && row.snippet ? el('p', { class: 'need-sub', text: row.snippet }) : null,
    );
  }
  if (row?.kind === 'pull-request' && row.repository === PR_REPO && Number.isSafeInteger(row.number) && row.number > 0) {
    const state = typeof row.state === 'string' && Object.hasOwn(PR_STATES, row.state) ? PR_STATES[row.state] : 'State unavailable';
    return el('li', { class: 'work-discovery-hit' },
      el('a', { class: 'link-btn', text: typeof row.title === 'string' && row.title ? row.title : `Pull request #${row.number}`,
        href: `https://github.com/${PR_REPO}/pull/${row.number}` }),
      el('p', { class: 'need-sub', text: `Pull request #${row.number} · ${state}` }),
    );
  }
  return null;
}

function coverageDetail(coverage) {
  const conversations = coverage?.conversations;
  const platforms = conversations?.platforms;
  const rows = platforms
    ? [['App on this machine', platforms.app], ['Telegram', platforms.telegram], ['Slack', platforms.slack], ['Other machines', conversations.peers]]
    : [['Conversations', conversations?.status]];
  rows.push(['Public Instar pull requests', coverage?.pullRequests?.status]);
  for (const [key, label] of SOURCES) rows.push([label, coverage?.[key]?.status]);
  return el('details', {},
    el('summary', { class: 'link-btn', text: 'Search coverage' }),
    el('dl', { class: 'need-sub work-discovery-coverage' }, rows.flatMap(([label, state]) => [
      el('dt', { text: label }),
      el('dd', { text: typeof state === 'string' && Object.hasOwn(COVERAGE_LABELS, state) ? COVERAGE_LABELS[state] : 'Coverage unavailable' }),
    ])),
  );
}

export function workDiscoveryPanel({ send, sessionToken, isCurrent, onDispose }) {
  // The prefix is a presentation hint. The existing console session must
  // pass the server's owner-only check on every search.
  if (!sessionToken().startsWith('dst_')) return null;
  const input = el('input', {
    type: 'search', class: 'reason-input', id: 'work-discovery-query', name: 'query',
    maxlength: 200, required: true, autocomplete: 'off', placeholder: 'What are you looking for?',
  });
  const submit = el('button', { type: 'submit', class: 'btn-quiet btn-inline', text: 'Search' });
  const form = el('form', { class: 'conversation-search' }, input, submit);
  const status = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
  const results = el('div');
  const section = el('section', { class: 'list-section work-lane', 'aria-label': 'Find earlier work' },
    el('label', { class: 'list-head', for: input.id }, el('span', { class: 'eyebrow', text: 'Find earlier work' })),
    el('div', { class: 'work-lane-body' }, form, status, results));
  let pending = null;
  onDispose?.(() => {
    pending?.abort();
    setKids(results);
    input.value = '';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    const token = sessionToken();
    if (pending || !query || !token.startsWith('dst_')) return;
    const running = new AbortController();
    pending = running;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Searching for earlier work…';
    setKids(results);
    try {
      const response = await send('/work/discover', { query }, running.signal);
      if (!section.isConnected || running.signal.aborted || isCurrent?.() === false) return;
      if (sessionToken() !== token || response.status === 401 || response.status === 403) {
        input.value = '';
        status.textContent = 'Sign in to the private console to search earlier work.';
        return;
      }
      const { data } = response;
      if ((response.status !== 200 && !(response.status === 503 && data?.status === 'unavailable'))
        || data?.version !== 1 || !Array.isArray(data.candidates)) {
        status.textContent = data?.error === 'work-discovery-disabled'
          ? 'Work search is unavailable on this agent.'
          : 'The search could not finish. Try again.';
        return;
      }
      const matches = data.candidates.map(answerLink).filter(Boolean);
      status.textContent = data.status === 'unavailable' ? 'No sources could be checked.'
        : matches.length ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'} in the sources searched.` : 'No matches in the sources searched.';
      setKids(results, matches.length ? el('ul', { class: 'work-discovery-matches' }, matches) : null, coverageDetail(data.coverage));
    } finally {
      pending = null;
      form.removeAttribute('aria-busy');
      submit.disabled = false;
    }
  });
  return section;
}
