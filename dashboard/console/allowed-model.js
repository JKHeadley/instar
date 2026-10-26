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
// The rule for "needs a look", the words for a guard's state and the count itself
// live in shared-counts.js (guardNeedsLook / guardWord / guardsNeedingLook): the
// same source Home's card and the Machines page read, scope stated.
import { guardWord, guardNeedsLook, guardsNeedingLook } from './shared-counts.js';
export { guardWord };
export function needsLook(g) { return guardNeedsLook(g); }

/** Which writes a row offers. Only this machine's rows can be written; peers never. */
export function guardActions(g, local) {
  if (!local || !g.loadBearing) return [];
  if (g.loadBearingAccepted) return ['stop-accepting'];
  if (g.loadBearingGap) return ['accept'];
  return [];
}

/**
 * Every guard row, this machine first. `res` is GET /guards (optionally ?scope=pool).
 * Returns { ok, look, others, failed, multi, selfName, counts, scopeWords }.
 * `counts.look` is the shared count; `failed` (machines that could not answer) is
 * listed apart and never inside it.
 */
export function buildGuards(res, { names = null } = {}) {
  const g = guardsNeedingLook(res, { scope: 'pool', names });
  if (!g.ok) return { ok: false, reason: g.reason };
  const decorate = (r) => ({ ...r, end: '', where: r.machine || g.selfName || 'this machine', actions: guardActions(r.record, r.local) });
  const look = g.rows.map(decorate);
  const others = g.others.map(decorate);
  return {
    ok: true, look, others, multi: g.multi, selfName: g.selfName, scopeWords: g.scopeWords, machines: g.machines,
    failed: g.cantTell.map((f) => ({ key: `failed:${f.machineId}`, main: f.machine, sub: `Can’t tell: ${f.words}`, tone: 'unknown' })),
    counts: { look: look.length, others: others.length, accepted: g.accepted.length, total: g.all.length, cantTell: g.cantTell.length },
  };
}

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

// The server's honest state (GET /features* → `effective`, spec
// feature-transition-applies-action §2.3): what the switch says vs what the setting
// is vs what this process started with. The short word sits beside the row; the
// server's own sentence (`effective.summary`) is the one shown in full.
export const EFFECTIVE_WORD = {
  on: 'On', off: 'Off', 'on-after-restart': 'On after a restart', 'off-after-restart': 'Off after a restart',
  'recorded-only': 'Recorded, not applied', 'not-recorded': 'Setting on, switch off',
};
const NEEDS_NOTICE = new Set(['on-after-restart', 'off-after-restart', 'recorded-only', 'not-recorded']);
const READ_ONLY_FALLBACK = 'This switch is read-only in this version.';

function readEffective(e) {
  if (!e || typeof e !== 'object' || typeof e.status !== 'string') return null;
  return {
    status: e.status,
    summary: typeof e.summary === 'string' && e.summary ? e.summary : null,
    detail: typeof e.detail === 'string' && e.detail ? e.detail : null,
    recorded: e.recorded === true, configured: e.configured === true,
    lastAttempt: e.lastAttempt && typeof e.lastAttempt === 'object' ? e.lastAttempt : null,
  };
}

