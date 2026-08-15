import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  findConfigCredentialLocation,
  assertGrokAuthAllowed,
} from '../../src/providers/adapters/grok-build/policy.js';
import { GrokConfigCredentialForbiddenError } from '../../src/providers/adapters/grok-build/errors.js';

/**
 * Round-21: the auth refusal swept the ENVIRONMENT only, while the vendor's
 * shipped README for the pinned CLI version documents a config-file `api_key`
 * as FIRST in credential resolution — ahead of the subscription session token
 * — with `[model.<name>] api_key = "…"` as a supported override.
 *
 * The adapter was already reading that exact file line-by-line to verify the
 * login policy, so the credential sat in a file it had open and was not
 * looking at. The env sweep could not have caught it at any strength: `env_key`
 * names an ARBITRARY variable to read the key from, so a fixed forbidden-name
 * list is defeated by one indirection.
 */

const HOMES: string[] = [];
afterAll(() => {
  for (const dir of HOMES) {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, sourceTreeOverride: true }); } catch { /* leave it */ }
  }
});

function grokHomeWith(configToml: string | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-cred-'));
  HOMES.push(home);
  if (configToml !== null) fs.writeFileSync(path.join(home, 'config.toml'), configToml);
  return home;
}

/** A config that satisfies the login-policy verifier, so only the credential varies. */
const POLICY_OK = '[auth]\ndisable_api_key_auth = true\n';

describe('grok config-file credential refusal', () => {
  describe('findConfigCredentialLocation', () => {
    it('CONTROL: a policy-only config with no credential key passes', () => {
      expect(findConfigCredentialLocation(grokHomeWith(POLICY_OK))).toBeNull();
    });

    it('CONTROL: an absent config file is a clean pass, not a refusal', () => {
      // Absent is the one case where absence IS proven.
      expect(findConfigCredentialLocation(grokHomeWith(null))).toBeNull();
    });

    it('finds api_key in a [model.*] table — the vendor-documented override', () => {
      const loc = findConfigCredentialLocation(
        grokHomeWith(`${POLICY_OK}\n[model.grok-build]\napi_key = "xai-REDACTED"\n`),
      );
      expect(loc).toBe('[model.grok-build] api_key');
      // The descriptor must never carry the value.
      expect(loc).not.toContain('xai-');
    });

    it('finds env_key — the indirection a forbidden-env-name list cannot cover', () => {
      expect(
        findConfigCredentialLocation(
          grokHomeWith(`${POLICY_OK}\n[model.grok-4]\nenv_key = "SOME_ARBITRARY_VAR"\n`),
        ),
      ).toBe('[model.grok-4] env_key');
    });

    it('finds a top-level credential key', () => {
      expect(findConfigCredentialLocation(grokHomeWith('api_key = "x"\n')))
        .toBe('(top level) api_key');
    });

    it('ignores a commented-out credential key', () => {
      expect(findConfigCredentialLocation(grokHomeWith(`${POLICY_OK}\n# api_key = "x"\n`)))
        .toBeNull();
    });

    it('does NOT match a key that merely ends in api_key', () => {
      // `legacy_api_key` is a different setting; refusing on it would be an
      // over-block, and the anchored key regex is what prevents that.
      expect(findConfigCredentialLocation(grokHomeWith(`${POLICY_OK}\nlegacy_api_key = "x"\n`)))
        .toBeNull();
    });

    it('an existing-but-unreadable config REFUSES — absence is not proven', () => {
      const home = grokHomeWith(POLICY_OK);
      // A directory where the file is expected: readFileSync throws EISDIR,
      // not ENOENT, so this exercises the not-absent-but-unreadable branch.
      SafeFsExecutor.safeUnlinkSync(path.join(home, 'config.toml'), { sourceTreeOverride: true });
      fs.mkdirSync(path.join(home, 'config.toml'));
      const loc = findConfigCredentialLocation(home);
      expect(loc).not.toBeNull();
      expect(loc).toContain('cannot prove');
    });
  });

  describe('assertGrokAuthAllowed refuses at the chokepoint', () => {
    /** A session comfortably inside its expiry, so only the credential decides. */
    function withFreshSession(home: string): string {
      fs.writeFileSync(
        path.join(home, 'auth.json'),
        // The real on-disk shape is a MAP of provider entries, not a list.
        JSON.stringify({
          'xai-oidc': {
            auth_mode: 'oidc',
            expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
          },
        }),
      );
      return home;
    }

    it('CONTROL: admits with a fresh session and no config credential', () => {
      const home = withFreshSession(grokHomeWith(POLICY_OK));
      expect(() =>
        assertGrokAuthAllowed({ grokHome: home } as never, {}, new Date(), 0),
      ).not.toThrow();
    });

    it('refuses when a config-file credential is present, naming the location only', () => {
      const home = withFreshSession(
        grokHomeWith(`${POLICY_OK}\n[model.grok-build]\napi_key = "xai-SECRETVALUE"\n`),
      );
      let thrown: unknown;
      try {
        assertGrokAuthAllowed({ grokHome: home } as never, {}, new Date(), 0);
      } catch (e) { thrown = e; }

      expect(thrown).toBeInstanceOf(GrokConfigCredentialForbiddenError);
      const err = thrown as GrokConfigCredentialForbiddenError;
      expect(err.location).toBe('[model.grok-build] api_key');
      // The value must not reach the message — this error is rendered into
      // transcripts and attention items.
      expect(err.message).not.toContain('SECRETVALUE');
    });
  });
});
