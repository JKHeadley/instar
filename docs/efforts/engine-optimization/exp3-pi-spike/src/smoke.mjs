import { Agent } from '@earendil-works/pi-agent-core';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { obj, str } from '@earendil-works/pi-schema';

const model = {
  id: 'qwen3-14b', name: 'Qwen3 14B (local llama-server)', api: 'openai-completions', provider: 'local-llama',
  baseUrl: 'http://127.0.0.1:18431/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096,
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
};
const echoTool = {
  name: 'get_secret_word', label: 'Secret word', description: 'Returns the secret word.',
  parameters: obj({ reason: str() }),
  execute: async () => ({ content: [{ type: 'text', text: 'pineapple' }], details: undefined }),
};
const agent = new Agent({
  initialState: { systemPrompt: 'You are a precise assistant. /no_think', model, tools: [echoTool] },
  streamFn: (m, ctx, opts) => streamSimple(m, normalizeContext(ctx), { ...opts, apiKey: 'local' }),
});
agent.subscribe((e) => {
  if (e.type === 'tool_execution_start') console.log('TOOL', e.toolName, JSON.stringify(e.args));
  if (e.type === 'message_end' && e.message.role === 'assistant') console.log('ASSIST', JSON.stringify(e.message.content).slice(0, 300), e.message.stopReason, e.message.errorMessage || '');
});
const t0 = Date.now();
await agent.prompt('Call the tool to get the secret word, then tell me the word in uppercase.');
console.log('done ms', Date.now() - t0);
