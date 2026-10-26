// "What I'm allowed to do" — pure view-model
// (docs/specs/console-features/people-settings.md, "What I'm allowed to do").
//
// Every decision lives here so it can be tested: the profile sentence and what a
// switch would change, the safety-check listing (local vs other machines), the
// suggestions, and the feature state machine walk. The walk never assumes a path:
// it re-reads the server's validTransitions before every step.

import { ago } from './home-model.js';

// ── Profile ───────────────────────────────────────────────────────────────
export const PROFILES = ['cautious', 'supervised', 'collaborative', 'autonomous'];

export const PROFILE_LABEL = { cautious: 'Cautious', supervised: 'Supervised', collaborative: 'Collaborative', autonomous: 'Autonomous' };

export const PROFILE_SENTENCE = {
  cautious: 'I ask you before everything I do.',
  supervised: 'I handle routine work on my own and ask you before important decisions.',
  collaborative: 'I make most decisions on my own and keep you informed.',
  autonomous: 'I handle everything myself and tell you what I did.',
};

// Mirror of PROFILE_DEFAULTS in src/core/AutonomyProfileManager.ts (the fields this
// page shows). A switch applies these only where the settings file does not already
// pin a value, so the page re-reads `resolved` after every switch.
export const PROFILE_DEFAULTS = {
  cautious: { autoApplyUpdates: false, autoRestart: false, trustAutoElevate: false, evolutionApprovalMode: 'ai-assisted' },
  supervised: { autoApplyUpdates: true, autoRestart: false, trustAutoElevate: true, evolutionApprovalMode: 'ai-assisted' },
  collaborative: { autoApplyUpdates: true, autoRestart: true, trustAutoElevate: true, evolutionApprovalMode: 'ai-assisted' },
  autonomous: { autoApplyUpdates: true, autoRestart: true, trustAutoElevate: true, evolutionApprovalMode: 'autonomous' },
};

const yesNo = (b) => (b ? 'yes' : 'no');

/** "What that means right now", from the server's resolved state only. */
export function meaningRows(resolved) {
  if (!resolved || typeof resolved !== 'object') return [];
  const rows = [];
  if (typeof resolved.autoApplyUpdates === 'boolean') rows.push({ label: 'Updates install themselves', text: yesNo(resolved.autoApplyUpdates) });
  if (typeof resolved.autoRestart === 'boolean') rows.push({ label: 'I restart after updates', text: yesNo(resolved.autoRestart) });
  if (typeof resolved.trustAutoElevate === 'boolean') rows.push({ label: 'I ask before raising my own trust', text: yesNo(!resolved.trustAutoElevate) });
  return rows;
}

const CHANGE_WORDS = {
  autoApplyUpdates: (v) => (v ? 'Updates will install without asking.' : 'Updates will wait for you to install them.'),
  autoRestart: (v) => (v ? 'I will restart myself after an update.' : 'I will wait for you before restarting after an update.'),
  trustAutoElevate: (v) => (v ? 'I will raise my own trust when I have earned it.' : 'I will ask you before raising my own trust.'),
  evolutionApprovalMode: (v) => (v === 'autonomous' ? 'Approved changes to myself will apply without asking you first.' : 'Changes to myself will wait for your approval.'),
};

/** What switching from the current resolved state to `target` would change, in sentences. */
export function profileChanges(resolved, target) {
  const d = PROFILE_DEFAULTS[target];
  if (!d) return [];
  const out = [];
  for (const k of Object.keys(CHANGE_WORDS)) {
    if (resolved && resolved[k] !== undefined && resolved[k] === d[k]) continue;
    out.push(CHANGE_WORDS[k](d[k]));
  }
  return out;
}

/** The profile block, or an honest reason. */
export function buildProfile(res) {
  if (!res.ok) {
    if (/\b404\b/.test(res.reason || '')) return { ok: false, reason: 'Autonomy isn’t set up on this agent.' };
    return { ok: false, reason: `Couldn't read the autonomy profile: ${res.reason}.` };
  }
  const d = res.data || {};
  if (!PROFILES.includes(d.profile)) return { ok: false, reason: 'The autonomy profile answered without a known profile.' };
  const desc = Object.fromEntries((Array.isArray(d.availableProfiles) ? d.availableProfiles : [])
    .filter((p) => p && PROFILES.includes(p.level)).map((p) => [p.level, String(p.description || '')]));
  return {
    ok: true,
    profile: d.profile,
    sentence: PROFILE_SENTENCE[d.profile],
    steps: PROFILES.map((p) => ({ id: p, label: PROFILE_LABEL[p], desc: desc[p] || PROFILE_SENTENCE[p], current: p === d.profile })),
    meaning: meaningRows(d.resolved),
    resolved: d.resolved || null,
    summary: typeof d.summary === 'string' ? d.summary : null,
  };
}

