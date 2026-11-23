import { el } from './ui.js';
import { buildQuotaForecast } from './quota-forecast-model.js';

// A separate request keeps sign-in controls independent of slower pool telemetry.
export function quotaForecastCard(get, accounts = []) {
  const host = el('section', { class: 'card', id: 'sec-quota-forecast', 'data-state': 'loading', 'aria-label': 'Allowance forecast' },
    el('h2', { class: 'card-title', text: 'Allowance forecast' }),
    el('p', { class: 'card-note', text: 'Checking recent spending and reset history…' }));
  const render = (response) => {
    const view = buildQuotaForecast(response, accounts);
    host.dataset.state = view.state;
    if (view.state === 'off') { host.hidden = true; return; }
    if (view.state !== 'ready') {
      host.replaceChildren(el('h2', { class: 'card-title', text: 'Allowance forecast' }), el('p', { class: 'card-note', text: view.reason }));
      return;
    }
    host.replaceChildren(...[
      el('h2', { class: 'card-title', text: 'Allowance forecast' }),
      el('p', { class: 'card-note', text: `${view.measured} Estimates follow recent spending; they do not change where work runs.` }),
      view.coverage ? el('p', { class: 'card-note', text: view.coverage }) : null,
      !view.providers.length ? el('p', { class: 'card-line', text: 'No account forecasts are available yet.' }) : null,
      view.providers.map((p) => el('details', { class: 'sheet-block' },
        el('summary', { text: `${p.name}: ${p.outlook}` }),
        p.accounts.map((a) => el('div', { class: 'sheet-block' },
          el('h3', { class: 'row-title', text: a.name }),
          a.lines.map((text) => el('p', { class: 'card-line', text })))),
        p.assumptions.length ? el('details', {}, el('summary', { text: 'What this estimate assumes' }),
          p.assumptions.map((text) => el('p', { class: 'card-note', text }))) : null)),
      el('h3', { class: 'row-title', text: 'Compared with real resets' }),
      el('p', { class: 'card-line', text: view.calibration })].flat(Infinity).filter((node) => node != null));
  };
  Promise.resolve().then(() => get('/quota-pacing', 12_000)).then(render).catch(() => render({ ok: false }));
  return host;
}
