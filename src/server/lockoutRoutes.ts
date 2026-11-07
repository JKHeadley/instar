import { randomUUID } from 'node:crypto';
import type { Router, Request, Response } from 'express';

/** Machine-local, restart-revoked, exact-action approvals. Shared Bearer cannot approve. */
export function mountLockoutRoutes(router: Router, checkPin: (req: Request, res: Response) => boolean,
  externalUrl: (path: string) => string, now = Date.now) {
  const pending = new Map<string, { action: string; approved: boolean; expires: number; summary: string }>();
  const prune = () => { for (const [id, row] of pending) if (row.expires <= now()) pending.delete(id); };
  router.post('/lockout/request', (req, res) => {
    prune();
    if (!/^[a-f0-9]{64}$/.test(req.body?.action ?? '')) { res.status(400).json({ error: 'exact action digest required' }); return; }
    if (pending.size >= 100) { res.status(429).json({ error: 'too many pending approvals' }); return; }
    const id = randomUUID();
    pending.set(id, { action: req.body.action, approved: false, expires: now() + 5 * 60_000,
      summary: typeof req.body.summary === 'string' ? req.body.summary.slice(0, 500) : 'One action that may lock or suspend an account, or access a recovery code.' });
    res.json({ id, url: externalUrl(`/lockout/approve/${id}`) });
  });
  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  router.get('/lockout/approve/:id', (req, res) => {
    prune(); const row = pending.get(String(req.params.id));
    res.setHeader('Cache-Control', 'no-store');
    if (!row) { res.status(404).send('This request expired or was used.'); return; }
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve one account action</title><style>body{font:18px system-ui;max-width:30rem;margin:2rem auto;padding:1rem}input,button{box-sizing:border-box;font:inherit;width:100%;padding:1rem;margin:.5rem 0}small{overflow-wrap:anywhere}</style></head><body><h1>Allow this account action?</h1><p>${escape(row.summary)}</p><p>This may suspend your account or put publishing on hold. Approve only after reviewing the exact action with your agent. This permission expires in five minutes and works once.</p><form id="approval"><label>Dashboard PIN<input type="password" inputmode="numeric" id="pin" autocomplete="off" required></label><button>Approve one action</button></form><p id="result" role="status"></p><details><summary>Action reference</summary><small>${escape(row.action)}</small></details><script>document.getElementById('approval').onsubmit=async e=>{e.preventDefault();const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:document.getElementById('pin').value})});document.getElementById('result').textContent=r.ok?'Approved. Your agent can now perform this action once.':'Approval failed or expired. Check your PIN or request a new link.';if(r.ok)document.getElementById('approval').remove();};</script></body></html>`);
  });
  router.post('/lockout/approve/:id', (req, res) => {
    prune(); const row = pending.get(String(req.params.id));
    if (!row || row.approved) { res.status(404).json({ error: 'expired or already approved' }); return; }
    if (!checkPin(req, res)) return;
    row.approved = true; res.json({ approved: true });
  });
  router.post('/lockout/consume', (req, res) => {
    prune(); const id = req.body?.id; const row = pending.get(id);
    if (!row?.approved || row.action !== req.body?.action) { res.status(403).json({ error: 'operator approval required for this exact action' }); return; }
    pending.delete(id); res.json({ allowed: true });
  });
}
