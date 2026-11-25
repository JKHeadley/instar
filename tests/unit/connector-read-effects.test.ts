import { describe, expect, it } from 'vitest';
import { deriveEffect, verbRules } from '../../src/data/effect-kinds.js';
import { decideAdmission } from '../../src/core/trustJourney/admission.js';

const reads = ['fetch_pr', 'get_pr_info', 'list_pull_requests', 'search_code', 'read_file'];
const mutations = ['create_pull_request', 'push_files', 'comment_on_pr', 'merge_pull_request', 'update_file', 'delete_file'];

function admission(tool: string) {
  return decideAdmission({ effect: deriveEffect(tool, {}), unchangedLegacy: () => false, provenLevel: () => null,
    unreadableHistory: () => false, unusedApproval: () => null });
}

describe('engine-neutral connector effects', () => {
  for (const service of ['codex_apps', 'claude_tools', 'custom_gateway']) {
    for (const separator of ['__', '_']) {
      it.each(reads)(service + ' github' + separator + '%s is a read without a trust grant', (action) => {
        const name = `mcp__${service}__github${separator}${action}`;
        expect(deriveEffect(name, {})?.operation).toBe('read');
        expect(admission(name)).toEqual({ verdict: 'not-gated', why: 'read' });
      });
      it.each(mutations)(service + ' github' + separator + '%s remains governed', (action) => {
        const name = `mcp__${service}__github${separator}${action}`;
        expect(deriveEffect(name, {})?.operation).toBe('modify');
        expect(admission(name)).toEqual({ verdict: 'ask', why: 'no-grant' });
      });
    }
  }
  it.each(['github_get_and_delete', 'github_fetch_and_push', 'github_read_then_comment', 'github_search_and_merge',
    'github_create_and_get', 'execute_get_pr_info', 'github_run_read_file', 'github_unknown_tool', 'github_fetcher', 'github_inspect_read_only', 'github__inspect_read_only', 'github_mystery_get_pr', 'github__mystery_get_pr', 'inspect_read', 'launch_get_status', 'unknown_get', 'opaque'])('%s stays governed', (action) => {
    expect(verbRules(action).operation).not.toBe('read');
    expect(admission(`mcp__gateway__${action}`).verdict).toBe('ask');
  });
  it('keeps existing direct read, write, delete, and sign-in kinds', () => {
    expect(deriveEffect('mcp__github__get_pr_info', {})?.operation).toBe('read');
    expect(deriveEffect('mcp__mail__send_email', {})?.operation).toBe('write');
    expect(deriveEffect('mcp__mail__delete_thread', {})?.operation).toBe('delete');
    expect(deriveEffect('mcp__playwright__browser_type', { element: 'Password', text: 'x' })?.operation).toBe('sign-in');
  });
});
