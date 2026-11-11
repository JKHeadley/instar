export const GITHUB_LOGIN_RE: RegExp;
export function resolveReviewerLogins(args?: { explicit?: string[] | null; repoOwner?: string | null; author?: string | null }): string[];
export function requestedReviewerLogins(requestedReviewers: unknown): string[];
export function confirmedRequested(responseBody: unknown, logins: string[]): string[];
