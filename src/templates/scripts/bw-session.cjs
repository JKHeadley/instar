// Shared helper for the local credential-custody tools: unlock Bitwarden with the
// master password from the local vault (never printed), run bw commands, lock again.
const { execFileSync } = require('child_process');
const vaultGet = (n) => execFileSync('node', ['.instar/scripts/secret-get.mjs', n], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
function openBw() {
  const env = { ...process.env, BW_PW: vaultGet('bitwarden_master_password') };
  const session = execFileSync('bw', ['unlock', '--passwordenv', 'BW_PW', '--raw'], { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (!session) throw new Error('Bitwarden unlock returned no session');
  const benv = { ...process.env, BW_SESSION: session };
  const bw = (args, input) => execFileSync('bw', args, { env: benv, input, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  bw(['sync']);
  return { bw, close: () => { try { bw(['lock']); } catch {} } };
}
module.exports = { openBw, vaultGet };
