import type { RequestHandler } from 'express';
export interface FixtureResponseRecord { id: string; runId: string; origin: string; method: string; url: string; finished: boolean; aborted: boolean; bytes: Buffer | null; sha256?: string; byteLength?: number; status?: number; contentType?: string; contentLength?: string | null; captureError?: boolean }
export type FixtureResponseProvider = (id: string) => FixtureResponseRecord | null;
export const RESPONSE_EVIDENCE_HEADER: string;
export const DECLARED_HEADER_PROBES: readonly string[];
export function createFixtureResponseEvidence(options?: { seedState?: () => 'busy' | 'empty' | 'error'; loading?: ReturnType<typeof import('./accountsLoading.mjs').createAccountsLoadingBarrier> }): { provider: FixtureResponseProvider; bindOrigin: (origin: string) => void; middleware: RequestHandler };
export function providerBinding(provider: unknown, origin: string): { origin: string; runId: string; seedState: 'busy' | 'empty' | 'error'; loading?: {holdId:string;requestId:string} };
export function isDeclaredHeaderProbe(method: string, url: string, origin: string): boolean;
export function joinFixtureProbeEvidence(provider: FixtureResponseProvider, origin: string, observation: unknown): { bytes: Buffer; evidence: Record<string, unknown> };
export function digest(bytes: Buffer): string;

export function providerLoadingAction(provider: FixtureResponseProvider, origin: string, action: string, payload?: unknown): any;
