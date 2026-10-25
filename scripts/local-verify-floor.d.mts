export type MergeFloor = 'actions' | 'local';
export const MERGE_FLOOR_MODES: readonly MergeFloor[];
export interface EligibilityView { author?: { login?: string | null } | null; isCrossRepository?: boolean | null }
export function isMergeEligible(view: EligibilityView | null | undefined, logins: { expectedGhLogin?: string | null; operatorGhLogin?: string | null }): boolean;
export function selectMergeFloor(args: { effectiveFloor?: string | null; configRepo?: string | null; repo?: string | null; eligible?: boolean; override?: string | null }): MergeFloor;
export interface ReviewLike { login: string; state: string; commitId: string; submittedAt: string }
export function approvedAtHead(reviews: ReviewLike[], approver: string, headSha: string): { approved: boolean; latestState: string | null };
export interface RulesetReviewPolicy { reviewsRequired: boolean; lastPushApprovalRequired: boolean; codeOwnerReviewRequired?: boolean }
export function extractRulesetReviewPolicy(rules: unknown): RulesetReviewPolicy;
export function reviewPrecheckPasses(args: { policy?: RulesetReviewPolicy | null; classicReviewsRequired?: boolean; reviewDecision?: string | null; codeOwnedTouched?: boolean }): boolean;
export function reviewRequired(args: { policy?: RulesetReviewPolicy | null; classicReviewsRequired?: boolean }): boolean;
export interface CodeownersRule { pattern: string; owners: string[]; re: RegExp }
export function parseCodeowners(text: unknown): CodeownersRule[] | null;
export function codeOwnedFiles(files: readonly string[], rules: readonly CodeownersRule[]): string[];
