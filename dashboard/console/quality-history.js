// Quality history at a glance (docs/specs/quality-history-glance.md).
// Direct link: #/work/maturation?s=quality. One small history chart per measured
// item, worst first, drawn by the same measurementChart the detail view uses.
// Every value is written with textContent via el(); nothing here is a verdict.
import { el, askLink } from './ui.js';
import { measurementChart } from './measurement-trend.js';
import { humanName } from './maturation-board-model.js';

export const QUALITY_HREF = '#/work/maturation?s=quality';
const FIRST = 12;
const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 }).format(n) : 'unknown');
const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const goalText = (m) => `goal ${m.direction === 'at-least' ? 'at least' : 'at most'} ${fmt(m.threshold)}`;

/** Plain name of the item a chart belongs to. */
export function itemName(item) {
  const n = item.name;
  return n ? humanName({ id: n.id, title: n.title && n.title !== n.id ? n.title : null }) : humanName({ id: item.subjectId });
}

/** Whether a recorded starting point backs this item's comparison. */
export function comparisonVerified(item) {
  return Boolean(item.proof && item.proof.comparisonAvailable && item.proof.baseline && item.proof.baseline.state === 'verified');
}

/** The one plain line under a chart. */
export function statusText(item) {
  const m = item.metric, l = item.latest;
  if (!l) return 'No recorded values yet.';
  const was = item.first && item.change !== null ? ` Was ${fmt(item.first.value)} on ${day(item.first.at)}.` : '';
  if (item.status === 'too-few-samples') return `Now ${fmt(l.value)}, ${goalText(m)} — too few samples to judge (${fmt(l.samples)} of ${fmt(m.minSamples)} needed).${was}`;
  if (item.status === 'off-goal') return `Off goal: now ${fmt(l.value)}, ${goalText(m)}.${was}`;
  return `At goal: now ${fmt(l.value)}, ${goalText(m)}.${was}`;
}

/** Headline counts, computed from the items actually returned. */
export function summarize(data) {
  const items = data.items || [];
  const count = (s) => items.filter((i) => i.status === s).length;
  return { total: items.length + (data.itemsOmitted || 0), off: count('off-goal'), few: count('too-few-samples'), at: count('at-goal'),
    verified: items.filter(comparisonVerified).length };
}

function card(item) {
  const name = itemName(item);
  const metricName = humanName({ id: item.metric.id });
  const verified = comparisonVerified(item);
  const detail = { generatedAt: new Date().toISOString(), currentContractHash: item.contractHash };
  // `current` is the server's exact evaluation join; the shared chart reads it as the evaluation's contract identity.
  const series = item.series && { ...item.series, points: item.series.points.map((p) => ({ ...p, evaluation: p.current ? { contractHash: item.contractHash } : null })) };
  const chart = series && series.points.length
    ? measurementChart(item.metric, series, detail, item.proof, { goal: true, caption: false })
    : el('p', { class: 'qh-empty', text: 'No recorded values to draw.' });
  return el('article', { class: 'qh-card', 'data-status': item.status },
    el('h3', { class: 'qh-name', title: `${name} · ${metricName}` }, el('span', { text: name }), el('span', { class: 'qh-metric', text: ` · ${metricName}` })),
    chart,
    el('p', { class: 'qh-line', text: statusText(item) }),
    el('p', { class: 'qh-foot' },
      verified ? null : el('span', { class: 'qh-tag', text: 'Comparison not verified (no starting point)' }),
      item.status === 'off-goal' ? askLink(`${name}: ${metricName} is ${fmt(item.latest.value)}, ${goalText(item.metric)}. What should happen next?`, 'Ask what to do') : null));
}

/** The whole view. `data` is GET /maturation/board?part=quality, or null when it could not be read. */
export function qualityHistoryView(data, { backHref = '#/work/maturation' } = {}) {
  const back = el('a', { class: 'qh-back', href: backHref, text: 'Whole maturation board' });
  if (!data || data.schema !== 'measurement-quality-glance/1') {
    return el('section', { class: 'qh' }, el('div', { class: 'eyebrow', text: 'Quality history' }),
      el('h1', { class: 'mb-answer', text: 'Quality history cannot be read right now.' }), askLink('Quality history cannot be read right now.'), back);
  }
  const s = summarize(data);
  const headline = !s.total ? 'Nothing is measured on this machine yet.'
    : s.off ? `${s.off} of ${s.total} measured items are off their goal.`
    : `None of ${s.total} measured items is off its goal.`;
  const items = data.items || [];
  const grid = el('div', { class: 'qh-grid' }, items.slice(0, FIRST).map(card));
  const more = items.length > FIRST ? el('button', { type: 'button', class: 'mb-link qh-more', text: `Show all ${items.length}`, onclick: () => {
    grid.append(...items.slice(FIRST).map(card)); more.remove();
  } }) : null;
  const unverified = s.total && s.verified < items.length;
  const notRead = Object.values(data.notReadable || {}).reduce((a, b) => a + b, 0);
  return el('section', { class: 'qh' },
    el('div', { class: 'qh-top' }, el('div', { class: 'eyebrow', text: 'Quality history' }), back),
    el('h1', { class: 'mb-answer', text: headline }),
    s.total ? el('p', { class: 'mb-sub', text: `Worst first. ${s.few} have too few samples to judge; ${s.at} are at goal.` }) : null,
    unverified ? el('p', { class: 'qh-warn' }, el('span', { text: s.verified ? `Only ${s.verified} of ${items.length} have a recorded starting point, so the other changes are not verified improvements. ` : 'None has a recorded starting point yet, so no change shown here is a verified improvement. ' }),
      askLink('Most measured items have no recorded starting point (baseline). How do we record them?', 'Ask how to record starting points')) : null,
    s.total ? el('p', { class: 'qh-key', 'aria-label': 'How to read the charts' },
      el('span', { class: 'qh-k-dot', text: 'Dots: recorded values, hollow = not verified' }),
      el('span', { class: 'qh-k-goal', text: 'Amber dotted line: goal' }),
      el('span', { class: 'qh-k-base', text: 'Dashed line: starting point' })) : null,
    grid, more,
    el('details', { class: 'mb-sources' }, el('summary', { text: 'Where this comes from' }),
      el('p', { class: 'mb-fine', text: `Read ${new Date(data.generatedAt).toLocaleString()} on this machine, last ${data.windowDays} days. Each chart shows up to 24 of its recorded points; lines join only points recorded as continuous.` }),
      notRead ? el('p', { class: 'mb-fine', text: `${notRead} measured items could not be read and are not shown.` }) : null,
      data.itemsOmitted || data.subjectsOmitted ? el('p', { class: 'mb-fine', text: `${(data.itemsOmitted || 0) + (data.subjectsOmitted || 0)} more items are outside this bounded read.` }) : null,
      data.sourcesComplete ? null : el('p', { class: 'mb-fine', text: 'Some inventories could not be read, so this list may be incomplete.' }),
      notRead || !data.sourcesComplete ? askLink('Some measured items could not be read for quality history.') : null));
}
