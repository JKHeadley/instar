// Drives the real phone API with a signed device. Usage: tsx capture.ts <port> <keyPem> <deviceId> <metaJson> <out.json>
import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
const { canonicalString } = await import(path.join(process.cwd(), 'src/core/MobileDeviceKeys.ts'));
const [portS, keyFile, deviceId, metaFile, out] = process.argv.slice(2); const port = Number(portS); const host = `127.0.0.1:${port}`;
const key = crypto.createPrivateKey(fs.readFileSync(keyFile)); const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const der = (raw: Buffer) => { const r = BigInt('0x' + raw.subarray(0, 32).toString('hex')); let s = BigInt('0x' + raw.subarray(32).toString('hex')); if (s > N / 2n) s = N - s;
  const int = (v: bigint) => { let h = v.toString(16); if (h.length % 2) h = '0' + h; let b = Buffer.from(h, 'hex'); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([2, b.length]), b]); };
  const b = Buffer.concat([int(r), int(s)]); return Buffer.concat([Buffer.from([0x30, b.length]), b]).toString('base64url'); };
let clock = 0;
async function call(method: 'GET' | 'POST', p: string, body?: unknown): Promise<any> { for (;;) { const r = await once(method, p, body); if (r.status !== 429) return r; res429++; await new Promise((d) => setTimeout(d, Math.max(1, Number(r.retry) || 5) * 1000)); } }
let res429 = 0;
async function once(method: 'GET' | 'POST', p: string, body?: unknown) { const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body)); clock = Math.max(clock + 1, Date.now()); const t = String(clock);
  const sig = der(crypto.sign('sha256', Buffer.from(canonicalString(deviceId, host, method, p, t, raw)), { key, dsaEncoding: 'ieee-p1363' }));
  const started = performance.now(); const r = await fetch(`http://${host}${p}`, { method, headers: { 'X-Instar-Device': deviceId, 'X-Instar-Device-Time': t, 'X-Instar-Device-Sig': sig, ...(raw ? { 'Content-Type': 'application/json' } : {}) }, body: raw });
  const text = await r.text(); let json: any = text; try { json = JSON.parse(text); } catch {} return { status: r.status, retry: r.headers.get('retry-after'), body: json, ms: performance.now() - started }; }
async function list() { const rows: any[] = [], meta: any[] = []; let cursor: string | null = null;
  for (let i = 0; i < 40; i++) { const r = await call('GET', `/mobile/conversations?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (r.status !== 200) throw new Error(`list ${r.status}`); rows.push(...r.body.conversations); const { conversations, nextCursor, ...rest } = r.body; meta.push(rest); cursor = nextCursor ?? null; if (!cursor) break; } return { rows, meta }; }
const fixture = JSON.parse(fs.readFileSync(metaFile, 'utf8')); const res: any = { timings: {} };
if (process.env.CHAT_FIRST) { const lastAt = (t: number) => { const r = fixture.rows[t]; return r && r.length ? (r[r.length - 1].atMs ?? 0) : 0; }; const id = fixture.topics.reduce((b: number, t: number) => (lastAt(t) > lastAt(b) ? t : b), fixture.topics[0]); const t0 = performance.now(); const r = await call('GET', `/telegram/topics/${id}/messages?limit=50`); res.timings.coldChatMs = Math.round(performance.now() - t0); res.chatFirst = { status: r.status, body: r.body }; fs.writeFileSync(out, JSON.stringify(res)); console.log(JSON.stringify({ timings: res.timings })); process.exit(0); }
let s = performance.now(); res.coldList = await list(); res.timings.coldListMs = Math.round(performance.now() - s);
s = performance.now(); await list(); res.timings.warmListMs = Math.round(performance.now() - s);
res.chats = {}; s = performance.now();
for (const id of fixture.topics) { const r = await call('GET', `/telegram/topics/${id}/messages?limit=50`); res.chats[id] = { status: r.status, body: r.body }; }
res.timings.openAllChatsMs = Math.round(performance.now() - s);
res.scrollback = {}; for (const id of fixture.topics.filter((_: number, i: number) => i % 25 === 0)) { const first = res.chats[id].body?.messages?.[0]; if (!first) continue; const r = await call('GET', `/telegram/topics/${id}/messages?limit=50&before=${encodeURIComponent(first.timestamp)}&beforeMessageId=${first.messageId}`); res.scrollback[id] = { status: r.status, body: r.body }; }
res.listAfterOpen = await list();
const unread = res.listAfterOpen.rows.filter((r: any) => r.platform === 'telegram' && r.hasUnread).slice(0, 12); res.marks = {};
for (const row of unread) { const msgs = res.chats[row.id]?.body?.messages ?? []; const m = msgs[msgs.length - 2] ?? msgs[0]; if (!m) continue; const r = await call('POST', '/mobile/conversations/read', { marks: [{ ref: `telegram:${row.id}`, id: m.id ?? `${m.fromUser ? 'in' : 'out'}:${m.messageId}`, atMs: Date.parse(m.timestamp) }] }); res.marks[row.id] = { status: r.status, body: r.body }; }
res.listAfterMarks = await list(); fs.writeFileSync(out, JSON.stringify(res)); console.log(JSON.stringify({ rows: res.coldList.rows.length, timings: res.timings, rateLimited: res429 }));
