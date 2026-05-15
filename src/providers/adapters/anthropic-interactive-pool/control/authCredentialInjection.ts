/**
 * AuthCredentialInjection: same validation rules as 3a — interactive pool
 * requires OAuth subscription token for subscription billing.
 */

import type {
  AuthCredentialInjection,
  AuthCredentialSpec,
  ProviderCredential,
} from '../../../primitives/control/authCredentialInjection.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { AuthError } from '../../../errors.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from '../errors.js';

class InteractivePoolAuthCredentialInjection implements AuthCredentialInjection {
  readonly capability = CapabilityFlag.AuthCredentialInjection;

  buildSpec(credential: ProviderCredential): AuthCredentialSpec {
    return { __brand: 'AuthCredentialSpec', credential } as AuthCredentialSpec;
  }

  validate(credential: ProviderCredential): string | null {
    if (credential.kind === 'none') return 'interactive-pool requires credentials';
    if (credential.kind === 'bearer') return 'interactive-pool does not accept bearer tokens';
    if (credential.kind === 'api-key') {
      // API key works but doesn't draw from subscription — warn but allow
      return null;
    }
    if (credential.kind === 'oauth-subscription' && !credential.token.startsWith('sk-ant-oat')) {
      return 'OAuth subscription token must start with "sk-ant-oat"';
    }
    return null;
  }

  async probe(credential: ProviderCredential): Promise<void> {
    const v = this.validate(credential);
    if (v) throw new AuthError(v, ANTHROPIC_INTERACTIVE_POOL_ID);
    // Probing for interactive-pool would require spawning a pool session.
    // Defer to validate() result and validate the credential lazily on
    // first pool spawn.
  }
}

export function createAuthCredentialInjection(): AuthCredentialInjection {
  return new InteractivePoolAuthCredentialInjection();
}
