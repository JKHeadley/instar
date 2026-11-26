import { isAbsolute } from 'node:path';
import {
  firstPhoneSlotDecisionPayload, firstPhoneSlotOperationKey, firstPhoneSlotSuccessor, type FirstPhoneSlotDecision,
} from './FirstPhoneSlotDecision.js';
import { SafeGitExecutor } from './SafeGitExecutor.js';

export const FIRST_PHONE_CANDIDATE_PATH = 'first-phone/candidate.json';

/** The mirror is preconfigured by the witness and must have fetched the exact observed commit. */
export function createFirstPhoneGitCandidateReader(mirror: string):
  (commit: string) => { operation: string; payload: Buffer } | null {
  if (!isAbsolute(mirror)) throw new Error('First-phone Git mirror must be an absolute path');
  return commit => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return null;
    try {
      const body = SafeGitExecutor.readSync(['cat-file', 'blob', `${commit}:${FIRST_PHONE_CANDIDATE_PATH}`], {
        cwd: mirror, operation: 'ordered-publication:read-first-phone-candidate',
        timeout: 5000, maxBuffer: 256 * 1024, env: { GIT_TERMINAL_PROMPT: '0' },
      });
      const [domain, decision] = JSON.parse(body) as [string, FirstPhoneSlotDecision];
      if (domain !== 'instar-first-phone-slot-decision-v1' || !firstPhoneSlotSuccessor(decision) ||
          firstPhoneSlotDecisionPayload(decision) !== body) return null;
      return { operation: firstPhoneSlotOperationKey(decision), payload: Buffer.from(body) };
    } catch {
      return null; // Missing objects and unreadable candidate bytes keep observation pending.
    }
  };
}
