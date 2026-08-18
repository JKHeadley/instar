import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_TIER_ESCALATION_CONFIG,
  resolveTierModel,
} from '../../src/core/ModelTierEscalation.js';
import { resolveClaudeReviewerModel } from '../../src/core/crossModelReviewer.js';
import { resolveApiModelId as resolveAnthropicHeadlessModel } from '../../src/providers/adapters/anthropic-headless/models.js';
import { resolveCliModelFlag as resolveCodexModel } from '../../src/providers/adapters/openai-codex/models.js';
import { resolveCliModelFlag as resolveGeminiModel } from '../../src/providers/adapters/gemini-cli/models.js';
import type { ModelTier } from '../../src/providers/types.js';

interface RegistryPin {
  id: string;
  tier: ModelTier;
  file: string;
  regex: string;
}

interface RegistryManifest {
  pins: RegistryPin[];
}

const repoRoot = process.cwd();
const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'scripts', 'model-registry-freshness.manifest.json'), 'utf8'),
) as RegistryManifest;

function extractPinnedIds(pin: RegistryPin): string[] {
  const source = fs.readFileSync(path.join(repoRoot, pin.file), 'utf8');
  const match = new RegExp(pin.regex).exec(source);
  if (!match) throw new Error(`RUNTIME-RESOLUTION: pin '${pin.id}' regex did not match ${pin.file}`);
  return match.slice(1).filter((id): id is string => typeof id === 'string');
}

type RuntimeResolver = (pin: RegistryPin) => Array<string | null>;

const runtimeResolvers: Record<string, RuntimeResolver> = {
  'gemini-capable-tier': (pin) => [resolveGeminiModel(pin.tier)],
  'codex-capable-tier': (pin) => [resolveCodexModel(pin.tier)],
  'anthropic-headless-capable-tier': (pin) => [resolveAnthropicHeadlessModel(pin.tier)],
  'claude-tier-escalation-default-escalated': () => [
    resolveTierModel('claude-code', 'default', DEFAULT_TIER_ESCALATION_CONFIG),
    resolveTierModel('claude-code', 'escalated', DEFAULT_TIER_ESCALATION_CONFIG),
  ],
  'claude-clean-door-reviewer-default': () => {
    const resolution = resolveClaudeReviewerModel(undefined);
    return [resolution.ok ? resolution.model : null];
  },
};

describe('model registry pins resolve through their real runtime paths', () => {
  it('has an explicit real resolver for every manifest pin', () => {
    expect(Object.keys(runtimeResolvers).sort()).toEqual(manifest.pins.map((pin) => pin.id).sort());
  });

  for (const pin of manifest.pins) {
    it(`${pin.id} resolves every pinned id without an empty result`, () => {
      const expected = extractPinnedIds(pin);
      const resolved = runtimeResolvers[pin.id](pin);
      if (
        resolved.length !== expected.length
        || resolved.some((id) => typeof id !== 'string' || id.length === 0)
      ) {
        throw new Error(
          `RUNTIME-RESOLUTION: pin '${pin.id}' expected [${expected.join(', ')}] `
          + `but its real resolver returned [${resolved.map((id) => id ?? '<empty>').join(', ')}]`,
        );
      }
      expect(resolved).toEqual(expected);
    });
  }
});