/** History newest first. The route answers { history: [...] }. */
export function buildHistory(res, now = Date.now()) {
  if (!res.ok) return { ok: false, reason: `Couldn't read the history: ${res.reason}.` };
  const list = res.data && Array.isArray(res.data.history) ? res.data.history : null;
  if (!list) return { ok: false, reason: 'The history answered without its list.' };
  return {
    ok: true,
    rows: list.filter(Boolean).slice().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).map((h, i) => ({
      key: `h${i}:${h.at}`,
      main: `${PROFILE_LABEL[h.from] || h.from || '?'} → ${PROFILE_LABEL[h.to] || h.to || '?'}`,
      sub: h.reason || '',
      end: ago(h.at, now) || '',
    })),
  };
}

// ── Safety checks ─────────────────────────────────────────────────────────
const GUARD_WORDS = {
  'on-confirmed': 'on', 'on-unverified': 'on, not confirmed', 'on-stale': 'on, gone quiet', 'on-blind': 'on, can’t see it working',
  'on-dry-run': 'watching only', off: 'off', 'diverged-pending-restart': 'changed, waiting for a restart', errored: 'errored',
  missing: 'missing', 'off-runtime-divergent': 'off while running',
};
const NEEDS_LOOK = new Set(['on-unverified', 'on-stale', 'on-blind', 'diverged-pending-restart', 'errored', 'missing', 'off-runtime-divergent']);

export function guardWord(g) {
  if (g.loadBearingAccepted) return 'risk accepted';
  if (g.loadBearingGap) return g.effective === 'on-dry-run' ? 'watching only, nothing guards it' : 'off, nothing guards it';
  if (g.loadBearingSoaking) return 'watching only, trial run';
  if (g.effective === 'off' && g.offClass === 'dark-default') return 'off by design';
  if (g.effective === 'off' && g.offClass === 'diverged-from-default') return 'off, should be on';
  return GUARD_WORDS[g.effective] || String(g.effective || 'unknown').replace(/-/g, ' ');
}

/** Off where it should be on, or on but not proven. */
export function needsLook(g) {
  if (g.loadBearingAccepted) return false;
  if (g.loadBearingGap) return true;
  if (g.effective === 'off') return g.offClass === 'diverged-from-default';
  return NEEDS_LOOK.has(g.effective);
}

