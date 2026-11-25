// Disposable Needs You adapter. It has no route or production authority of its own.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { SecretDrop, SecretRequest } from './SecretDrop.js';
import { mintIsUnverified } from './secretDropMintPolicy.js';

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const MAX_VALUE_LENGTH = 10_000;

export interface CredentialRequestBinding {
  ownerId: string;
  /** Source-owned monotonic epoch, advanced whenever a request binding is changed or restored. */
  revision: number;
  /** Kept at the source. Never serialized to a Needs row, disclosure, or receipt. */
  dropToken: string;
  presentation: { title: string; why: string; detail: string | null };
}

interface CredentialConsentDependencies {
  drop: Pick<SecretDrop, 'getPending' | 'submitWithReason'>;
  /** The source's exact binding for this opaque Needs request, resolved on every action. */
  bindingFor: (requestId: string) => CredentialRequestBinding | null;
  /** Returns the current owner from verified signed request authority, not from the body or query. */
  signedOwnerFor: (request: Request) => { id: string } | null;
}

function reviewedPresentation(binding: CredentialRequestBinding) {
  const { title, why, detail } = binding.presentation;
  return { title, why, detail };
}

function ordinarySingleField(request: SecretRequest | null): request is SecretRequest {
  if (!request || mintIsUnverified(request.mintAuth) || request.browserHost || request.senderVerification || request.fields.length !== 1) return false;
  const name = request.fields[0].name;
  return FIELD_NAME.test(name) && !Object.hasOwn(Object.prototype, name);
}

export function createOwnerNeedsCredentialConsent(deps: CredentialConsentDependencies) {
  const key = randomBytes(32);
  const disclosureFor = (requestId: string, binding: CredentialRequestBinding, pending: SecretRequest) =>
    createHmac('sha256', key).update(JSON.stringify([
      requestId, binding.ownerId, binding.revision, binding.dropToken, reviewedPresentation(binding), pending.fields[0].name, pending.expiresAt,
    ])).digest('hex');
  function resolve(req: Request | undefined, requestId: string) {
    if (!req || !REQUEST_ID.test(requestId)) return null;
    try {
      const owner = deps.signedOwnerFor(req);
      const binding = owner && deps.bindingFor(requestId);
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
        actions: [{ kind: 'credential' as const, requestId }],
        handoffs: [],
        presentation: reviewedPresentation(current.binding),
        verifiesCurrentOwnerRequest: (action: { kind: string; requestId?: string }) => {
          if (action.kind !== 'credential' || action.requestId !== requestId) return false;
          const latest = resolve(req, requestId);
          return latest?.binding.dropToken === dropToken && latest.binding.revision === revision;
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

    submit(req: Request, requestId: string, disclosureId: unknown, value: unknown): 'applied' | 'invalid' | 'stale' {
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
      const result = deps.drop.submitWithReason(binding.dropToken, pending.csrfToken, { [pending.fields[0].name]: value });
      return 'submission' in result ? 'applied' : 'stale';
    },
  };
}
