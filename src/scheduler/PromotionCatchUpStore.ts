/** Durable at-most-one automatic missed-job request per verified local promotion. */
import fs from 'node:fs';
import path from 'node:path';

export type PromotionCatchUpStatus = 'ask' | 'skip' | 'requested' | 'triggered' | 'uncertain';
export interface PromotionCatchUpEntry { promotionId: string; slug: string; status: PromotionCatchUpStatus; at: string; }
export class PromotionCatchUpStore {
  private file: string;
  constructor(stateDir: string) { this.file = path.join(stateDir, 'state', 'promotion-catch-up.json'); }
  private read(): PromotionCatchUpEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const value = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { version?: number; entries?: PromotionCatchUpEntry[] };
    if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('promotion-catch-up-journal-corrupt');
    return value.entries.slice(-2000);
  }
  isHealthy(): boolean {
    try { this.read(); return true; } catch { /* @silent-fallback-ok — false blocks catch-up on an unreadable journal */ return false; }
  }
  latestUnresolved(slug: string): PromotionCatchUpEntry | undefined {
    return this.read().filter(row => row.slug === slug && ['ask', 'requested', 'triggered', 'uncertain'].includes(row.status))
      .sort((a, b) => b.at.localeCompare(a.at))[0];
  }
  latestBlocked(slug: string): PromotionCatchUpEntry | undefined {
    return this.read().filter(row => row.slug === slug)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
  }
  hasUnresolved(slug: string, lastSuccess?: string): boolean {
    const row = this.latestBlocked(slug);
    if (!row) return false;
    return !lastSuccess || Date.parse(lastSuccess) <= Date.parse(row.at);
  }
  get(promotionId: string, slug: string): PromotionCatchUpEntry | undefined {
    return this.read().find(row => row.promotionId === promotionId && row.slug === slug);
  }
  /** Writes before launch. A crash cannot repeat a possibly admitted request. */
  record(promotionId: string, slug: string, status: PromotionCatchUpStatus): boolean {
    const entries = this.read();
    const existing = entries.find(row => row.promotionId === promotionId && row.slug === slug);
    if (existing && status === 'requested') return false;
    if (existing) { existing.status = status; existing.at = new Date().toISOString(); }
    else entries.push({ promotionId, slug, status, at: new Date().toISOString() });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: entries.slice(-2000) }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return true;
  }
}
