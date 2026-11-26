// Shared credential consent logic. Callers supply the verified signer and protected submission handling.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ownerNeedsCredentialFieldEligible, type SecretDrop, type SecretRequest, type SecretSubmission } from './SecretDrop.js';
import { mintIsUnverified } from './secretDropMintPolicy.js';

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_VALUE_LENGTH = 10_000;

export interface CredentialRequestBinding {
  ownerId: string;
  /** Source-owned monotonic epoch, advanced whenever a request binding is changed or restored. */
  revision: number;
  /** Kept at the source. Never serialized to a Needs row, disclosure, or receipt. */
  dropToken: string;
  /** Additional exact consent authority when a caller supplies a scoped grant. */
  authorizationBinding?: string;
  presentation: { title: string; why: string; detail: string | null };
}

interface CredentialConsentDependencies {
  drop: Pick<SecretDrop, 'getPending' | 'submitWithReason'>;
  /** The source's exact binding for this opaque Needs request, resolved on every action. */
  bindingFor: (requestId: string, req: Request) => CredentialRequestBinding | null;
  /** Returns the current owner from verified signed request authority, not from the body or query. */
  persist?: (token: string, submission: SecretSubmission) => boolean;
  signedOwnerFor: (request: Request, requestId: string) => { id: string } | null;
}

function reviewedPresentation(binding: CredentialRequestBinding) {
  const { title, why, detail } = binding.presentation;
  return { title, why, detail };
}

function ordinarySingleField(request: SecretRequest | null): request is SecretRequest {
  if (!request || mintIsUnverified(request.mintAuth) || request.browserHost || request.senderVerification || request.fields.length !== 1) return false;
  const name = request.fields[0].name;
  return ownerNeedsCredentialFieldEligible(name);
}

export function createOwnerNeedsCredentialConsent(deps: CredentialConsentDependencies) {
  const key = randomBytes(32);
  const disclosureFor = (requestId: string, binding: CredentialRequestBinding, pending: SecretRequest) =>
    createHmac('sha256', key).update(JSON.stringify([
      requestId, binding.ownerId, binding.revision, binding.dropToken, binding.authorizationBinding ?? null, reviewedPresentation(binding), pending.fields[0].name, pending.expiresAt,
    ])).digest('hex');
  function resolve(req: Request | undefined, requestId: string) {
    if (!req || !REQUEST_ID.test(requestId)) return null;
    try {
      const owner = deps.signedOwnerFor(req, requestId);
      const binding = owner && deps.bindingFor(requestId, req);
      if (!owner || !binding || binding.ownerId !== owner.id || requestId === binding.dropToken
        || !Number.isSafeInteger(binding.revision) || binding.revision < 1) return null;
      const pending = deps.drop.getPending(binding.dropToken);
      return ordinarySingleField(pending) ? { binding, pending } : null;
    } catch {
      // @silent-fallback-ok — authority/storage failure is indistinguishable from a stale request.
      return null;
    }
  }

  return {
    candidate(req: Request | undefined, requestId: string) {
      const current = resolve(req, requestId);
      if (!current) return null;
      const { revision, dropToken } = current.binding;
      return {
        responsibility: 'owner-required' as const,
        ownerAction: 'credential' as const,
        actions: [{ kind: 'credential' as const, requestId }],
        handoffs: [],
        presentation: 'credential-request' as const,
        verifiesCurrentOwnerRequest: (action: { kind: string; requestId?: string }) => {
          if (action.kind !== 'credential' || action.requestId !== requestId) return false;
          const latest = resolve(req, requestId);
          return latest?.binding.dropToken === dropToken && latest.binding.revision === revision && latest.binding.authorizationBinding === current.binding.authorizationBinding;
        },
      };
    },

    disclose(req: Request, requestId: string) {
      const current = resolve(req, requestId);
      return current ? {
        requestId,
        disclosureId: disclosureFor(requestId, current.binding, current.pending),
        ...reviewedPresentation(current.binding),
        inputLabel: 'Credential value',
      } : null;
    },

    submit(req: Request, requestId: string, disclosureId: unknown, value: unknown): 'applied' | 'invalid' | 'stale' | 'unavailable' {
      // Production plumbing must supply the request whose path and raw JSON were signed.
      const body: unknown = req.body;
      if (req.method !== 'POST' || req.params.requestId !== requestId || !body || typeof body !== 'object'
        || !Object.hasOwn(body, 'disclosureId') || !Object.hasOwn(body, 'value') || Object.keys(body).length !== 2
        || (body as { disclosureId: unknown }).disclosureId !== disclosureId || (body as { value: unknown }).value !== value) return 'invalid';
      const current = resolve(req, requestId);
      if (!current || typeof disclosureId !== 'string' || !/^[a-f0-9]{64}$/.test(disclosureId)) return 'stale';
      const { binding, pending } = current;
      const expected = disclosureFor(requestId, binding, pending);
      if (!timingSafeEqual(Buffer.from(disclosureId, 'hex'), Buffer.from(expected, 'hex'))) return 'stale';
      if (typeof value !== 'string' || !value.trim() || value.length > MAX_VALUE_LENGTH) return 'invalid';
      // The verified device signature is the request proof. The source's existing one-time
      // store remains responsible for exact field validation and consuming the pending request.
      const persist = deps.persist;
      const result = deps.drop.submitWithReason(binding.dropToken, pending.csrfToken, { [pending.fields[0].name]: value },
        persist ? submission => persist(binding.dropToken, submission) : undefined);
      if (!('submission' in result)) return result.refused === 'storage-unavailable' ? 'unavailable' : 'stale';
      return 'applied';
    },
  };
}