function humanKey(key) {
  return String(key || 'A safety check').replace(/^monitoring\./, '').replace(/\.enabled$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Which writes a row offers. Only this machine's rows can be written; peers never. */
export function guardActions(g, local) {
  if (!local || !g.loadBearing) return [];
  if (g.loadBearingAccepted) return ['stop-accepting'];
  if (g.loadBearingGap) return ['accept'];
  return [];
}

function guardRow(g, machine, local) {
  const look = needsLook(g);
  return {
    key: `${machine.id || 'self'}:${g.key}`,
    guardKey: g.key,
    main: g.criticalPath ? `${g.criticalPath}` : humanKey(g.key),
    sub: [guardWord(g), machine.name].filter(Boolean).join(' · '),
    end: '',
    tone: look ? 'attn' : g.loadBearingAccepted ? 'unknown' : undefined,
    local, machine: machine.name, where: machine.name || machine.here || 'this machine', needsLook: look, record: g, actions: guardActions(g, local),
  };
}

/**
 * Every guard row, this machine first. `res` is GET /guards (optionally ?scope=pool).
 * Returns { ok, look, others, failed, multi, selfName, counts }.
 */
export function buildGuards(res) {
  if (!res.ok) return { ok: false, reason: `Couldn't read the safety checks: ${res.reason}.` };
  const d = res.data || {};
  if (!Array.isArray(d.guards)) return { ok: false, reason: 'The safety checks answered without their list.' };
  const pool = d.pool && typeof d.pool === 'object' ? d.pool : null;
  const peers = pool && Array.isArray(pool.machines) ? pool.machines : [];
  const failed = pool && Array.isArray(pool.failed) ? [...pool.failed] : [];
  const multi = peers.length + failed.length > 0;
  const selfName = d.nickname || (multi ? 'this machine' : null);
  const rows = d.guards.filter((g) => g && g.key).map((g) => guardRow(g, { id: d.machineId || 'self', name: multi ? selfName : null, here: d.nickname }, true));
  for (const m of peers) {
    const name = m.nickname || m.machineId || 'another machine';
    if (!Array.isArray(m.guards)) { failed.push({ machineId: m.machineId, nickname: name, reason: 'no list' }); continue; }
    for (const g of m.guards) if (g && g.key) rows.push(guardRow(g, { id: m.machineId, name }, false));
  }
  const look = rows.filter((r) => r.needsLook);
  const others = rows.filter((r) => !r.needsLook);
  const accepted = rows.filter((r) => r.record.loadBearingAccepted);
  return {
    ok: true, look, others, multi, selfName,
    failed: failed.map((f) => ({ key: `failed:${f.machineId}`, main: f.nickname || f.machineId || 'A machine', sub: `Can’t tell: ${FAILED_WORDS[f.reason] || String(f.reason || 'no answer').replace(/-/g, ' ')}`, tone: 'unknown' })),
    counts: { look: look.length, others: others.length, accepted: accepted.length, total: rows.length },
  };
}
const FAILED_WORDS = {
  'no-known-url': 'no address known for it', offline: 'it is offline', 'url-rejected': 'its address was refused',
  'route-missing': 'it needs an update to report', unauthorized: 'it refused the request', timeout: 'no answer in time',
  unreachable: 'it could not be reached', error: 'it answered with an error', 'no list': 'it answered without a list',
};

// ── Suggestions ───────────────────────────────────────────────────────────
export function buildSuggestions(res, now = Date.now()) {
  // A missing tracker (404) hides the section with no claim either way.
  if (!res.ok) return { ok: false, hidden: /\b404\b/.test(res.reason || ''), reason: `Couldn't read suggestions: ${res.reason}.` };
  const d = res.data || {};
  const opps = Array.isArray(d.activeOpportunities) ? d.activeOpportunities : [];
  const items = opps.filter((o) => o && o.type).map((o) => ({
    key: `opp:${o.type}`, type: o.type, kind: 'opportunity',
    text: o.reason || 'I may have earned a little more room.',
    evidence: o.evidence || '',
    how: o.type === 'profile-upgrade' && PROFILE_LABEL[o.suggested]
      ? `To allow this, move the profile to ${PROFILE_LABEL[o.suggested]}, or tell me in chat.`
      : 'To allow this, tell me in chat.',
  }));
  const rs = d.rubberStamp;
  if (rs && rs.detected && !(rs.dismissedUntil && Date.parse(rs.dismissedUntil) > now)) {
    const n = Number(rs.consecutiveFastApprovals) || 0;
    const secs = Number(rs.avgLatencyMs) > 0 ? Math.round(Number(rs.avgLatencyMs) / 1000) : null;
    items.push({
      key: 'rubber-stamp', kind: 'rubber-stamp',
      text: `You've approved my last ${n} ${n === 1 ? 'request' : 'requests'} quickly${secs !== null ? ` (about ${secs} s each)` : ''}. If that's on purpose, I can stop asking for these.`,
      evidence: '', how: '',
    });
  }
  return { ok: true, items };
}

// ── Features ──────────────────────────────────────────────────────────────
export const CATEGORY_LABEL = { safety: 'Safety & trust', communication: 'Communication', infrastructure: 'Infrastructure', intelligence: 'Intelligence' };
const CATEGORY_ORDER = ['safety', 'communication', 'infrastructure', 'intelligence'];
export const STATE_WORD = { enabled: 'On', disabled: 'Off', undiscovered: 'Not tried', aware: 'Seen', interested: 'Interested', deferred: 'Later', declined: 'Declined' };
const CONSENT_TIERS = new Set(['network', 'self-governing']);

export function flattenFeature(f) {
  const def = (f && f.definition) || {};
  const st = (f && f.state) || {};
  return {
    id: def.id, name: def.name || def.id, oneLiner: def.oneLiner || '', fullDescription: def.fullDescription || '',
    category: def.category || 'other', tier: def.consentTier || 'informational',
    dataImplications: Array.isArray(def.dataImplications) ? def.dataImplications : [],
    reversibilityNote: def.reversibilityNote || '',
    state: st.discoveryState || 'undiscovered', on: st.discoveryState === 'enabled',
    validTransitions: Array.isArray(f && f.validTransitions) ? f.validTransitions : null,
  };
}

export function buildFeatures(res) {
  if (!res.ok) {
    if (/\b501\b/.test(res.reason || '')) return { ok: false, reason: 'Feature switches aren’t set up on this agent.' };
    return { ok: false, reason: `Couldn't read the features: ${res.reason}.` };
  }
  const list = res.data && Array.isArray(res.data.features) ? res.data.features : null;
  if (!list) return { ok: false, reason: 'The feature list answered without its features.' };
  const flat = list.map(flattenFeature).filter((f) => f.id);
  const cats = [...CATEGORY_ORDER, ...new Set(flat.map((f) => f.category).filter((c) => !CATEGORY_ORDER.includes(c)))];
  const groups = cats.map((c) => ({ id: c, label: CATEGORY_LABEL[c] || String(c).replace(/^./, (x) => x.toUpperCase()), features: flat.filter((f) => f.category === c) })).filter((g) => g.features.length);
  return { ok: true, groups, on: flat.filter((f) => f.on).length, total: flat.length };
}

export function needsConsent(tier) { return CONSENT_TIERS.has(tier); }

/** The next step toward "enabled", from the server's own list. Null when there is none. */
export function nextStepToEnabled(valid) {
  if (!Array.isArray(valid)) return null;
  for (const s of ['enabled', 'interested', 'aware']) if (valid.includes(s)) return s;
  return null;
}

/** The consent record built from exactly the data implications the sheet showed. */
export function consentRecord(feature, now = Date.now()) {
  return {
    userId: 'default', featureId: feature.id, consentTier: feature.tier,
    dataImplications: feature.dataImplications, consentedAt: new Date(now).toISOString(), mechanism: 'explicit-written',
  };
}

function errText(e, status) {
  if (e && typeof e === 'object') return String(e.message || e.code || `The server answered ${status}.`);
  if (typeof e === 'string') return e;
  return `The server answered ${status}.`;
}

/**
 * Walk a feature to "enabled" one server step at a time.
 * deps: getInfo(id) → { ok, data } (GET /features/:id),
 *       transition(id, body) → { ok, status, data } (POST /features/:id/transition),
 *       confirmChallenge(feature) → Promise<boolean> (the operator confirms the activation),
 *       onStep?(state)
 * Resolves { ok, state, steps:[...], message }.
 */
export async function walkToEnabled(feature, deps, maxSteps = 6) {
  const steps = [];
  for (let i = 0; i < maxSteps; i++) {
    const info = await deps.getInfo(feature.id);
    if (!info.ok) return { ok: false, steps, message: `Couldn't read the feature: ${info.reason}.` };
    const f = flattenFeature(info.data);
    if (f.state === 'enabled') return { ok: true, state: 'enabled', steps, message: 'On.' };
    const next = nextStepToEnabled(f.validTransitions);
    if (!next) return { ok: false, state: f.state, steps, message: `It can't be turned on from “${STATE_WORD[f.state] || f.state}”.` };
    const body = { to: next, trigger: 'explicit-ask', context: 'Turned on from the console' };
    if (next === 'enabled' && needsConsent(feature.tier)) body.consentRecord = consentRecord(feature);
    let r = await deps.transition(feature.id, body);
    const err = r.data && r.data.error;
    if (!r.ok && err && err.code === 'ACTIVATION_CHALLENGE_REQUIRED') {
      const challenge = err.details && err.details.challenge;
      if (!challenge) return { ok: false, state: f.state, steps, message: 'The server asked for a confirmation but sent no challenge.' };
      const yes = await deps.confirmChallenge(feature);
      if (!yes) return { ok: false, state: f.state, steps, message: 'Not turned on. Nothing changed after the last step.', cancelled: true };
      r = await deps.transition(feature.id, { ...body, consentRecord: consentRecord(feature), activationChallenge: challenge });
    }
    if (!r.ok) return { ok: false, state: f.state, steps, message: errText(r.data && r.data.error, r.status) };
    steps.push(next);
    if (deps.onStep) deps.onStep(next);
  }
  return { ok: false, steps, message: 'It took more steps than expected; stopped to be safe.' };
}

/** Turn off: one step, only when the server lists it. */
export function canTurnOff(f) { return Array.isArray(f.validTransitions) ? f.validTransitions.includes('disabled') : f.state === 'enabled'; }

/** Undo of a turn-off is offered only where re-enabling needs no fresh consent. */
export function canUndoOff(f) { return !needsConsent(f.tier); }

/** The page's arrival facts. */
export function facts({ profile, guards, features, suggestions }) {
  const out = [];
  if (profile && profile.ok) out.push({ n: PROFILE_LABEL[profile.profile], label: 'profile' });
  if (guards && guards.ok && guards.counts.look) out.push({ n: guards.counts.look, label: guards.counts.look === 1 ? 'check needs a look' : 'checks need a look', tone: 'attn', href: '#/settings/allowed?s=guards' });
  if (features && features.ok) out.push({ n: `${features.on} of ${features.total}`, label: 'features on', href: '#/settings/allowed?s=features' });
  if (suggestions && suggestions.ok && suggestions.items.length) out.push({ n: suggestions.items.length, label: suggestions.items.length === 1 ? 'suggestion' : 'suggestions' });
  return out;
}
