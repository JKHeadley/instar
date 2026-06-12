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

function userLabel(slackUserId, slackUsers) {
  const u = (slackUsers || []).find((x) => x.slackUserId === slackUserId);
  return u ? `${u.name} (${slackUserId})` : slackUserId;
}

/** The grants a mandate already carries, in operator language. */
export function renderGrants(m, slackUsers) {
  const grants = Array.isArray(m.grants) ? m.grants : [];
  if (grants.length === 0) return '';
  const rows = grants.map((g) => {
    const expired = Date.parse(g.expiresAt) < Date.now();
    const badge = expired
      ? '<span class="mnd-badge mnd-dead">expired</span>'
      : '<span class="mnd-badge mnd-ok">active</span>';
    return `<li>${badge} <strong>${esc(userLabel(g.grantedTo, slackUsers))}</strong> may <code>${esc(g.floorAction)}</code> until ${fmtWhen(g.expiresAt)} — authorized by ${esc(g.authorizedBy)}</li>`;
  }).join('');
  return `<div class="mnd-grants-head">User grants this mandate carries:</div><ul class="mnd-grants">${rows}</ul>`;
}

/**
 * The add-grant form for an ACTIVE mandate. Mobile-first by design (the
 * 2026-06-12 lesson, instar#1080): the operator PICKS a person and a duration —
 * the only thing typed is the PIN. A free-text Slack-id input appears only
 * when the user registry has nobody to offer.
 */
export function renderGrantForm(m, slackUsers) {
  const users = (slackUsers || []).filter((u) => u.slackUserId);
  const granteeField = users.length > 0
    ? `<select class="mnd-grant-field" data-grant-user="${esc(m.id)}">${
        users.map((u) => `<option value="${esc(u.slackUserId)}">${esc(u.name)}${u.orgRole ? ` — ${esc(u.orgRole)}` : ''}</option>`).join('')
      }</select>`
    : `<input type="text" class="mnd-grant-field" data-grant-user="${esc(m.id)}" placeholder="Slack user id (e.g. U0…)" />`;
  const actionField = `<select class="mnd-grant-field" data-grant-action="${esc(m.id)}">${
    FLOOR_ACTIONS.map((a) => `<option value="${a}"${a === 'prod-deploy' ? ' selected' : ''}>${a}</option>`).join('')
  }</select>`;
  const durationField = `<select class="mnd-grant-field" data-grant-duration="${esc(m.id)}">${
    GRANT_DURATIONS.map((d) => `<option value="${d.minutes}"${d.minutes === 60 ? ' selected' : ''}>${d.label}</option>`).join('')
  }</select>`;
  return `<details class="mnd-grant-details"><summary class="mnd-grant-summary">Grant a user a floor action (PIN required)</summary>
    <div class="mnd-grant-row">
      ${granteeField}
      ${actionField}
      ${durationField}
      <input type="password" class="mnd-pin" data-grant-pin="${esc(m.id)}" placeholder="PIN" autocomplete="off" />
      <button class="mnd-btn" data-grant="${esc(m.id)}">Grant</button>
    </div>
    <span class="mnd-hint">Lifts the picked person to ONE floor action for the picked window. Signed into this mandate by your PIN — revoking the mandate voids it; it can never outlive the mandate.</span>
  </details>`;
}

export function renderMandates(list, slackUsers = []) {
  if (!Array.isArray(list) || list.length === 0) {
    return '<div class="mnd-empty">No mandates issued. The gate is deny-by-default: every delegated agent action refuses until you issue one.</div>';
  }
  return list.map((m) => {
    const expired = Date.parse(m.expiresAt) < Date.now();
    const state = m.revoked ? 'revoked' : expired ? 'expired' : 'active';
    const stateCls = state === 'active' ? 'mnd-ok' : 'mnd-dead';
    const authBadge = m.authorshipValid
      ? '<span class="mnd-badge mnd-ok">authorship verified</span>'
      : '<span class="mnd-badge mnd-bad">AUTHORSHIP INVALID</span>';
    const authorities = (m.authorities || []).map((a) =>
      `<li><code>${esc(a.action)}</code> — bounds <code>${esc(JSON.stringify(a.bounds))}</code>${a.requiresCondition ? ` — requires <code>${esc(a.requiresCondition)}</code>` : ''}</li>`,
    ).join('');
    const revokeUi = state === 'active'
      ? `<div class="mnd-revoke-row">
           <input type="password" class="mnd-pin" data-revoke-pin="${esc(m.id)}" placeholder="PIN" autocomplete="off" />
           <input type="text" class="mnd-reason" data-revoke-reason="${esc(m.id)}" placeholder="reason" />
           <button class="mnd-btn mnd-btn-danger" data-revoke="${esc(m.id)}">Revoke</button>
         </div>`
      : `<div class="mnd-dead-note">${m.revoked ? `revoked ${fmtWhen(m.revoked.at)} — ${esc(m.revoked.reason)}` : `expired ${fmtWhen(m.expiresAt)}`}</div>`;
    const grantUi = state === 'active' ? renderGrantForm(m, slackUsers) : '';
    return `<div class="mnd-card">
      <div class="mnd-card-head">
        <span class="mnd-scope">${esc(m.scope)}</span>
        <span class="mnd-badge ${stateCls}">${state}</span>
        ${authBadge}
      </div>
      <div class="mnd-meta">id <code>${esc(m.id)}</code> · agents <code>${esc(shortFp(m.agents?.[0]))}</code> + <code>${esc(shortFp(m.agents?.[1]))}</code> · by ${esc(m.author)} · expires ${fmtWhen(m.expiresAt)}</div>
      <ul class="mnd-authorities">${authorities}</ul>
      ${renderGrants(m, slackUsers)}
      ${grantUi}
      ${revokeUi}
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
  const rows = entries.slice(-25).reverse().map((e) =>
    `<tr>
      <td>${fmtWhen(e.ts)}</td>
      <td><span class="mnd-badge ${e.decision === 'allow' ? 'mnd-ok' : 'mnd-deny'}">${esc(e.decision)}</span></td>
      <td><code>${esc(e.action)}</code></td>
      <td><code>${esc(shortFp(e.agentFp))}</code></td>
      <td class="mnd-reason-cell">${esc(e.reason)}</td>
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

  async function issue() {
    const { problems, authorities } = validateIssueForm();
    if (problems.length > 0) {
      note('Not issued — fix the following first:\n' + problems.join('\n'), 'error');
      return;
    }
    const payload = {
      pin: els.issuePin.value,
      scope: els.issueScope?.value?.trim(),
      agents: [els.issueAgentA?.value?.trim(), els.issueAgentB?.value?.trim()],
      authorities,
      expiresAt: new Date(els.issueExpires.value).toISOString(),
    };
    els.issueBtn.disabled = true;
    try {
      const { status, body } = await fetchJson('/mandate/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (els.issuePin) els.issuePin.value = ''; // never retain the PIN
      if (status === 201) {
        note(`✓ Mandate ${body?.mandate?.id ?? ''} issued — it is active and listed above. The agents can now act within its bounds.`, 'success');
        if (els.issueDetails) els.issueDetails.open = false;
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
