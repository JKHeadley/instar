/**
 * Tests for the Mandates dashboard tab (coordination-mandate spec, decision 2A —
 * the operator's PIN-gated surface for issuing/revoking mandates).
 *
 * Two layers: (1) HTML-at-rest smoke tests (tab wiring, panel, registry, lazy
 * module shim — the dashboard-machinesTab pattern); (2) BEHAVIORAL tests of the
 * mandates.js module's pure renderers + controller with a stubbed fetch — the
 * load-bearing ones: the PIN is required, sent once, and NEVER retained; renderers
 * escape attacker-controlled fields; a broken audit chain is surfaced loudly.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMandates, renderAudit, createController } from '../../dashboard/mandates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');

// ── (1) HTML-at-rest wiring ──

describe('dashboard: Mandates tab wiring', () => {
  it('has a Mandates tab button wired to switchTab', () => {
    expect(HTML).toContain('data-tab="mandates"');
    expect(HTML).toContain(`switchTab('mandates')`);
  });

  it('has a mandatesPanel container with the PIN-gated issue form', () => {
    expect(HTML).toContain('id="mandatesPanel"');
    expect(HTML).toContain('id="mndIssuePin"');
    // The PIN input is a password field and never autocompleted.
    expect(HTML).toMatch(/id="mndIssuePin"[^>]*autocomplete="off"|autocomplete="off"[^>]*id="mndIssuePin"/);
    expect(HTML).toMatch(/<input type="password" id="mndIssuePin"/);
  });

  it('registers the mandates tab in TAB_REGISTRY with activate/deactivate', () => {
    expect(HTML).toMatch(/id:\s*'mandates'[\s\S]{0,200}panels:\s*\['mandatesPanel'\]/);
    expect(HTML).toContain('function startMandates()');
    expect(HTML).toContain('function stopMandates()');
  });

  it('lazy-imports /dashboard/mandates.js (external module pattern)', () => {
    expect(HTML).toContain(`import('/dashboard/mandates.js')`);
  });

  it('states the operator framing in plain language (Dashboard Standard)', () => {
    expect(HTML).toContain('permission slips');
    expect(HTML).toMatch(/dashboard PIN/);
  });
});

// ── (2) module behavior ──

function makeEls() {
  const mk = () => {
    const el: any = {
      innerHTML: '', textContent: '', className: '', value: '', disabled: false, onclick: null,
      queryStore: new Map<string, any>(),
      querySelectorAll: (_sel: string) => [] as any[],
      querySelector: (_sel: string) => null as any,
    };
    return el;
  };
  return {
    list: mk(), audit: mk(), notice: mk(), stamp: mk(),
    issueScope: { ...mk(), value: 'feedback-migration' },
    issueAgentA: { ...mk(), value: 'fp-echo' },
    issueAgentB: { ...mk(), value: 'fp-dawn' },
    issueAuthorities: { ...mk(), value: '[{"action":"sign-code-review","bounds":{}}]' },
    issueExpires: { ...mk(), value: '2999-01-01T00:00' },
    issuePin: mk(),
    issueBtn: mk(),
    issueDetails: { ...mk(), open: false },
    agentAPrefillNote: mk(),
  };
}

describe('mandates.js renderers', () => {
  it('renderMandates: empty list states deny-by-default; cards show state + authorship badges', () => {
    expect(renderMandates([])).toMatch(/deny-by-default/);
    const html = renderMandates([{
      id: 'mig-1', scope: 'feedback-migration', agents: ['fp-echo', 'fp-dawn'],
      authorities: [{ action: 'sign-code-review', bounds: { artifact: 'migration-port' } }],
      author: 'justin', expiresAt: '2999-01-01T00:00:00Z', revoked: null, authorshipValid: true,
    }]);
    expect(html).toContain('authorship verified');
    expect(html).toContain('sign-code-review');
    expect(html).toMatch(/data-revoke="mig-1"/);   // active → revocable
    expect(html).toMatch(/data-revoke-pin="mig-1"/); // …with its own PIN field
  });

  it('renderMandates: an invalid-authorship or revoked mandate is loudly marked and not revocable-again', () => {
    const html = renderMandates([{
      id: 'mig-2', scope: 's', agents: ['a', 'b'], authorities: [],
      author: 'justin', expiresAt: '2999-01-01T00:00:00Z',
      revoked: { at: '2026-06-05T00:00:00Z', reason: 'kill' }, authorshipValid: false,
    }]);
    expect(html).toContain('AUTHORSHIP INVALID');
    expect(html).toContain('revoked');
    expect(html).not.toContain('data-revoke="mig-2"');
  });

  it('renderers escape attacker-controlled fields (XSS-safe)', () => {
    const xss = '<img src=x onerror=alert(1)>';
    const m = renderMandates([{
      id: xss, scope: xss, agents: [xss, xss],
      authorities: [{ action: xss, bounds: { k: xss } }],
      author: xss, expiresAt: '2999-01-01T00:00:00Z', revoked: null, authorshipValid: true,
    }]);
    expect(m).not.toContain('<img');
    const a = renderAudit({ chain: { ok: true }, entries: [{ ts: 't', decision: 'deny', action: xss, agentFp: xss, reason: xss }] });
    expect(a).not.toContain('<img');
  });

  it('renderAudit: a broken chain is surfaced as tampering; decisions render allow/deny', () => {
    const broken = renderAudit({ chain: { ok: false, brokenAt: 3 }, entries: [{ ts: 't', decision: 'allow', action: 'a', agentFp: 'f', reason: 'r' }] });
    expect(broken).toContain('CHAIN BROKEN');
    const ok = renderAudit({ chain: { ok: true }, entries: [{ ts: 't', decision: 'deny', action: 'a', agentFp: 'f', reason: 'nope' }] });
    expect(ok).toContain('chain verified');
    expect(ok).toContain('deny');
  });
});

describe('mandates.js controller — the PIN discipline', () => {
  function controllerWith(fetchResponses: Record<string, { status: number; body: unknown }>) {
    const calls: Array<{ url: string; opts: any }> = [];
    const fetchImpl = async (url: string, opts: any = {}) => {
      calls.push({ url, opts });
      const hit = Object.entries(fetchResponses).find(([k]) => url.startsWith(k));
      const r = hit ? hit[1] : { status: 200, body: { mandates: [], entries: [], chain: { ok: true } } };
      return { status: r.status, json: async () => r.body } as any;
    };
    const els = makeEls();
    const controller = createController({ doc: {} as any, els, fetchImpl });
    return { controller, els, calls };
  }

  it('refuses to issue WITHOUT a PIN — no request is sent', async () => {
    const { controller, els, calls } = controllerWith({});
    controller.start();
    els.issuePin.value = '';
    await (els.issueBtn.onclick as any)();
    expect(calls.some((c) => c.url.startsWith('/mandate/issue'))).toBe(false);
    expect(els.notice.textContent).toMatch(/PIN/);
    controller.stop();
  });

  it('issues WITH the PIN once, then CLEARS the field (never retained)', async () => {
    const { controller, els, calls } = controllerWith({
      '/mandate/issue': { status: 201, body: { issued: true, mandate: { id: 'm-1' } } },
    });
    controller.start();
    els.issuePin.value = '424242';
    await (els.issueBtn.onclick as any)();
    const issueCall = calls.find((c) => c.url.startsWith('/mandate/issue'));
    expect(issueCall).toBeTruthy();
    expect(JSON.parse(issueCall!.opts.body).pin).toBe('424242');
    expect(els.issuePin.value).toBe(''); // the load-bearing assertion
    controller.stop();
  });

  it('surfaces a 403 (wrong PIN) as an error and still clears the field', async () => {
    const { controller, els } = controllerWith({
      '/mandate/issue': { status: 403, body: { error: 'Incorrect PIN' } },
    });
    controller.start();
    els.issuePin.value = '000000';
    await (els.issueBtn.onclick as any)();
    expect(els.notice.textContent).toMatch(/Incorrect PIN/);
    expect(els.issuePin.value).toBe('');
    controller.stop();
  });

  it('start() prefills the A/A/B authorities template only when empty', () => {
    const { controller, els } = controllerWith({});
    els.issueAuthorities.value = '';
    controller.start();
    expect(els.issueAuthorities.value).toContain('exchange-read-credential');
    expect(els.issueAuthorities.value).toContain('sign-code-review');
    controller.stop();
  });

  it('renders the 503-engine-unavailable state instead of erroring', async () => {
    const { controller, els } = controllerWith({
      '/mandate/audit': { status: 503, body: { error: 'unavailable' } },
      '/mandate': { status: 503, body: { error: 'unavailable' } },
    });
    controller.start();
    await controller.refresh();
    expect(els.list.innerHTML).toMatch(/unavailable/);
    controller.stop();
  });
});

// ── (3) the 2026-06-05 UX overhaul: layout, validation, prefill, persistence ──
// Justin clicked "Issue Mandate" with empty required fields; the server refused;
// the only feedback was an 8-second toast he never saw; and the whole panel was
// squashed into the 280px sidebar grid column. Each failure mode gets a pin.

describe('dashboard: Mandates layout (the squash bug)', () => {
  it('.ph-root spans the full app grid — never the 280px sidebar column', () => {
    const phRoot = HTML.match(/\.ph-root\s*\{[^}]*\}/)?.[0] ?? '';
    expect(phRoot).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  it('issue-form fields carry plain-English hints and the details element is addressable', () => {
    expect(HTML).toContain('id="mndIssueDetails"');
    expect(HTML).toContain('class="mnd-hint"');
    expect(HTML).toContain('id="mndAgentAPrefillNote"');
    // Persistent (non-toast) feedback styles exist for both outcomes.
    expect(HTML).toMatch(/\.mnd-notice-err\s*\{[^}]*border/);
    expect(HTML).toMatch(/\.mnd-notice-ok\s*\{[^}]*border/);
  });
});

describe('mandates.js controller — client-side validation (every problem at once)', () => {
  function controllerWith(fetchResponses: Record<string, { status: number; body: unknown }>) {
    const calls: Array<{ url: string; opts: any }> = [];
    const fetchImpl = async (url: string, opts: any = {}) => {
      calls.push({ url, opts });
      const hit = Object.entries(fetchResponses).find(([k]) => url.startsWith(k));
      const r = hit ? hit[1] : { status: 200, body: { mandates: [], entries: [], chain: { ok: true } } };
      return { status: r.status, json: async () => r.body } as any;
    };
    const els = makeEls();
    const controller = createController({ doc: {} as any, els, fetchImpl });
    return { controller, els, calls };
  }

  it('an all-empty form lists EVERY missing field in one persistent error and sends nothing', async () => {
    const { controller, els, calls } = controllerWith({});
    controller.start();
    els.issueScope.value = '';
    els.issueAgentA.value = '';
    els.issueAgentB.value = '';
    els.issueAuthorities.value = '';
    els.issueExpires.value = '';
    els.issuePin.value = '';
    await (els.issueBtn.onclick as any)();
    expect(calls.some((c) => c.url.startsWith('/mandate/issue'))).toBe(false);
    expect(els.notice.textContent).toMatch(/Scope/);
    expect(els.notice.textContent).toMatch(/Agent A/);
    expect(els.notice.textContent).toMatch(/Agent B/);
    expect(els.notice.textContent).toMatch(/Authorities/);
    expect(els.notice.textContent).toMatch(/Expiry/);
    expect(els.notice.textContent).toMatch(/PIN/);
    expect(els.notice.className).toContain('mnd-notice-err');
    controller.stop();
  });

  it('a past expiry is refused client-side with a plain explanation', async () => {
    const { controller, els, calls } = controllerWith({});
    controller.start();
    els.issuePin.value = '424242';
    els.issueExpires.value = '2001-01-01T00:00';
    await (els.issueBtn.onclick as any)();
    expect(calls.some((c) => c.url.startsWith('/mandate/issue'))).toBe(false);
    expect(els.notice.textContent).toMatch(/past/);
    controller.stop();
  });

  it('validation errors PERSIST — no 8-second toast clear', async () => {
    vi.useFakeTimers();
    try {
      const { controller, els } = controllerWith({});
      controller.start();
      els.issuePin.value = '';
      await (els.issueBtn.onclick as any)();
      const shown = els.notice.textContent;
      expect(shown).toMatch(/PIN/);
      vi.advanceTimersByTime(30_000);
      expect(els.notice.textContent).toBe(shown); // still there
    } finally {
      vi.useRealTimers();
    }
  });

  it('a successful issuance shows a persistent ✓ banner and closes the form', async () => {
    vi.useFakeTimers();
    try {
      const { controller, els } = controllerWith({
        '/mandate/issue': { status: 201, body: { issued: true, mandate: { id: 'm-9' } } },
      });
      controller.start();
      await controller.refresh(); // let the initial empty-list auto-open settle first
      els.issuePin.value = '424242';
      els.issueDetails.open = true;
      await (els.issueBtn.onclick as any)();
      expect(els.notice.textContent).toMatch(/✓ Mandate m-9 issued/);
      expect(els.notice.className).toContain('mnd-notice-ok');
      expect(els.issueDetails.open).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(els.notice.textContent).toMatch(/✓ Mandate m-9 issued/); // persists
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mandates.js controller — prefills (the system knows these values)', () => {
  function controllerWith(fetchResponses: Record<string, { status: number; body: unknown }>) {
    const calls: Array<{ url: string; opts: any }> = [];
    const fetchImpl = async (url: string, opts: any = {}) => {
      calls.push({ url, opts });
      const hit = Object.entries(fetchResponses).find(([k]) => url.startsWith(k));
      const r = hit ? hit[1] : { status: 200, body: { mandates: [], entries: [], chain: { ok: true } } };
      return { status: r.status, json: async () => r.body } as any;
    };
    const els = makeEls();
    const controller = createController({ doc: {} as any, els, fetchImpl });
    return { controller, els, calls };
  }

  it('start() pre-fills Agent A with the agent’s own fingerprint from /threadline/health', async () => {
    const { controller, els } = controllerWith({
      '/threadline/health': { status: 200, body: { fingerprint: '63b1dbb21646e2f5f860441f6c6443ad' } },
    });
    els.issueAgentA.value = '';
    controller.start();
    await new Promise((r) => setTimeout(r, 0)); // let the async prefill settle
    expect(els.issueAgentA.value).toBe('63b1dbb21646e2f5f860441f6c6443ad');
    expect(els.agentAPrefillNote.textContent).toMatch(/pre-filled/);
    controller.stop();
  });

  it('never overwrites an operator-typed Agent A value', async () => {
    const { controller, els } = controllerWith({
      '/threadline/health': { status: 200, body: { fingerprint: 'should-not-appear' } },
    });
    els.issueAgentA.value = 'operator-typed';
    controller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(els.issueAgentA.value).toBe('operator-typed');
    controller.stop();
  });

  it('start() pre-fills a future expiry when empty (datetime-local format)', () => {
    const { controller, els } = controllerWith({});
    els.issueExpires.value = '';
    controller.start();
    expect(els.issueExpires.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(Date.parse(els.issueExpires.value)).toBeGreaterThan(Date.now());
    controller.stop();
  });

  it('refresh() auto-opens the issue form when no mandates exist (it IS the call to action)', async () => {
    const { controller, els } = controllerWith({
      '/mandate/audit': { status: 200, body: { entries: [], chain: { ok: true } } },
      '/mandate': { status: 200, body: { mandates: [] } },
    });
    els.issueDetails.open = false;
    controller.start();
    await controller.refresh();
    expect(els.issueDetails.open).toBe(true);
    controller.stop();
  });
});
