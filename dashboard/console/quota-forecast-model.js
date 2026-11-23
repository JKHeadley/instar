// Read-only presentation of the existing quota-pacing/1 measurement.
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const number = (n) => String(Math.round(n * 10) / 10);
const percent = (n) => `${Math.round(Math.min(100, Math.max(0, n)))}%`;
const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
const plural = (n, one, many = `${one}s`) => n === 1 ? one : many;

function calibrationLine(c) {
  const scored = count(c?.scored);
  let line = scored
    ? `${scored} ${plural(scored, 'forecast')} checked against real resets. ${count(c.inside)} finished within the predicted range.${finite(c.meanAbsError) ? ` The average error was ${number(c.meanAbsError)} percentage points.` : ''} These are observed comparisons, not a guarantee.`
    : 'No forecasts have been checked against real resets yet.';
  const censored = count(c?.censored);
  const missing = Array.isArray(c?.outcomes) ? c.outcomes.filter((o) => o?.status === 'no-forecast').length : 0;
  if (censored) line += ` ${censored} ${plural(censored, 'reset')} lacked a recent final reading.`;
  if (missing) line += ` ${missing} ${plural(missing, 'reset')} had no usable forecast.`;
  return line;
}

function accountView(a, names, now) {
  const lines = [];
  const w = a.weekly;
  const reset = Date.parse(w?.resetsAt);
  if (a.disagree) lines.push('Cannot estimate: the machines disagree about this account.');
  else if (!a.fresh) lines.push('Cannot estimate: this account needs a fresh reading.');
  else if (a.identityUnknown) lines.push('Cannot estimate confidently until the account identity is confirmed.');
  else if (!w || !finite(w.central) || !finite(w.low) || !finite(w.high)) lines.push('Not enough history to estimate weekly usage at reset.');
  else if (!Number.isFinite(reset) || reset <= now) lines.push('Cannot estimate: the weekly reset needs a fresh reading.');
  else {
    lines.push(`At the current pace, about ${percent(w.central)} of the weekly allowance will be used by reset.${w.central >= 100 ? ' The account is expected to reach its limit.' : ''}`);
    lines.push(`Recent spending rates suggest ${percent(w.low)} to ${percent(w.high)} used by reset. This is a pace range, not a confidence interval.`);
    lines.push(`Weekly reset: ${new Date(reset).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`);
    if (w.usesHourlyRows) lines.push('Some older readings are hourly summaries.');
  }
  return { name: names.get(a.accountId) || 'Unnamed account', lines };
}

export function buildQuotaForecast(response, accounts = [], now = Date.now()) {
  const data = response?.data;
  const unavailable = { state: 'unavailable', reason: 'The forecast could not be read. Account controls are still available.' };
  if (!response?.ok) return (data?.error === 'quota-pacing-off' || response?.reason === 'switched off on this agent') ? { state: 'off' } : unavailable;
  if (data?.schema !== 'quota-pacing/1' || !Array.isArray(data.providers)) return unavailable;
  const generated = Date.parse(data.generatedAt);
  // An independently loaded card must not present a cached response as a current outlook.
  if (!Number.isFinite(generated) || generated > now + 60_000 || now - generated > 5 * 60_000) {
    return { state: 'stale', reason: 'The forecast response is out of date. Refresh to check again.' };
  }
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const providers = data.providers.filter((p) => p && Array.isArray(p.accounts)).map((p) => ({
    name: typeof p.label === 'string' ? p.label : 'Provider',
    outlook: typeof p.plain === 'string' ? p.plain : 'There is not enough history for an outlook.',
    accounts: p.accounts.filter((a) => a && typeof a.accountId === 'string').map((a) => accountView(a, names, now)),
    assumptions: Array.isArray(p.assumptions) ? p.assumptions.filter((s) => typeof s === 'string') : [],
  }));
  const failed = Array.isArray(data.sources) ? data.sources.filter((s) => s?.status === 'failed').length : 0;
  return {
    state: 'ready', providers, calibration: calibrationLine(data.calibration),
    coverage: failed ? `${failed} ${plural(failed, 'machine')} could not be read. The outlook may be incomplete.` : null,
    measured: `Forecast calculated ${new Date(generated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`,
  };
}
