import fs from 'node:fs';
import path from 'node:path';
import { isNotificationCategory } from './notificationCategories.js';
import type { NotificationCategoryId } from './notificationCategories.js';
export interface NotificationPreferenceIntent {
  category: NotificationCategoryId; enabled: boolean; version: string; issuer: string;
  confirmedBy: 'dashboard-pin' | 'operator-conversational-confirm'; confirmedAt: string;
}
interface Pending { intent: NotificationPreferenceIntent; peer: string; attempts: number; nextAt: number }
/** One writer API for local confirmed changes and authenticated same-agent replication. */
export class NotificationPreferences {
  private desired: Partial<Record<NotificationCategoryId, NotificationPreferenceIntent>> = {};
  private changes: number[] = [];
  private lastMassChange = 0;
  private versions: Partial<Record<NotificationCategoryId, string>> = {};
  private pending: Pending[] = [];
  private serial: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  private file: string;
  private timer: ReturnType<typeof setInterval>;
  private draining = false;
  private offlinePeers = new Set<string>();
  constructor(private options: {
    root: string; self: () => string; peers: () => string[];
    read?: (category: NotificationCategoryId) => boolean;
    onMassChange?: () => Promise<void>;
    apply: (category: NotificationCategoryId, enabled: boolean) => void;
    send: (peer: string, intent: NotificationPreferenceIntent) => Promise<boolean>;
  }) {
    this.file = path.join(options.root, 'state', 'notification-preferences.json');
    this.ready = this.load();
    void this.ready.catch(error => console.warn('[selectivity] preference state unavailable:', error));
    this.timer = setInterval(() => { void this.drain(); }, 60000); this.timer.unref();
  }
  private async load(): Promise<void> {
    try {
      const text = await fs.promises.readFile(this.file, 'utf8');
      if (text.length > 1024 * 1024) throw new Error('Notification preferences exceed their bound');
      const state = JSON.parse(text);
      if (Array.isArray(state.offlinePeers)) this.offlinePeers = new Set(state.offlinePeers.filter((peer: unknown) => typeof peer === 'string').slice(0, 16));
      if (state.versions && typeof state.versions === 'object') this.versions = state.versions;
      if (state.desired && typeof state.desired === 'object') for (const intent of Object.values(state.desired)) if (validIntent(intent)) this.desired[intent.category] = intent;
      if (Array.isArray(state.pending)) this.pending = state.pending.filter((row: Pending) => validIntent(row.intent) && typeof row.peer === 'string').slice(0, 512);
      for (const intent of Object.values(this.desired)) await this.apply(intent!);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private async save(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.writeFile(this.file + '.next', JSON.stringify({ offlinePeers: [...this.offlinePeers], desired: this.desired, versions: this.versions, pending: this.pending }));
    await fs.promises.rename(this.file + '.next', this.file);
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.serial.then(async () => { await this.ready; return fn(); });
    this.serial = work.catch(error => { console.warn('[selectivity] preference transaction failed:', error); }); return work;
  }
  private nextVersion(self: string): string {
    const observed = [...Object.values(this.versions), ...Object.values(this.desired).map(row => row!.version)].filter((value): value is string => !!value).map(parseVersion).filter((value): value is { time: number; counter: number } => value !== null);
    const maximum = observed.reduce((best, value) => value.time > best.time || value.time === best.time && value.counter > best.counter ? value : best, { time: 0, counter: 0 });
    const time = Math.max(Date.now(), maximum.time), counter = time === maximum.time ? maximum.counter + 1 : 0;
    if (counter > 9999999999) throw new Error('Notification preference logical clock exhausted');
    return `${new Date(time).toISOString()}:${String(counter).padStart(10, '0')}:${encodeURIComponent(self)}`;
  }
  set(category: NotificationCategoryId, enabled: boolean, confirmedBy: NotificationPreferenceIntent['confirmedBy']): Promise<NotificationPreferenceIntent> {
    return this.enqueue(async () => {
      const self = this.options.self();
      const intent: NotificationPreferenceIntent = { category, enabled, confirmedBy, issuer: self,
        version: this.nextVersion(self), confirmedAt: new Date().toISOString() };
      this.desired[category] = intent;
      this.pending = this.pending.filter(row => row.intent.category !== category);
      for (const peer of [...new Set(this.options.peers())].filter(id => id !== self).slice(0, 16)) this.pending.push({ peer, intent, attempts: 0, nextAt: Date.now() });
      await this.save(); // Durable desired state and fan-out precede the config mutation.
      await this.apply(intent);
      await this.save();
      this.changes = this.changes.filter(at => Date.now() - at < 600000); this.changes.push(Date.now());
      if (this.changes.length > 2 && Date.now() - this.lastMassChange >= 600000) { this.lastMassChange = Date.now(); await this.options.onMassChange?.(); }
      return intent;
    });
  }
  receive(intent: unknown, sender: string): Promise<boolean> {
    if (!validIntent(intent) || intent.issuer !== sender) return Promise.resolve(false);
    return this.enqueue(async () => { if ((this.versions[intent.category] ?? '') < intent.version) { this.desired[intent.category] = intent; await this.save(); await this.apply(intent); await this.save(); } return true; });
  }
  private async apply(intent: NotificationPreferenceIntent): Promise<void> {
    if ((this.versions[intent.category] ?? '') >= intent.version) return;
    // Audit precedes granting push. An audit failure cannot grant a silent opt-in.
    const audit = path.join(this.options.root, 'logs', 'notification-preferences.jsonl');
    await fs.promises.mkdir(path.dirname(audit), { recursive: true });
    const stat = await fs.promises.stat(audit).catch(() => null);
    if (stat && stat.size > 2 * 1024 * 1024) await fs.promises.rename(audit, audit + '.previous');
    await fs.promises.appendFile(audit, JSON.stringify({ ...intent, oldEnabled: this.options.read?.(intent.category) ?? null, oldVersion: this.versions[intent.category] ?? null }) + '\n');
    this.options.apply(intent.category, intent.enabled);
    this.versions[intent.category] = intent.version;
  }
  async drain(): Promise<void> {
    if (this.draining || this.pending.length === 0) return; this.draining = true;
    try {
      await this.enqueue(async () => {
        for (const row of this.pending.filter(row => row.attempts < 8 && row.nextAt <= Date.now()).slice(0, 16)) {
          let delivered = false;
          try { delivered = await this.options.send(row.peer, row.intent); }
          catch { /* @silent-fallback-ok — retained durable intent with bounded backoff; status exposes pending peers */ }
          if (delivered) this.pending.splice(this.pending.indexOf(row), 1);
          else { row.attempts++; row.nextAt = Date.now() + Math.min(21600000, 1000 * 5 ** Math.min(7, row.attempts)); }
        }
        await this.save();
      });
    } catch (error) { /* @silent-fallback-ok: logged and durable pending intents remain visible in status */ console.warn('[selectivity] preference replication unavailable:', error); }
    finally { this.draining = false; }
  }
  peerUnavailable(peer: string): void {
    void this.enqueue(async () => { if (!this.offlinePeers.has(peer) && this.offlinePeers.size < 16) { this.offlinePeers.add(peer); await this.save(); } }).catch(error => { /* @silent-fallback-ok: pending work remains durable; failure is logged */ console.warn('[selectivity] peer presence persistence unavailable:', error); });
  }
  peerReturned(peer: string): void {
    void this.enqueue(async () => {
      // Presence is polled repeatedly: only an observed offline→online edge rearms.
      if (!this.offlinePeers.delete(peer)) return;
      for (const row of this.pending) if (row.peer === peer) { row.attempts = 0; row.nextAt = Date.now(); }
      await this.save();
    }).then(() => this.drain()).catch(error => { /* @silent-fallback-ok: pending work remains durable; failure is logged */ console.warn('[selectivity] peer presence persistence unavailable:', error); });
  }
  status(): { pending: number; peersPending: string[] } { return { pending: this.pending.length, peersPending: [...new Set(this.pending.map(row => row.peer))] }; }
  async close(): Promise<void> { clearInterval(this.timer); await this.serial; }
}
function validIntent(value: unknown): value is NotificationPreferenceIntent {
  if (!value || typeof value !== 'object') return false;
  const row = value as NotificationPreferenceIntent;
  return isNotificationCategory(row.category) && typeof row.enabled === 'boolean' && typeof row.issuer === 'string' && row.issuer.length <= 128
    && typeof row.version === 'string' && row.version.length <= 500 && parseVersion(row.version) !== null && row.version.endsWith(':' + encodeURIComponent(row.issuer)) && Number.isFinite(Date.parse(row.confirmedAt))
    && ['dashboard-pin', 'operator-conversational-confirm'].includes(row.confirmedBy);
}

function parseVersion(version: string): { time: number; counter: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):(\d{10}):[^:]+$/.exec(version);
  return match && Number.isFinite(Date.parse(match[1])) ? { time: Date.parse(match[1]), counter: Number(match[2]) } : null;
}
