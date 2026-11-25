import type { OriginSessionBinding, OriginSessionRegistry } from '../messaging/telegram-origin/OriginSessionRegistry.js';
import type { TelegramOriginProducer } from '../messaging/telegram-origin/types.js';
import type { CameraAcceptanceRequirement } from './CameraOwnerAcceptance.js';

interface CameraVerifierAssignment {
  readonly principal: string;
  readonly epoch: number;
}

interface CameraVerifierAuthDeps {
  readonly machineId: string;
  readonly sessions: Pick<OriginSessionRegistry, 'verify'>;
  sessionProducer(token: string): Promise<Pick<TelegramOriginProducer, 'producerKind' | 'sessionId' | 'sessionIncarnation' | 'originMachineId'>>;
  /** Resolve the live session's assignment for this pilot, never from request text. */
  assignmentFor(binding: OriginSessionBinding): CameraVerifierAssignment | null;
}

export interface CameraVerifierAuthorization {
  readonly principal: string;
  /** Call under the Camera journal write lock immediately before mutation. */
  allows(requirement: CameraAcceptanceRequirement, assignmentEpoch: number): boolean;
}

/** Strict session credential path. Origin attribution and generic bearer auth confer no authority. */
export async function authorizeCameraVerifier(
  deps: CameraVerifierAuthDeps,
  credential: unknown,
): Promise<CameraVerifierAuthorization | null> {
  if (typeof credential !== 'string' || !/^ior1_[A-Za-z0-9_-]{43}$/.test(credential)) return null;
  try {
    const producer = await deps.sessionProducer(credential);
    if (producer.producerKind !== 'session' || producer.originMachineId !== deps.machineId
      || !producer.sessionId || !producer.sessionIncarnation) return null;

    const resolveAssignment = () => {
      const verification = deps.sessions.verify(credential);
      if (!verification.ok) return null;
      const binding = verification.binding;
      if (binding.machineId !== deps.machineId || binding.sessionId !== producer.sessionId
        || binding.sessionIncarnation !== producer.sessionIncarnation) return null;
      return deps.assignmentFor(binding);
    };

    const initial = resolveAssignment();
    if (!initial?.principal || !Number.isSafeInteger(initial.epoch) || initial.epoch < 1) return null;
    const { principal, epoch } = initial;
    return {
      principal,
      allows(requirement, assignmentEpoch) {
        if (epoch !== assignmentEpoch || principal !== requirement.verifier || requirement.builders.includes(principal)) return false;
        try {
          const current = resolveAssignment();
          return current?.principal === principal && current.epoch === epoch;
        } catch {
          // @silent-fallback-ok: unreadable current authority must refuse the write.
          return false;
        }
      },
    };
  } catch {
    // @silent-fallback-ok: an unverifiable producer has no Camera authority.
    return null;
  }
}
