/**
 * Job Loader — read and validate job definitions from a JSON file.
 *
 * Jobs define recurring work the agent should perform:
 * email checks, health probes, content publishing, etc.
 *
 * Grounding-by-default: Jobs are validated for grounding configuration.
 * Missing grounding emits warnings — nudging the practice without breaking
 * existing jobs. Jobs that process external input WITHOUT grounding get
 * louder warnings because they represent a security surface.
 */
import type { JobDefinition } from '../core/types.js';
/**
 * Load and validate job definitions from a JSON file.
 * Throws on invalid structure — fail loud at startup, not at runtime.
 */
export declare function loadJobs(jobsFile: string): JobDefinition[];
/**
 * Validate a single job definition.
 * Throws with a descriptive message on any issue.
 */
export declare function validateJob(job: unknown, index?: number): void;
/**
 * Validate commonBlockers configuration structure.
 * CommonBlockers are Record<string, CommonBlocker> — keyed object of pre-confirmed resolutions.
 */
export declare function validateCommonBlockers(blockers: unknown, prefix: string): void;
//# sourceMappingURL=JobLoader.d.ts.map