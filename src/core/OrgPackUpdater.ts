/**
 * Daily policy update check for a joined agent (docs/specs/org-pack-and-join.md §F).
 *
 * An in-server timer, not an LLM job. It fetches `<updateOrigin>/org/pack/current` (https only, no
 * loopback / link-local / private address after DNS, 256 KB cap, 10 s timeout), validates it with
 * the same `validateBundle` as a join, and then: a change that only lowers the independence cap with
 * identical text is applied with a one-line note; any text change is held for the person's tap in
 * the app. Backoff after a failure: 1, 2, 4, then 7 days; after 30 days with no success it stops and
 * says so once. Runs on the lease holder only.
 */
import dns from 'node:dns/promises';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { INDEPENDENCE_TO_PROFILE, validateBundle, type OrgBundle } from './OrgPack.js';
import { OrgPackStore, type ApplyEffects } from './OrgPackStore.js';

const DAY = 24 * 60 * 60_000;
import { OrgMemberSide } from './OrgMemberSide.js';

export const UPDATE_RESPONSE_MAX_BYTES = 256 * 1024;
const BACKOFF_DAYS = [1, 2, 4, 7];

export interface UpdateState { lastSuccessAt: string | null; failures: number; nextAt: number; stopped: boolean; stoppedNoticeSent?: boolean }

export interface OrgPackUpdaterDeps {
  stateDir: string;
  machineId: string;
  isLeaseHolder: () => boolean;
  effects: () => ApplyEffects;
  /** Tell the person one plain line (an attention item the app shows). */
  notify: (title: string, body: string) => void;
  fanOut?: (change: { membership: import('./OrgPackStore.js').Membership; bundle: OrgBundle | null; op?: 'hold' | 'member-side'; memberSide?: import('./OrgMemberSide.js').MemberSideExport }) => void;
  fetchFn?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
  now?: () => number;
  /** The names a check-in reports (org-members-and-keepers §A); no check-in without it. */
  identity?: () => { agentName: string; personName: string };
}

/** A private, loopback, link-local or unspecified address (v4 or v6). */
export function isNonPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isNonPublicAddress(mapped[1]!);
  if (net.isIPv4(ip)) {
    const first = Number(ip.split('.')[0]);
    if (first >= 224) return true; // multicast and reserved
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!net.isIPv6(ip)) return true; // not an address at all: never fetched
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || /^fe[89ab]/.test(v) || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('ff') || v.startsWith('::ffff:');
}

export class OrgPackUpdater {
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  constructor(private readonly deps: OrgPackUpdaterDeps) { this.now = deps.now ?? Date.now; }

