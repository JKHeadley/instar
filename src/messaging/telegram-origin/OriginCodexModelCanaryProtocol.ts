import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** These are test-provider model IDs, never claims about available OpenAI models. */
export const CODEX_CANARY_MODELS = ['instar-canary-model-a', 'instar-canary-model-b'] as const;
export const CODEX_CANARY_FALLBACK = 'instar-canary-configured-only';

/** No upstream URL, credentials, forwarding, tools or caller-selected response. */
export async function openCodexCanaryProvider(signal: AbortSignal): Promise<{
  port: number; models: string[]; close: () => Promise<void>; failed: () => boolean;
}> {
  const models: string[] = [], sockets = new Set<Socket>(); let failed = false;
  const server = http.createServer(async (req, res) => {
    if (signal.aborted || req.method !== 'POST' || req.url !== '/v1/responses' || req.headers.authorization || models.length >= 4) {
      failed = true; res.writeHead(403).end(); return;
    }
    let size = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        size += chunk.length; if (size > 256 * 1024) throw new Error('request-size'); chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown; stream?: boolean };
      if (!CODEX_CANARY_MODELS.includes(body.model as typeof CODEX_CANARY_MODELS[number]) || body.stream !== true) throw new Error('request-shape');
      models.push(body.model as string);
      const id = `resp_canary_${models.length}`, item = { id: `msg_canary_${models.length}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'CANARY_OK', annotations: [] }] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let sequence = 0;
      const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
      event('response.created', { response: { id, object: 'response', status: 'in_progress', model: body.model, output: [] } });
      event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'CANARY_OK' });
      event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: 'CANARY_OK' });
      event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', { response: { id, object: 'response', status: 'completed', model: body.model, output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    } catch { failed = true; if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  server.maxConnections = 2; server.requestTimeout = 3000; server.headersTimeout = 3000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const abort = () => { void close(); };
  const close = async () => { signal.removeEventListener('abort', abort); for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) throw new Error('canary-aborted');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  if (signal.aborted) { await close(); throw new Error('canary-aborted'); }
  return { port: (server.address() as AddressInfo).port, models, close, failed: () => failed };
}
