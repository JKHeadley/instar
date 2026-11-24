import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { isValidPr, isValidSha } from './record.js';

/** One entry per (repository, PR, SHA). A bounded listing may omit a still-open head for hours. */
export class FirstHeadObservations {
  private readonly latest = new Map<number, { head: string; at: number }>();

  constructor(private readonly directory: string, private readonly audit: (event: Record<string, unknown>) => void) {}

  observe(pr: number, head: string, now: number): number | undefined {
    if (!isValidPr(pr) || !isValidSha(head) || !Number.isSafeInteger(now) || now <= 0) return undefined;
    const cached = this.latest.get(pr);
    if (cached?.head === head) return cached.at;
    const file = path.join(this.directory, pr + '.json');
    try {
      const prior: Record<string, number> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      if (!prior || typeof prior !== 'object' || Array.isArray(prior)) throw new Error('invalid head observations');
      const first = prior[head] ?? now;
      if (!Number.isSafeInteger(first) || first <= 0) throw new Error('invalid observation timestamp');
      if (prior[head] === undefined) {
        prior[head] = first;
        SafeFsExecutor.atomicWriteJsonSync(file, prior, {
          operation: 'local-verify:observe-github-head', mode: 0o600,
        }); /* state-registry: local-verify-head-observations */
      }
      if (this.latest.size >= 4096) this.latest.clear(); // The file retains the first sighting.
      this.latest.set(pr, { head, at: first });
      return first;
    } catch (error) {
      this.audit({ event: 'head-observation-unavailable', pr, headSha: head, detail: String(error) });
      return undefined;
    }
  }
}
