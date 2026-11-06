// Coverage is a read of existing inventories, never an improvement verdict.
import { el, askLink } from './ui.js';
import { measurementDetail } from './measurement-trend.js';
import { humanName } from './maturation-board-model.js';
const KINDS = { feature: 'Features', decision: 'AI decisions', job: 'Scheduled jobs', effort: 'Work items', capability: 'Model capabilities' };
const STATES = { corroborated: 'Recorded comparison available', 'missing-contract': 'Outcome or baseline not recorded', 'invalid-contract': 'Measurement needs repair', 'not-linked': 'No measurement linked', stale: 'Evidence is too old', unavailable: 'Evidence cannot be read', 'insufficient-samples': 'Too few samples', incompatible: 'Evidence does not match', ambiguous: 'Several measurement links need review', inactive: 'Contract retained; not in the latest evaluation' };
const name = row => humanName({ id: row.id, title: row.title === row.id ? null : row.title });
export function coveragePanel(data, api = null) {
  if (!data || data.schema !== 'measurement-coverage-pool/1') return el('section', { class: 'mb-coverage' },
    el('h2', { text: 'Measurement coverage' }), el('p', { text: 'Coverage cannot be read right now.' }), askLink('Measurement coverage cannot be read.'));
  const origins = data.origins || [];
  let total = 0, compared = 0;
  for (const origin of origins) for (const kind of Object.keys(KINDS)) {
    total += origin.counts[kind].total; compared += origin.counts[kind].states.corroborated;
  }
  const body = el('section', { class: 'mb-coverage' }, el('h2', { text: 'Measurement coverage' }),
    el('p', { text: `At the last read, ${compared} of ${total} tracked entries had a recorded baseline comparison. This shows coverage, not improvement.` }),
    el('progress', { value: compared, max: Math.max(1, total), 'aria-label': `${compared} of ${total} entries with recorded comparisons` }),
    el('p', { class: 'mb-hint', text: data.poolComplete ? 'Read from the existing inventories. The same item on two machines is counted twice.' : 'Some inventories or machines could not be read. These counts are incomplete; missing sources are not counted as zero.' }));
  if (!data.poolComplete) body.append(askLink('Measurement coverage is incomplete. Which sources are missing?'));
  const times = origins.map(o => Date.parse(o.generatedAt)).filter(Number.isFinite);
  if (times.length) body.append(el('p', { class: 'mb-hint', text: `Oldest read: ${new Date(Math.min(...times)).toLocaleString()}. Refresh to check current evidence.` }));
  const rendered = new Map();
  const rowKey = (row) => `${row.origin}:${row.kind}:${row.id}`;
  const show = (key) => { const target = rendered.get(key); if (!target) return;
    for (let node = target.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
    target.scrollIntoView?.({ block: 'center' }); target.focus(); };
  const allRows = origins.flatMap(o => o.rows.map(r => ({ ...r, origin: o.origin })));
  const displayedKeys = new Set(Object.keys(KINDS).flatMap(kind => allRows.filter(r => r.kind === kind).slice(0, 200).map(rowKey)));
  for (const [kind, title] of Object.entries(KINDS)) {
    const rows = origins.flatMap(o => o.rows.filter(r => r.kind === kind).map(r => ({ ...r, origin: o.origin })));
    const count = origins.reduce((n, o) => n + o.counts[kind].total, 0);
    const verified = origins.reduce((n, o) => n + o.counts[kind].states.corroborated, 0);
    const list = el('details', {}, el('summary', { text: `${title}: ${verified} of ${count} with comparisons` }));
    for (const row of rows.slice(0, 200)) {
      const parents = row.parents || (row.parentId ? [{ kind: 'effort', id: row.parentId }] : []);
      const item = el('div', { class: 'mb-coverage-row', tabindex: '-1' },
        el('strong', { text: name(row) }), el('p', { text: STATES[row.state] || 'Unknown measurement state' }),
        parents.map(link => { const parent = allRows.find(r => r.origin === row.origin && r.kind === link.kind && r.id === link.id);
          return el('div', {}, el('p', { class: 'mb-hint', text: parent ? `Part of ${name(parent)}. Its parent's evidence is separate.` : 'Parent work item is outside this read.' }),
            parent && displayedKeys.has(rowKey(parent)) ? el('button', { type: 'button', class: 'mb-link', text: `Show parent: ${name(parent)}`, onclick: () => show(rowKey(parent)) }) : null); }),
        el('details', {}, el('summary', { text: 'Source details' }), el('p', { text: `Recorded declaration: ${row.declaration}. Sources: ${row.sources.join(', ')}. Machine: ${row.origin}.` })));
      if (api && row.subjects.length === 1) {
        const content = el('div', { 'aria-live': 'polite', tabindex: '-1' });
        const button = el('button', { type: 'button', class: 'mb-link', text: 'Show measurements', onclick: async () => {
          button.disabled = true; content.replaceChildren(el('p', { text: 'Reading measurements…' }));
          try {
            const answer = await api.get(`/maturation/board?part=measurement&subject=${encodeURIComponent(row.subjects[0])}&machine=${encodeURIComponent(row.origin)}`, 12000);
            content.replaceChildren(measurementDetail(answer.ok ? answer.data : null));
            content.scrollIntoView?.({ block: 'start' }); content.focus({ preventScroll: true });
          } catch { content.replaceChildren(measurementDetail(null)); }
          button.disabled = false;
        } });
        item.append(button, content);
      }
      rendered.set(rowKey(row), item); list.append(item);
    }
    if (count > Math.min(rows.length, 200)) list.append(el('p', { text: `${count - Math.min(rows.length, 200)} additional entries are included in the count but not shown here.` }));
    body.append(list);
  }
  for (const child of allRows) for (const link of child.parents || (child.parentId ? [{ kind: 'effort', id: child.parentId }] : [])) {
    const parent = rendered.get(`${child.origin}:${link.kind}:${link.id}`);
    if (parent && rendered.has(rowKey(child))) parent.append(el('button', { type: 'button', class: 'mb-link', text: `Show component: ${name(child)}`, onclick: () => show(rowKey(child)) }));
  }
  body.append(el('details', {}, el('summary', { text: 'Read times and missing sources' }), origins.map(o => el('div', {},
    el('p', { text: `Read ${new Date(o.generatedAt).toLocaleString()}. ${o.omittedRows} entries omitted from the shared rows.` }),
    o.sources.filter(s => !s.ok).map(s => el('p', { text: `${s.name}: unavailable` })))),
    (data.failed || []).map(() => el('p', { text: 'Another machine could not provide a supported coverage read.' })),
    data.peersOmitted ? el('p', { text: `${data.peersOmitted} machines were outside this bounded read.` }) : null));
  return body;
}
