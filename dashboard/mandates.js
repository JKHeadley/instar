/**
 * mandates.js — the Mandates dashboard tab (coordination-mandate spec, decision 2A).
 *
 * The OPERATOR's surface for the Coordination Mandate engine: see every mandate
 * (with live authorship verification), issue a new one, revoke one, and read the
 * hash-chained decision audit. Issuance + revocation require the dashboard PIN —
 * typed here at action time, sent once, NEVER stored (no localStorage, no module
 * state). The Bearer token alone cannot perform either; that is the engine's
 * design, and this tab is the human-authenticated surface it points at.
 *
 * Same shape as process-health.js / preferences-learning.js: pure renderers +
 * createController({ doc, els, fetchImpl }) so index.html stays a thin shim.
 */

const REFRESH_MS = 30_000;

// The A/A/B first-mandate shape, prefilled so the operator edits rather than authors.
const AUTHORITIES_TEMPLATE = JSON.stringify([
  { action: 'exchange-read-credential', bounds: { credentialScope: 'read-only', onMachine: true } },
  { action: 'sign-code-review', bounds: { artifact: 'migration-port', mutual: true } },
], null, 2);

// Mirrors FLOOR_ACTIONS in src/permissions/RolePolicy.ts — the enumerated
// never-discretionary actions a user grant can lift. Kept in sync by the
// dashboard-mandatesTab test, which compares this list against the source enum.
const FLOOR_ACTIONS = [
  'money-movement',
  'prod-deploy',
  'credential-access',
  'destructive-data',
  'external-send',
  'grant-authority',
];

// Mobile-first: the operator picks a duration, never types a timestamp.
// The submit handler clamps to the mandate's own expiry (a grant can never
// outlive the mandate that carries it — the server enforces the same rule).
const GRANT_DURATIONS = [
  { label: '15 minutes', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '24 hours', minutes: 1440 },
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shortFp(fp) {
  const s = String(fp ?? '');
  return s.length > 12 ? s.slice(0, 8) + '…' : s;
}

function fmtWhen(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return String(iso); }
}

/** The registry name for a Slack id, or the id itself when we don't know them. */
function userName(slackUserId, slackUsers) {
  const u = (slackUsers || []).find((x) => x.slackUserId === slackUserId);
  return u ? u.name : slackUserId;
}

// Operator-Surface Quality (constitution): the card speaks plain language, never
// the slugs/JSON the data model stores. These maps turn the stored enum/bounds
// into the sentence a non-engineer would say. Unknown values fall back to a
// de-slugified phrase — never a raw token dumped at the operator.

// Both the coordination-mandate authority actions AND the RolePolicy floor
// actions, in plain language. Returns the RAW human string; callers esc() it.
const ACTION_PHRASES = {
  'exchange-read-credential': 'exchange a read-only credential',
  'sign-code-review': 'co-sign a code review',
  'money-movement': 'move money',
  'prod-deploy': 'deploy to production',
  'credential-access': 'use a credential',
  'destructive-data': 'run a destructive data operation',
  'external-send': 'send something externally',
  'grant-authority': 'grant authority to others',
};
function humanAction(slug) {
  const s = String(slug ?? '');
  return ACTION_PHRASES[s] || s.replace(/-/g, ' ');
}

/** "you" when the authorizer is the operator-via-PIN; otherwise the raw name. */
function humanAuthorizer(authorizedBy) {
  const s = String(authorizedBy ?? '');
  return /operator|dashboard pin/i.test(s) ? 'you' : s;
}