  private stateFile(orgId: string): string { return path.join(this.deps.stateDir, 'org', orgId, 'update-state.json'); }
  readState(orgId: string): UpdateState {
    try { return JSON.parse(fs.readFileSync(this.stateFile(orgId), 'utf-8')) as UpdateState; } catch { // @silent-fallback-ok — a fresh state for a first check
      return { lastSuccessAt: null, failures: 0, nextAt: 0, stopped: false };
    }
  }
  private writeState(orgId: string, s: UpdateState): void {
    const f = this.stateFile(orgId);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  start(): void {
    void this.tick();
    // Check hourly whether a check is due; the due time itself carries the daily cadence and jitter.
    this.timer = setInterval(() => { void this.tick(); }, 60 * 60_000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One due check. Returns what happened (tests drive this directly). */
  async tick(force = false): Promise<'not-due' | 'no-membership' | 'not-holder' | 'stopped' | 'current' | 'applied' | 'held' | 'failed' | 'refused'> {
    const store = new OrgPackStore(this.deps.stateDir, this.deps.machineId, this.now);
    const m = store.membership();
    if (!m || m.state !== 'joined' || !m.updateOrigin) return 'no-membership';
    if (!this.deps.isLeaseHolder()) return 'not-holder';
    const st = this.readState(m.orgId);
    if (st.stopped && !force) return 'stopped';
    if (!force && st.nextAt > this.now()) return 'not-due';
    const fetched = await this.fetchPack(m.updateOrigin);
    if (!fetched.ok) {
      const failures = st.failures + 1;
      // Never succeeded: count from when this membership began, so the 30-day stop still comes.
      const sinceOk = st.lastSuccessAt ? Date.parse(st.lastSuccessAt) : (Date.parse(m.changedAt) || this.now());
      const stopped = this.now() - sinceOk > 30 * DAY;
      this.writeState(m.orgId, { ...st, failures, stopped, nextAt: this.now() + BACKOFF_DAYS[Math.min(failures - 1, BACKOFF_DAYS.length - 1)]! * DAY });
      if (stopped && !st.stoppedNoticeSent) {
        const rec = store.currentRecord();
        this.deps.notify('Organization updates paused', `I haven't been able to reach ${rec?.orgName ?? 'your organization'} for policy updates since ${st.lastSuccessAt?.slice(0, 10) ?? 'joining'}. A new invitation link will update me.`);
        this.writeState(m.orgId, { ...this.readState(m.orgId), stoppedNoticeSent: true });
      }
      return 'failed';
    }
    const jitter = crypto.randomInt(0, 60 * 60_000);
    this.writeState(m.orgId, { lastSuccessAt: new Date(this.now()).toISOString(), failures: 0, stopped: false, nextAt: this.now() + DAY + jitter });
    // The daily check-in (org-members-and-keepers §A), only with the person's consent; it never blocks the update.
    if (this.deps.identity) {
      const side = new OrgMemberSide(this.deps.stateDir, m.orgId, this.now);
      const before = side.state()?.pendingRemoval?.id ?? null;
      try {
        await side.send(m.updateOrigin, { ...this.deps.identity(), appliedVersion: m.version ?? 0, state: 'joined' }, { fetchFn: this.deps.fetchFn, lookup: this.deps.lookup });
      } catch { /* @silent-fallback-ok — a failed check-in is retried tomorrow */ }
      // Copy the check-in state (enrolled, rejoin, notices) to this agent's other machines.
      const x = side.exportForPeer();
      if (x) this.deps.fanOut?.({ membership: m, bundle: null, op: 'member-side', memberSide: x });
      const after = side.state()?.pendingRemoval;
      if (after && after.id !== before) {
        const rec = store.currentRecord();
        this.deps.notify('Removed from an organization', `${rec?.orgName ?? 'Your organization'} marked you as no longer part of it. Open the Instar app to decide whether to remove its policy.`);
      }
    }
    const held = store.heldFor(m.orgId);
    const v = validateBundle(fetched.body, held);
    if (!v.ok) return 'refused';
    const incoming = v.bundle;
    if (incoming.record.version <= (m.version ?? 0)) return 'current';
    const cur = store.currentRecord();
    // Only a lower cap may apply without a tap: the text AND every other field the person saw must be unchanged.
    const sameText = !!cur && cur.policySha256 === incoming.record.policySha256 && cur.orgName === incoming.record.orgName
      && cur.updateOrigin === incoming.record.updateOrigin && JSON.stringify(cur.keepers) === JSON.stringify(incoming.record.keepers);
    const capLower = !!cur && order(INDEPENDENCE_TO_PROFILE[incoming.record.maxIndependence]) < order(INDEPENDENCE_TO_PROFILE[cur.maxIndependence]);
    if (sameText && (capLower || incoming.record.maxIndependence === cur!.maxIndependence)) {
      const r = store.apply(incoming, {}, this.deps.effects());
      if (r.ok) {
        const after = store.membership();
        if (after) this.deps.fanOut?.({ membership: after, bundle: incoming });
        if (capLower) this.deps.notify('Organization policy updated', `${incoming.record.orgName}'s policy now allows at most ${incoming.record.maxIndependence}.`);
        return 'applied';
      }
      return 'refused';
    }
    // Any text change (or a raised cap) waits for the person's tap in the app.
    const dir = path.join(this.deps.stateDir, 'org', m.orgId, 'held', `v${incoming.record.version}`);
    if (!fs.existsSync(path.join(dir, 'bundle.json'))) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(incoming), { mode: 0o600 });
      const mem = store.membership();
      if (mem) this.deps.fanOut?.({ membership: mem, bundle: incoming, op: 'hold' });
    }
    this.deps.notify('Organization policy changed', `${incoming.record.orgName} published version ${incoming.record.version} of its AI policy. Open the Instar app to read the changes and accept them.`);
    return 'held';
  }

  private fetchPack(origin: string): Promise<{ ok: true; body: unknown } | { ok: false }> {
    // Only a 200 with a JSON body counts as reaching the organization (a non-JSON page is a failed check, with backoff).
    return orgRequest(origin, '/org/pack/current', undefined, this.deps).then((r) => r.ok && r.status === 200 && r.body !== null ? { ok: true as const, body: r.body } : { ok: false as const });
  }
}

/**
 * One outgoing call to an organization's agent, with the update check's address rules (spec
 * org-pack-and-join §F; members-and-keepers §A): https only, every resolved address public, the
 * connection pinned to the address that was checked, 10 s, 256 KB. GET without a body, POST with one.
 */
export async function orgRequest(
  origin: string, pathname: string, body: unknown | undefined,
  deps: { fetchFn?: typeof fetch; lookup?: (host: string) => Promise<string[]> },
): Promise<{ ok: true; status: number; body: unknown } | { ok: false }> {
  {
    let url: URL;
    try { url = new URL(pathname, origin); } catch { return { ok: false }; } // @silent-fallback-ok — a bad origin counts as a failed call
    if (url.protocol !== 'https:') return { ok: false };
    const method = body === undefined ? 'GET' : 'POST';
    const payload = body === undefined ? undefined : JSON.stringify(body);
    try {
      const addrs = deps.lookup ? await deps.lookup(url.hostname) : (await dns.lookup(url.hostname, { all: true })).map((a) => a.address);
      if (!addrs.length || addrs.some(isNonPublicAddress)) return { ok: false };
      if (deps.fetchFn) {
        // Test seam: the injected fetch stands in for the pinned request below.
        const res = await deps.fetchFn(url, { method, signal: AbortSignal.timeout(10_000), redirect: 'error', ...(payload ? { body: payload, headers: { 'Content-Type': 'application/json' } } : {}) });
        const text = await res.text();
        if (Buffer.byteLength(text, 'utf8') > UPDATE_RESPONSE_MAX_BYTES) return { ok: false };
        let parsed: unknown = null; try { parsed = JSON.parse(text); } catch { parsed = null; } // @silent-fallback-ok — a non-JSON answer reads as null
        return { ok: true, status: res.status, body: parsed };
      }
      // Connect to the address that was checked, so DNS rebinding cannot swap it; stop reading at the cap.
      const pinned = addrs[0]!;
      const got = await new Promise<{ status: number; text: string } | null>((resolve) => {
        const req = https.request(url, {
          method, timeout: 10_000, servername: url.hostname,
          ...(payload ? { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } } : {}),
          // Answer in the shape asked for: Node asks with {all: true} and expects a list.
          lookup: ((_h: string, o: { all?: boolean } | number | undefined, cb: (...args: unknown[]) => void) => {
            const family = net.isIPv6(pinned) ? 6 : 4;
            if (typeof o === 'object' && o?.all) cb(null, [{ address: pinned, family }]);
            else cb(null, pinned, family);
          }) as never,
        }, (res) => {
          let size = 0; const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => { size += c.length; if (size > UPDATE_RESPONSE_MAX_BYTES) { req.destroy(); resolve(null); return; } chunks.push(c); });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', () => resolve(null));
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.end(payload);
      });
      if (!got) return { ok: false };
      let parsed: unknown = null; try { parsed = JSON.parse(got.text); } catch { parsed = null; } // @silent-fallback-ok — a non-JSON answer reads as null
      return { ok: true, status: got.status, body: parsed };
    } catch { return { ok: false }; } // @silent-fallback-ok — any network failure is a failed call
  }
}

const ORDER = ['cautious', 'supervised', 'collaborative', 'autonomous'];
function order(level: string): number { return ORDER.indexOf(level); }
