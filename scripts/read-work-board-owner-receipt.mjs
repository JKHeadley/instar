// Read capture evidence from the running local agent. This does not open the Team Access log.
const [portArg] = process.argv.slice(2);
const port = Number(portArg);
const token = process.env.INSTAR_AUTH_TOKEN;
const agentId = process.env.INSTAR_AGENT_ID;
if (!/^\d+$/.test(portArg ?? '') || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !token || !agentId) {
  console.error('Usage: INSTAR_AUTH_TOKEN and INSTAR_AGENT_ID from the local agent environment, then node scripts/read-work-board-owner-receipt.mjs PORT');
  process.exitCode = 2;
} else {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/local/work-board/owner-receipt`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Instar-AgentId': agentId },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    const receipt = await response.json();
    console.log(JSON.stringify(receipt));
    if (!response.ok || receipt.ready !== true) process.exitCode = 1;
  } catch {
    console.error('The local agent did not return a Work Board owner receipt.');
    process.exitCode = 1;
  }
}
