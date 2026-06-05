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

export function renderMandates(list) {
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
    return `<div class="mnd-card">
      <div class="mnd-card-head">
        <span class="mnd-scope">${esc(m.scope)}</span>
        <span class="mnd-badge ${stateCls}">${state}</span>
        ${authBadge}
      </div>
      <div class="mnd-meta">id <code>${esc(m.id)}</code> · agents <code>${esc(shortFp(m.agents?.[0]))}</code> + <code>${esc(shortFp(m.agents?.[1]))}</code> · by ${esc(m.author)} · expires ${fmtWhen(m.expiresAt)}</div>
      <ul class="mnd-authorities">${authorities}</ul>
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

  function note(msg, isError) {
    if (!els.notice) return;
    els.notice.textContent = msg;
    els.notice.className = isError ? 'mnd-notice mnd-notice-err' : 'mnd-notice';
    if (msg) setTimeout(() => { if (els.notice.textContent === msg) els.notice.textContent = ''; }, 8000);
  }

  async function refresh() {
    try {
      const [mand, audit] = await Promise.all([
        fetchJson('/mandate'),
        fetchJson('/mandate/audit?limit=200'),
      ]);
      if (mand.status === 503) {
        els.list.innerHTML = '<div class="mnd-empty">Mandate engine unavailable on this server (older version or init failure).</div>';
        els.audit.innerHTML = '';
        if (els.stamp) els.stamp.textContent = '';
        return;
      }
      els.list.innerHTML = renderMandates(mand.body?.mandates);
      els.audit.innerHTML = renderAudit(audit.body);
      if (els.stamp) els.stamp.textContent = 'updated ' + new Date().toLocaleTimeString();
      wireRevokeButtons();
    } catch (e) {
      note('refresh failed: ' + (e?.message ?? e), true);
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
          if (status === 200) { note(`Mandate ${id} revoked.`); await refresh(); }
          else note(body?.error ?? `revoke failed (${status})`, true);
        } finally { btn.disabled = false; }
      };
    });
  }

  async function issue() {
    const pin = els.issuePin?.value ?? '';
    if (!pin) { note('Type your dashboard PIN — issuance is a human action; agent credentials are refused.', true); return; }
    let authorities;
    try { authorities = JSON.parse(els.issueAuthorities?.value || '[]'); }
    catch { note('Authorities must be valid JSON (array of { action, bounds }).', true); return; }
    const payload = {
      pin,
      scope: els.issueScope?.value?.trim(),
      agents: [els.issueAgentA?.value?.trim(), els.issueAgentB?.value?.trim()],
      authorities,
      expiresAt: els.issueExpires?.value ? new Date(els.issueExpires.value).toISOString() : '',
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
        note(`Mandate ${body?.mandate?.id ?? ''} issued.`);
        await refresh();
      } else {
        note(body?.error ?? `issue failed (${status})`, true);
      }
    } finally { els.issueBtn.disabled = false; }
  }

  function start() {
    if (running) return;
    running = true;
    if (els.issueAuthorities && !els.issueAuthorities.value) els.issueAuthorities.value = AUTHORITIES_TEMPLATE;
    if (els.issueBtn) els.issueBtn.onclick = issue;
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
  }

  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, refresh };
}