export function flattenFeature(f) {
  const def = (f && f.definition) || {};
  const st = (f && f.state) || {};
  const effective = readEffective(f && f.effective);
  const state = st.discoveryState || 'undiscovered';
  const switchable = def.switchable !== false;
  const readOnlyReason = switchable ? null : (def.honestyNote || (effective && effective.detail) || READ_ONLY_FALLBACK);
  // The short word: the server's honest status when it sent one; the discovery state only from an older server.
  const word = effective ? (EFFECTIVE_WORD[effective.status] || effective.status.replace(/-/g, ' ')) : (STATE_WORD[state] || state);
  return {
    id: def.id, name: def.name || def.id, oneLiner: def.oneLiner || '', fullDescription: def.fullDescription || '',
    category: def.category || 'other', tier: def.consentTier || 'informational',
    dataImplications: Array.isArray(def.dataImplications) ? def.dataImplications : [],
    reversibilityNote: def.reversibilityNote || '',
    state,
    // `on` is the switch's own position (which action the switch offers); what is actually
    // in force is `effective` and the sentence below.
    on: switchable ? state === 'enabled' : !!(effective && effective.status === 'on'),
    effectiveOn: effective ? effective.status === 'on' : state === 'enabled',
    switchable, readOnlyReason, effective,
    stateWord: word,
    stateText: effective && effective.summary ? effective.summary : (STATE_WORD[state] || state),
    notice: !!(effective && NEEDS_NOTICE.has(effective.status)),
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
  return { ok: true, groups, on: flat.filter((f) => f.effectiveOn).length, total: flat.length };
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
 * A refused transition in one plain sentence. A read-only feature (409
 * FEATURE_NOT_SWITCHABLE) and an expired or invalid dashboard unlock (401
 * OPERATOR_PROOF_INVALID) are named as what they are, never as success.
 */
export function refusalText(r) {
  const e = r && r.data && r.data.error;
  const code = e && typeof e === 'object' ? e.code : null;
  const msg = e && typeof e === 'object' && typeof e.message === 'string' && e.message ? e.message : null;
  if (code === 'FEATURE_NOT_SWITCHABLE' || (r && r.status === 409 && !code)) return `This switch is read-only: ${msg || READ_ONLY_FALLBACK}`;
  if (code === 'OPERATOR_PROOF_INVALID' || (r && r.status === 401)) return msg || 'Your dashboard unlock has expired. Unlock with your PIN again and retry.';
  if (r && r.status === 0) return msg || 'The server could not be reached.';
  return errText(e, r ? r.status : 0);
}

/**
 * What a successful enable/disable transition actually did to the setting
 * (`apply` from POST /features/:id/transition). The switch recorded the choice;
 * only `applied` means the setting followed it.
 * Returns { applied, outcome, text } — `text` is the sentence to show.
 */
export function applyText(name, direction, data) {
  const on = direction === 'enable';
  const apply = data && data.apply && typeof data.apply === 'object' ? data.apply : null;
  const eff = readEffective(data && data.effective);
  const tail = eff && eff.summary ? ` ${eff.summary}` : '';
  if (!apply) {
    // An older server sends no `apply`: it recorded the choice and said nothing about the setting.
    return { applied: null, outcome: null, text: `${name} is recorded as ${on ? 'on' : 'off'}; the server did not say whether the setting changed.${tail}` };
  }
  const detail = apply.detail ? `: ${String(apply.detail).replace(/\.$/, '')}` : '';
  if (apply.outcome === 'applied') {
    // The setting followed; the server's sentence still says whether a restart is needed.
    return { applied: true, outcome: 'applied', text: eff && eff.summary ? `${name}: ${eff.summary}` : `${name} is ${on ? 'on' : 'off'}.` };
  }
  const how = apply.outcome === 'refused' ? 'was refused' : apply.outcome === 'failed' ? 'failed' : 'was not made';
  return { applied: false, outcome: apply.outcome, text: `${name} is recorded as ${on ? 'on' : 'off'}, but the setting change ${how}${detail}.${tail}` };
}

/**
 * Walk a feature to "enabled" one server step at a time.
 * deps: getInfo(id) → { ok, data } (GET /features/:id),
 *       transition(id, body) → { ok, status, data } (POST /features/:id/transition),
 *       confirmChallenge(feature) → Promise<boolean> (the operator confirms the activation),
 *       onStep?(state)
 * Resolves { ok, state, steps:[...], message, apply?, readOnly?, cancelled? }.
 * `ok` is true only when the setting itself followed the switch (or an older server
 * reported no apply result at all).
 */
export async function walkToEnabled(feature, deps, maxSteps = 6) {
  const steps = [];
  if (feature && feature.switchable === false) return { ok: false, readOnly: true, state: feature.state, steps, message: `This switch is read-only: ${feature.readOnlyReason || READ_ONLY_FALLBACK}` };
  for (let i = 0; i < maxSteps; i++) {
    const info = await deps.getInfo(feature.id);
    if (!info.ok) return { ok: false, steps, message: `Couldn't read the feature: ${info.reason}.` };
    const f = flattenFeature(info.data);
    if (!f.switchable) return { ok: false, readOnly: true, state: f.state, steps, message: `This switch is read-only: ${f.readOnlyReason}` };
    if (f.state === 'enabled') {
      // Already recorded on: say what is actually in force rather than "On.".
      if (f.effective && f.effective.status === 'recorded-only') return { ok: false, state: 'enabled', steps, message: f.effective.summary || 'Recorded as on, but the setting is still off.' };
      return { ok: true, state: 'enabled', steps, message: f.effective && f.effective.summary ? f.effective.summary : 'On.' };
    }
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
    if (!r.ok) {
      const code = r.data && r.data.error && r.data.error.code;
      return { ok: false, state: f.state, steps, message: refusalText(r), readOnly: code === 'FEATURE_NOT_SWITCHABLE' || undefined, proofInvalid: code === 'OPERATOR_PROOF_INVALID' || r.status === 401 || undefined };
    }
    steps.push(next);
    if (deps.onStep) deps.onStep(next);
    if (next === 'enabled') {
      const a = applyText(feature.name || feature.id, 'enable', r.data);
      return { ok: a.applied !== false, state: 'enabled', steps, message: a.text, apply: (r.data && r.data.apply) || null };
    }
  }
  return { ok: false, steps, message: 'It took more steps than expected; stopped to be safe.' };
}

/** Turn off: one step, only when the server lists it. */
export function canTurnOff(f) { if (f.switchable === false) return false; return Array.isArray(f.validTransitions) ? f.validTransitions.includes('disabled') : f.state === 'enabled'; }

/** Undo of a turn-off is offered only where re-enabling needs no fresh consent. */
export function canUndoOff(f) { return !needsConsent(f.tier); }

/** The page's arrival facts. */
export function facts({ profile, guards, features, suggestions }) {
  const out = [];
  if (profile && profile.ok) out.push({ n: PROFILE_LABEL[profile.profile], label: 'profile' });
  if (guards && guards.ok && guards.counts.look) out.push({ n: guards.counts.look, label: `${guards.counts.look === 1 ? 'check needs a look' : 'checks need a look'}${guards.scopeWords ? ' ' + guards.scopeWords : ''}`, tone: 'attn', href: '#/settings/allowed?s=guards' });
  if (features && features.ok) out.push({ n: `${features.on} of ${features.total}`, label: 'features on', href: '#/settings/allowed?s=features' });
  if (suggestions && suggestions.ok && suggestions.items.length) out.push({ n: suggestions.items.length, label: suggestions.items.length === 1 ? 'suggestion' : 'suggestions' });
  return out;
}
