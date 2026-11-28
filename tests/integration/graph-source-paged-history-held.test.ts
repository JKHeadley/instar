/** Real Source/Native/W ACT with synthetic owner-stage component consent.
 * Read-only-held only: no NativeAdmin, SourceACK or feature activation proof. */
import { describe, vi } from 'vitest';
import { registerPagedHistoryPrivacyCases } from '../helpers/graph-source-paged-history-privacy.js';

// Multi-machine graph proof: takes longer than the push lane's 10 s default on slower Linux CI runners.
vi.setConfig({testTimeout:120_000});

describe('actual Source paged historical read-only held import',()=>{
  registerPagedHistoryPrivacyCases(['detached-descendants', 'independent-process-deny']);
});