/** A short title from the operator's scope name (de-slugified, not the raw slug). */
function humanScope(scope) {
  const s = String(scope ?? '').trim();
  if (!s) return 'Permission slip';
  const words = s.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Join phrases the way a person speaks them: "a, b and c". */
function joinHuman(parts) {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/**
 * One plain sentence describing what the mandate authorizes + when it ends —
 * the card's primary, human-language headline (no slugs, no JSON, no
 * fingerprints). Each interpolated action is escaped at the call site.
 */
function humanSummary(m) {
  const acts = (m.authorities || []).map((a) => esc(humanAction(a.action)));
  const agents = (m.agents || []).filter(Boolean);
  const who = agents.length >= 2 ? 'two agents' : 'an agent';
  const when = fmtWhen(m.expiresAt);
  if (acts.length === 0) {
    return `A permission slip for ${who} that delegates no actions yet. Expires ${when}.`;
  }
  return `Lets ${who} ${joinHuman(acts)}. Expires ${when}.`;
}

/** The grants a mandate already carries, in plain operator language. */
export function renderGrants(m, slackUsers) {
  const grants = Array.isArray(m.grants) ? m.grants : [];
  if (grants.length === 0) return '';
  const rows = grants.map((g) => {
    const expired = Date.parse(g.expiresAt) < Date.now();
    const badge = expired
      ? '<span class="mnd-badge mnd-dead">expired</span>'
      : '<span class="mnd-badge mnd-ok">active</span>';
    const name = userName(g.grantedTo, slackUsers);
    // The Slack id is support metadata, never the headline — shown muted only
    // when it differs from the name we render (an unknown id IS the name).
    const idDetail = name !== g.grantedTo ? ` <span class="mnd-grant-id">(${esc(g.grantedTo)})</span>` : '';
    return `<li>${badge} <strong>${esc(name)}</strong>${idDetail} can ${esc(humanAction(g.floorAction))} until ${fmtWhen(g.expiresAt)} — authorized by ${esc(humanAuthorizer(g.authorizedBy))}</li>`;
  }).join('');
  return `<div class="mnd-grants-head">Who this slip already lets act:</div><ul class="mnd-grants">${rows}</ul>`;
}

/**
 * The add-grant form for an ACTIVE mandate — the card's PRIMARY action, always
 * visible (Operator-Surface Quality: lead with the primary action, never behind
 * a toggle). Mobile-first (the 2026-06-12 lesson, instar#1080): the operator
 * PICKS a person and a duration — the only thing typed is the PIN. A free-text
 * Slack-id input appears only when the user registry has nobody to offer. Action
 * labels read in plain language; the slug is the option VALUE the server needs.
 */
export function renderGrantForm(m, slackUsers) {
  const users = (slackUsers || []).filter((u) => u.slackUserId);
  const granteeField = users.length > 0
    ? `<select class="mnd-grant-field" data-grant-user="${esc(m.id)}">${
        users.map((u) => `<option value="${esc(u.slackUserId)}">${esc(u.name)}${u.orgRole ? ` — ${esc(u.orgRole)}` : ''}</option>`).join('')
      }</select>`
    : `<input type="text" class="mnd-grant-field" data-grant-user="${esc(m.id)}" placeholder="Slack user id (e.g. U0…)" />`;
  const actionField = `<select class="mnd-grant-field" data-grant-action="${esc(m.id)}">${
    FLOOR_ACTIONS.map((a) => `<option value="${a}"${a === 'prod-deploy' ? ' selected' : ''}>${esc(humanAction(a))}</option>`).join('')
  }</select>`;
  const durationField = `<select class="mnd-grant-field" data-grant-duration="${esc(m.id)}">${
    GRANT_DURATIONS.map((d) => `<option value="${d.minutes}"${d.minutes === 60 ? ' selected' : ''}>${d.label}</option>`).join('')
  }</select>`;
  return `<div class="mnd-grant-block">
    <div class="mnd-grant-title">Grant a person an action</div>
    <div class="mnd-grant-row">
      ${granteeField}
      ${actionField}
      <span class="mnd-grant-sep">for</span>
      ${durationField}
      <input type="password" class="mnd-pin" data-grant-pin="${esc(m.id)}" placeholder="Your PIN" autocomplete="off" />
      <button class="mnd-btn mnd-btn-primary" data-grant="${esc(m.id)}">Grant</button>
    </div>
    <span class="mnd-hint">Lets the person you pick take that one action for the window you choose. Confirmed with your PIN — never stored. A grant can never outlive this slip, and revoking the slip ends it.</span>
  </div>`;
}

export function renderMandates(list, slackUsers = []) {
  if (!Array.isArray(list) || list.length === 0) {
    return '<div class="mnd-empty">No mandates issued. The gate is deny-by-default: every delegated agent action refuses until you issue one.</div>';
  }
  return list.map((m) => {
    const expired = Date.parse(m.expiresAt) < Date.now();
    const state = m.revoked ? 'revoked' : expired ? 'expired' : 'active';
    const stateCls = state === 'active' ? 'mnd-ok' : 'mnd-dead';
    const stateLabel = state === 'active' ? 'active' : state === 'revoked' ? 'revoked' : 'expired';
    const authBadge = m.authorshipValid
      ? '<span class="mnd-badge mnd-ok">authorship verified</span>'
      : '<span class="mnd-badge mnd-bad">AUTHORSHIP INVALID</span>';
    // Internals (id, agent fingerprints, scope slug, raw action names, bounds)
    // are SUPPORT metadata, never the headline — kept on one muted line so the
    // operator can quote an id when asking for help, but never has to read JSON.
    const actionSlugs = (m.authorities || []).map((a) => esc(a.action)).filter(Boolean).join(', ') || 'none';
    const referenceLine = `<div class="mnd-meta">For support: id <code>${esc(m.id)}</code> · agents <code>${esc(shortFp(m.agents?.[0]))}</code> + <code>${esc(shortFp(m.agents?.[1]))}</code> · scope <code>${esc(m.scope)}</code> · authorizes ${actionSlugs} · issued by ${esc(m.author)}</div>`;
    // The grant form is the PRIMARY action and renders ABOVE revoke. Revoke is
    // destructive, so it is demoted to a quiet collapsed control, never featured.
    const grantUi = state === 'active' ? renderGrantForm(m, slackUsers) : '';
    const revokeUi = state === 'active'
      ? `<details class="mnd-revoke-details">
           <summary class="mnd-revoke-summary">Revoke this permission slip</summary>
           <div class="mnd-revoke-row">
             <input type="password" class="mnd-pin" data-revoke-pin="${esc(m.id)}" placeholder="Your PIN" autocomplete="off" />
             <input type="text" class="mnd-reason" data-revoke-reason="${esc(m.id)}" placeholder="reason (optional)" />
             <button class="mnd-btn mnd-btn-danger" data-revoke="${esc(m.id)}">Revoke</button>
           </div>
           <span class="mnd-hint">Ends the slip and everything it authorized, right away. This cannot be undone.</span>
         </details>`
      : `<div class="mnd-dead-note">${m.revoked ? `Revoked ${fmtWhen(m.revoked.at)} — ${esc(m.revoked.reason)}` : `Expired ${fmtWhen(m.expiresAt)}`}</div>`;
    return `<div class="mnd-card">
      <div class="mnd-card-head">
        <span class="mnd-scope">${esc(humanScope(m.scope))}</span>
        <span class="mnd-badge ${stateCls}">${stateLabel}</span>
        ${authBadge}
      </div>
      <p class="mnd-summary">${humanSummary(m)}</p>
      ${renderGrants(m, slackUsers)}
      ${grantUi}
      ${referenceLine}
      ${revokeUi}
    </div>`;
  }).join('');
}

/**
 * "Approvals waiting for you" — the agent-proposes/operator-approves surface. The card
 * text is the SERVER-authored `headline` (built from the structured proposal + the
 * registered-user's real name) — we only esc() it, never compose authority from
 * agent-supplied fields. The optional `reason` is rendered as a clearly-secondary,
 * escaped note, never the headline (display-integrity standard). A request held on a
 * different machine shows where to approve instead of a dead button.
 */
export function renderApprovals(requests) {
  const list = (Array.isArray(requests) ? requests : []).filter((r) => r && r.status === 'pending');
  if (list.length === 0) return '';
  return list.map((r) => {
    const headline = esc(r.headline || 'An approval is requested.');
    const reason = r.reason
      ? `<div class="mnd-approval-reason">Echo's reason: ${esc(r.reason)}</div>` : '';
    if (r.heldOnThisMachine === false) {
      return `<div class="mnd-approval-card">
        <div class="mnd-approval-ask">Echo is asking for your approval</div>
        <div class="mnd-approval-headline">${headline}</div>
        ${reason}
        <div class="mnd-dead-note">Asked on <strong>${esc(r.createdOnMachine || 'another machine')}</strong> — open that machine's dashboard to approve.</div>
      </div>`;
    }
    return `<div class="mnd-approval-card">
      <div class="mnd-approval-ask">Echo is asking for your approval</div>
      <div class="mnd-approval-headline">${headline}</div>
      ${reason}
      <div class="mnd-grant-row">
        <input type="password" class="mnd-pin" data-approve-pin="${esc(r.id)}" placeholder="Your PIN" autocomplete="off" />
        <button class="mnd-btn mnd-btn-primary" data-approve="${esc(r.id)}">Approve</button>
        <button class="mnd-btn mnd-btn-quiet" data-deny="${esc(r.id)}">Decline</button>
      </div>
    </div>`;
  }).join('');
}

export function renderAudit(payload) {
  const entries = payload?.entries ?? [];
  const chainOk = payload?.chain?.ok;
  const chainBadge = chainOk === false
    ? '<span class="mnd-badge mnd-bad">CHAIN BROKEN — possible tampering</span>'
    : '<span class="mnd-badge mnd-ok">chain verified</span>';
  if (entries.length === 0) {
    return `<div class="mnd-audit-head">${chainBadge}</div><div class="mnd-empty">No decisions recorded yet.</div>`;
  }
  // Mobile-first (Operator-Surface Quality item 5): each cell carries a
  // data-label so the table can stack into labelled rows at phone width (the
  // CSS media query in index.html), instead of cramming five columns and
  // truncating the most useful one — the reason — into an unreadable sliver.
  const rows = entries.slice(-25).reverse().map((e) =>
    `<tr>
      <td data-label="When">${fmtWhen(e.ts)}</td>
      <td data-label="Decision"><span class="mnd-badge ${e.decision === 'allow' ? 'mnd-ok' : 'mnd-deny'}">${esc(e.decision)}</span></td>
      <td data-label="Action"><code>${esc(e.action)}</code></td>
      <td data-label="Agent"><code>${esc(shortFp(e.agentFp))}</code></td>
      <td data-label="Reason" class="mnd-reason-cell">${esc(e.reason)}</td>
    </tr>`,
  ).join('');
  return `<div class="mnd-audit-head">${chainBadge}<span class="mnd-dim">${entries.length} total decisions · newest first</span></div>
    <table class="mnd-table"><thead><tr><th>when</th><th>decision</th><th>action</th><th>agent</th><th>reason</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function createController({ doc, els, fetchImpl }) {
  let timer = null;
  let running = false;

  async function fetchJson(url, opts) {
    const res = await fetchImpl(url, opts);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  }

  // kind: 'error' | 'success' are PERSISTENT (cleared only by the next note or
  // an explicit clearNote) — a transient toast the operator never sees is how
  // the 2026-06-05 silent-issuance-failure happened. 'info' stays transient.
  function note(msg, kind) {
    if (!els.notice) return;
    const isError = kind === true || kind === 'error'; // boolean kept for back-compat
    els.notice.textContent = msg;
    els.notice.className = isError ? 'mnd-notice mnd-notice-err'
      : kind === 'success' ? 'mnd-notice mnd-notice-ok'
      : 'mnd-notice';
    if (msg && !isError && kind !== 'success') {
      setTimeout(() => { if (els.notice.textContent === msg) els.notice.textContent = ''; }, 8000);
    }
  }

  function clearNote() {
    if (!els.notice) return;
    els.notice.textContent = '';
    els.notice.className = 'mnd-notice';
  }

  let refreshErrorShown = false;
  let autoOpenedIssueForm = false;
  // Last-fetched state the grant submit handler needs: the mandate list (for
  // the expiry clamp) — kept here, never re-derived from the DOM.
  let lastMandates = [];

  async function refresh() {
    try {
      const [mand, audit, users] = await Promise.all([
        fetchJson('/mandate'),
        fetchJson('/mandate/audit?limit=200'),
        // Registered Slack users feed the grant form's person picker. A failure
        // here must never take down the tab — the form degrades to a text input.
        fetchJson('/permissions/users').catch(() => ({ status: 0, body: null })),
      ]);
      if (mand.status === 503) {
        els.list.innerHTML = '<div class="mnd-empty">Mandate engine unavailable on this server (older version or init failure).</div>';
        els.audit.innerHTML = '';
        if (els.stamp) els.stamp.textContent = '';
        return;
      }
      const mandates = mand.body?.mandates;
      lastMandates = Array.isArray(mandates) ? mandates : [];
      const slackUsers = users.status === 200 && Array.isArray(users.body?.users) ? users.body.users : [];
      els.list.innerHTML = renderMandates(mandates, slackUsers);
      els.audit.innerHTML = renderAudit(audit.body);
      // Pending authorization-requests — the "Approvals waiting for you" surface (the
      // agent-proposes/operator-approves path). 503/absent → the section stays hidden.
      if (els.approvals) {
        const approvals = await fetchJson('/authorization-requests?status=pending').catch(() => ({ status: 0, body: null }));
        const reqs = approvals.status === 200 && Array.isArray(approvals.body?.requests) ? approvals.body.requests : [];
        const html = renderApprovals(reqs);
        els.approvals.innerHTML = html;
        if (els.approvalsSection) els.approvalsSection.style.display = html ? '' : 'none';
        wireApprovalButtons();
      }
      if (els.stamp) els.stamp.textContent = 'updated ' + new Date().toLocaleTimeString();
      // Nothing issued yet → the issue form IS the page's call to action;
      // open it once rather than hiding it behind a collapsed <details>.
      if (!autoOpenedIssueForm && els.issueDetails && (!Array.isArray(mandates) || mandates.length === 0)) {
        els.issueDetails.open = true;
        autoOpenedIssueForm = true;
      }
      // A persistent refresh error from a server restart-gap heals itself.
      if (refreshErrorShown) { clearNote(); refreshErrorShown = false; }
      wireRevokeButtons();
      wireGrantButtons();
    } catch (e) {
      refreshErrorShown = true;
      note('refresh failed: ' + (e?.message ?? e) + ' — retrying automatically.', 'error');
    }
  }

  function wireRevokeButtons() {
    els.list.querySelectorAll('[data-revoke]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-revoke');
        const pinEl = els.list.querySelector(`[data-revoke-pin="${id}"]`);
        const reasonEl = els.list.querySelector(`[data-revoke-reason="${id}"]`);
        const pin = pinEl?.value ?? '';
        if (!pin) { note('Type your dashboard PIN to revoke — revocation is a human action.', true); return; }
        btn.disabled = true;
        try {
          const { status, body } = await fetchJson(`/mandate/${encodeURIComponent(id)}/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin, reason: reasonEl?.value || 'operator revocation (dashboard)' }),
          });
          if (pinEl) pinEl.value = ''; // never retain the PIN
          if (status === 200) { note(`✓ Mandate ${id} revoked — the gate now denies its actions.`, 'success'); await refresh(); }
          else note(`Not revoked — the server refused: ${body?.error ?? `HTTP ${status}`}`, 'error');
        } finally { btn.disabled = false; }
      };
    });
  }

  function wireGrantButtons() {
    els.list.querySelectorAll('[data-grant]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-grant');
        const userEl = els.list.querySelector(`[data-grant-user="${id}"]`);
        const actionEl = els.list.querySelector(`[data-grant-action="${id}"]`);
        const durEl = els.list.querySelector(`[data-grant-duration="${id}"]`);
        const pinEl = els.list.querySelector(`[data-grant-pin="${id}"]`);
        const grantedTo = (userEl?.value ?? '').trim();
        const floorAction = actionEl?.value ?? 'prod-deploy';
        const pin = pinEl?.value ?? '';
        const problems = [];
        if (!grantedTo) problems.push('• Pick (or type) who the grant is for.');
        if (!pin) problems.push('• Type your dashboard PIN — granting a floor action is a human action; agent credentials are refused.');
        if (problems.length > 0) {
          note('Not granted — fix the following first:\n' + problems.join('\n'), 'error');
          return;
        }
        // A grant can never outlive its mandate — clamp client-side so the
        // operator's pick always succeeds (the server enforces the same rule
        // by rejection; rejection is a worse experience than a shorter window).
        const minutes = Number(durEl?.value ?? 60) || 60;
        const mandate = lastMandates.find((m) => m.id === id);
        const mandateExpiryMs = mandate ? Date.parse(mandate.expiresAt) : NaN;
        let expiryMs = Date.now() + minutes * 60_000;
        let clamped = false;
        if (!isNaN(mandateExpiryMs) && expiryMs > mandateExpiryMs) { expiryMs = mandateExpiryMs; clamped = true; }
        btn.disabled = true;
        try {
          const { status, body } = await fetchJson(`/mandate/${encodeURIComponent(id)}/grants`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pin,
              grants: [{
                floorAction,
                grantedTo,
                authorizedBy: 'operator (dashboard PIN)',
                expiresAt: new Date(expiryMs).toISOString(),
              }],
            }),
          });
          if (status === 201) {
            note(`✓ Grant signed — ${grantedTo} may ${floorAction} until ${fmtWhen(new Date(expiryMs).toISOString())}${clamped ? ' (shortened to the mandate’s own expiry — a grant can never outlive its mandate)' : ''}.`, 'success');
            await refresh();
          } else {
            note(`Not granted — the server refused: ${body?.error ?? `HTTP ${status}`}`, 'error');
          }
        } catch (e) {
          // A network failure must neither strand the typed PIN (cleared in
          // finally) nor fail silently.
          note(`Not granted — request failed: ${e?.message ?? e}. Nothing was signed; try again.`, 'error');
        } finally {
          if (pinEl) pinEl.value = ''; // never retain the PIN — on ANY path
          btn.disabled = false;
        }
      };
    });
  }

  // Approve / Decline a pending authorization-request — PIN-gated. The operator never
  // authors anything here; they approve a server-authored card. The PIN is never retained.
  function wireApprovalButtons() {
    if (!els.approvals) return;
    els.approvals.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-approve');
        const pinEl = els.approvals.querySelector(`[data-approve-pin="${id}"]`);
        const pin = pinEl?.value ?? '';
        if (!pin) { note('Type your dashboard PIN to approve — approving a grant is a human action.', true); return; }
        btn.disabled = true;
        try {
          const { status, body } = await fetchJson(`/authorization-requests/${encodeURIComponent(id)}/approve`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
          });
          if (pinEl) pinEl.value = '';
          if (status === 200 || status === 201) { note('✓ Approved — the grant is now active.', 'success'); await refresh(); }
          else note(`Not approved — the server refused: ${body?.error ?? `HTTP ${status}`}`, 'error');
        } finally { btn.disabled = false; }
      };
    });
    els.approvals.querySelectorAll('[data-deny]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-deny');
        const pinEl = els.approvals.querySelector(`[data-approve-pin="${id}"]`);
        const pin = pinEl?.value ?? '';
        if (!pin) { note('Type your dashboard PIN to decline — declining is a human action.', true); return; }
        const denyReason = (typeof window !== 'undefined' && window.prompt) ? window.prompt('Why are you declining? (a short reason is required)') : 'declined';
        if (!denyReason || !denyReason.trim()) { note('A short reason is required to decline.', true); return; }
        btn.disabled = true;
        try {
          const { status, body } = await fetchJson(`/authorization-requests/${encodeURIComponent(id)}/deny`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin, denyReason: denyReason.trim() }),
          });
          if (pinEl) pinEl.value = '';
          if (status === 200) { note('Declined.', 'success'); await refresh(); }
          else note(`Not declined — the server refused: ${body?.error ?? `HTTP ${status}`}`, 'error');
        } finally { btn.disabled = false; }
      };
    });
  }

  // Validate EVERYTHING client-side and report every problem at once —
  // never POST a request we know the server will refuse, and never let the
  // operator discover a missing field one transient error at a time.
  function validateIssueForm() {
    const problems = [];
    if (!els.issueScope?.value?.trim()) problems.push('• Scope is empty — give the permission slip a short name.');
    if (!els.issueAgentA?.value?.trim()) problems.push('• Agent A is empty — this agent’s own fingerprint (normally pre-filled).');
    if (!els.issueAgentB?.value?.trim()) problems.push('• Agent B is empty — paste the other agent’s routing fingerprint.');
    let authorities = null;
    const rawAuth = els.issueAuthorities?.value ?? '';
    try {
      authorities = JSON.parse(rawAuth || '[]');
      if (!Array.isArray(authorities) || authorities.length === 0) {
        problems.push('• Authorities is empty — the mandate must delegate at least one action.');
        authorities = null;
      }
    } catch {
      problems.push('• Authorities is not valid JSON — it must be an array of { action, bounds }.');
    }
    const expiresRaw = els.issueExpires?.value ?? '';
    if (!expiresRaw) {
      problems.push('• Expiry is empty — every mandate must expire (normally pre-filled to a week out).');
    } else if (!(Date.parse(expiresRaw) > Date.now())) {
      problems.push('• Expiry is in the past — pick a future date.');
    }
    if (!els.issuePin?.value) problems.push('• Your dashboard PIN is missing — issuing is a human action; agent credentials are refused.');
    return { problems, authorities };
  }

  // WS5.2 R4a — an account-follow-me authority targets a SPECIFIC machine. From the operator's ONE
  // dashboard, such a mandate is issued AND delivered to that target via /mandate/issue-for-machine
  // (which issues locally then dispatches the R4a-signed bundle over the mesh) — the operator NEVER
  // opens the target's own dashboard. A non-follow-me mandate uses the ordinary /mandate/issue path.
  function followMeTarget(authorities) {
    if (!Array.isArray(authorities)) return null;
    const a = authorities.find((x) => x && x.action === 'account-follow-me'
      && x.bounds && typeof x.bounds.accountId === 'string' && typeof x.bounds.targetMachineId === 'string');
    return a ? { accountId: a.bounds.accountId, targetMachineId: a.bounds.targetMachineId } : null;
  }

  async function issue() {
    const { problems, authorities } = validateIssueForm();
    if (problems.length > 0) {
      note('Not issued — fix the following first:\n' + problems.join('\n'), 'error');
      return;
    }
    const expiresAt = new Date(els.issueExpires.value).toISOString();
    const pin = els.issuePin.value;
    const agents = [els.issueAgentA?.value?.trim(), els.issueAgentB?.value?.trim()];
    const fm = followMeTarget(authorities);
    // Route an account-follow-me mandate through the one-dashboard issue+deliver path; everything
    // else through the ordinary issue path.
    const endpoint = fm ? '/mandate/issue-for-machine' : '/mandate/issue';
    const payload = fm
      ? { pin, scope: els.issueScope?.value?.trim(), agents, expiresAt, accountId: fm.accountId, targetMachineId: fm.targetMachineId }
      : { pin, scope: els.issueScope?.value?.trim(), agents, authorities, expiresAt };
    els.issueBtn.disabled = true;
    try {
      const { status, body } = await fetchJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (els.issuePin) els.issuePin.value = ''; // never retain the PIN
      if (status === 201) {
        const deliveredNote = fm
          ? (body?.delivered ? ' and delivered to the target machine' : (body?.local ? ' (target is this machine)' : ''))
          : '';
        note(`✓ Mandate ${body?.mandate?.id ?? ''} issued${deliveredNote} — it is active and listed above. The agents can now act within its bounds.`, 'success');
        if (els.issueDetails) els.issueDetails.open = false;
        await refresh();
      } else if (fm && status === 502) {
        // Issued locally but cross-machine DELIVERY failed — honest, retry-able.
        note(`Mandate ${body?.mandate?.id ?? ''} issued, but delivery to the target failed: ${body?.reason ?? body?.error ?? `HTTP ${status}`}. Retry to re-deliver (issuance is idempotent on the target).`, 'error');
        await refresh();
      } else {
        note(`Not issued — the server refused: ${body?.error ?? `HTTP ${status}`}`, 'error');
      }
    } finally { els.issueBtn.disabled = false; }
  }

  // datetime-local wants local "YYYY-MM-DDTHH:MM" — toISOString() (UTC, with
  // seconds + Z) renders as blank in the picker.
  function defaultExpiryLocal() {
    const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // The system KNOWS this agent's fingerprint — asking the operator to paste a
  // 32-hex string the dashboard can fetch itself is exactly the UX failure
  // Justin flagged. /threadline/health reads the canonical identity.json (works
  // even when the relay is disconnected); /threadline/status is the fallback.
  async function prefillAgentA() {
    if (!els.issueAgentA || els.issueAgentA.value) return;
    try {
      let fp = null;
      const health = await fetchJson('/threadline/health');
      if (health.status === 200) fp = health.body?.fingerprint ?? null;
      if (!fp) {
        const status = await fetchJson('/threadline/status');
        fp = status.body?.relay?.fingerprint ?? null;
      }
      if (fp && els.issueAgentA && !els.issueAgentA.value) {
        els.issueAgentA.value = fp;
        if (els.agentAPrefillNote) els.agentAPrefillNote.textContent = '✓ pre-filled — this agent’s own fingerprint';
      }
    } catch { /* leave blank; validation reports it plainly */ }
  }

  function start() {
    if (running) return;
    running = true;
    if (els.issueAuthorities && !els.issueAuthorities.value) els.issueAuthorities.value = AUTHORITIES_TEMPLATE;
    if (els.issueExpires && !els.issueExpires.value) els.issueExpires.value = defaultExpiryLocal();
    if (els.issueBtn) els.issueBtn.onclick = issue;
    prefillAgentA();
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
  }

  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, refresh };
}
