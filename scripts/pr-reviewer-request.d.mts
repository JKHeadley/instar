export const GITHUB_LOGIN_RE: RegExp;
export const MAX_PR_LINKS_PER_MESSAGE: number;
export interface PullRequestLink { owner: string; repo: string; number: number; fullName: string }
export function extractPullRequestLinks(text: unknown): PullRequestLink[];
export function resolveReviewerLogins(args?: { explicit?: string[] | null; repoOwner?: string | null; author?: string | null }): string[];
export function requestedReviewerLogins(requestedReviewers: unknown): string[];
export function confirmedRequested(responseBody: unknown, logins: string[]): string[];
export function toReviewLike(restReviews: unknown): Array<{ login: string; state: string; commitId: string; submittedAt: string }>;
