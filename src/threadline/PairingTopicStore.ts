/**
 * Which Telegram topic each pairing invite belongs to (docs/specs/a2a-pairing-invite-link.md §11.8).
 *
 * Pairing notices go to the topic where the invite was made (inviter) or forwarded (recipient), not
 * to the Lifeline topic. The record must survive a restart, because an invite can be accepted an hour
 * after it was made. One JSON file, mode 0600, `<stateDir>/threadline/pairing-topics.json`. It holds
 * the invite id, the topic id, the role and the invite's expiry: never the invite text or its secret.
 * Entries are dropped 48 hours after their invite expires.
 *
 * Machine-local by design: the invite store it annotates is machine-local too (standalone spec D11).
 * A file that cannot be read or parsed starts empty (notices then fall back to Lifeline) and is
 * reported; it is never a reason to refuse a pairing step.
 */

import fs from 'node:fs';
import path from 'node:path';

export const PAIRING_TOPICS_FILE = 'pairing-topics.json';
const RETAIN_AFTER_EXPIRY_MS = 48 * 60 * 60_000;
const MAX_ENTRIES = 500;

export interface PairingTopicEntry {
  iid: string;
  topicId: number;
  role: 'inviter' | 'recipient';
  exp: string;
  at: string;
}

export class PairingTopicStore {
  private readonly file: string;
  private entries = new Map<string, PairingTopicEntry>();

  constructor(
    stateDir: string,
    private readonly now: () => number = () => Date.now(),
    private readonly report: (problem: string) => void = (p) => console.warn(`[pairing-topics] ${p}`),
  ) {
    this.file = path.join(stateDir, 'threadline', PAIRING_TOPICS_FILE);
    this.load();
  }

  private load(): void {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf-8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.report(`could not read ${this.file}: ${err instanceof Error ? err.message : String(err)}; notices use the Lifeline topic until it can be read`);
      return;
    }
    try {
      const j = JSON.parse(raw) as { entries?: PairingTopicEntry[] };
      for (const e of j.entries ?? []) {
        if (e && /^[0-9a-f]{32}$/.test(String(e.iid)) && Number.isSafeInteger(e.topicId)) this.entries.set(e.iid, e);
      }
    } catch (err) {
      this.report(`${this.file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); starting empty, notices use the Lifeline topic`);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries: [...this.entries.values()] }, null, 2), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.report(`could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}; the topic is kept in memory until a restart`);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [iid, e] of this.entries) {
      const exp = Date.parse(e.exp);
      if (Number.isFinite(exp) && now - exp > RETAIN_AFTER_EXPIRY_MS) this.entries.delete(iid);
    }
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  set(iid: string, topicId: number, role: 'inviter' | 'recipient', exp: string): void {
    const id = String(iid).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(id) || !Number.isSafeInteger(topicId)) return;
    const prev = this.entries.get(id);
    if (prev && prev.topicId === topicId && prev.role === role) return;
    this.entries.delete(id);
    this.entries.set(id, { iid: id, topicId, role, exp, at: new Date(this.now()).toISOString() });
    this.prune();
    this.save();
  }

  get(iid: string): number | undefined {
    return this.entries.get(String(iid).toLowerCase())?.topicId;
  }
}
