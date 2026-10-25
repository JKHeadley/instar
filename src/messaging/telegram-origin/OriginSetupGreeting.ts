import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mergeConfigWithSecrets } from '../../core/SecretMigrator.js';

export interface OriginSetupGreetingInput { agentName: string; userName: string; autonomy: 'guided' | 'proactive' | 'autonomous'; }
export function renderOriginSetupGreeting(input: OriginSetupGreetingInput): string {
  if (!input || Object.keys(input).some(key => !['agentName', 'userName', 'autonomy'].includes(key)) ||
    ![input.agentName, input.userName].every(name => typeof name === 'string' && name.trim().length > 0 && name.length <= 128 && !/[\x00-\x1f\x7f]/.test(name)) ||
    !['guided', 'proactive', 'autonomous'].includes(input.autonomy)) throw new Error('invalid-setup-greeting');
  const autonomyBlurb = input.autonomy === 'guided' ? "I'll check with you before doing things."
    : input.autonomy === 'autonomous' ? "I'll own outcomes end-to-end and report back when something needs you."
    : "I'll take initiative on obvious next steps and ask when uncertain.";
  return `Hey ${input.userName.trim()}, ${input.agentName.trim()} here — server's up and I'm online.\n\nThis is the Lifeline topic, our main conversation. Each topic is a separate conversation thread, like a Slack channel. Anything that doesn't fit elsewhere can go here. You can ask me to create a topic for a different task.\n\n${autonomyBlurb}\n\nAnything we set up just now — name, focus, autonomy, messaging — you can change anytime just by chatting me. What would you like to work on first?`;
}

/** A standalone setup CLI asks the running server to author its fixed greeting.
 * The CLI never needs a bot credential or claims a model for that template. */
export async function sendOriginSetupGreeting(projectDir: string, input: OriginSetupGreetingInput): Promise<boolean> {
  const stateDir = path.join(projectDir, '.instar');
  let config: Record<string, any>;
  try { config = mergeConfigWithSecrets(JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8')), stateDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  const telegram = config.messaging?.find((item: any) => item.type === 'telegram' && item.enabled !== false);
  if (!telegram?.config?.lifelineTopicId) return false;
  if (typeof config.authToken !== 'string' || !config.authToken) throw new Error('setup-server-authorization-unavailable');
  const port = config.port ?? 4040;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('invalid-setup-server-port');
  renderOriginSetupGreeting(input); // validate before the local request
  const response = await fetch(`http://127.0.0.1:${port}/telegram/setup/greeting`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.authToken}` },
    body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json() as { messageId?: number };
  if (!response.ok || !Number.isSafeInteger(result.messageId) || Number(result.messageId) <= 0) throw new Error('setup-greeting-held');
  return true;
}
