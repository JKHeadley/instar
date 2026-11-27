// E2E subprocess only: stub secrets and prerequisite installation.
export async function load(url, context, nextLoad) {
  if (url.endsWith('/core/SecretManager.js')) {
    return { format: 'module', shortCircuit: true, source: `
      export const SECRET_KEYS = {};
      export class SecretManager {
        initialize() { return 'manual'; }
        backupFromConfig() { return 0; }
      }
    ` };
  }
  if (url.endsWith('/core/Prerequisites.js')) {
    return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(url + '?fixture-original')};
      export async function ensurePrerequisites() {
        return { allMet: true, results: [
          { name: 'tmux', path: process.env.HOME + '/bin/tmux', installed: true },
          { name: 'Claude CLI', path: process.env.HOME + '/bin/claude', installed: true }
        ] };
      }
    ` };
  }
  return nextLoad(url, context);
}
