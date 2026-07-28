// Hermetic mock OpenAI-completions server for pi adapter tests
// (PI-HARNESS-INTEGRATION-SPEC §7). Zero credentials, localhost only.
//
// Scripted turns:
//   Turn 1 (no tool result in messages): streams a `bash` tool call running
//     `echo HERMETIC-TOOL-EXEC-OK && pwd`, then finish_reason=tool_calls.
//   Turn 2 (a role:"tool" message present): streams the final text
//     "EVAL-COMPLETE: tool ran and result received.", finish_reason=stop.
//
// Config via env:
//   PI_MOCK_PORT        — listen port (default 18923)
//   PI_MOCK_LOG         — JSONL file appending every request body (optional)
//   PI_MOCK_TURN1_DELAY — ms to hold turn 1 open before the finish chunk
//                         (default 0; set ~4000 to open a steering window)
//
// Prints "mock-openai listening on <port>" on stdout when ready.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PI_MOCK_PORT ?? 18923);
const LOG = process.env.PI_MOCK_LOG ?? '';
const TURN1_DELAY = Number(process.env.PI_MOCK_TURN1_DELAY ?? 0);
let calls = 0;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    calls += 1;
    if (LOG) {
      fs.appendFileSync(LOG, JSON.stringify({ n: calls, url: req.url, body: parsed }) + '\n');
    }
    const hasToolResult = (parsed.messages || []).some((m) => m.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const id = `chatcmpl-mock-${calls}`;
    const base = { id, object: 'chat.completion.chunk', created: 1700000000, model: parsed.model };
    if (!hasToolResult) {
      // Turn 1: emit a bash tool call.
      sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_eval_1', type: 'function', function: { name: 'bash', arguments: '' } }] }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: 'echo HERMETIC-TOOL-EXEC-OK && pwd' }) } }] }, finish_reason: null }] });
      const finish = () => {
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (TURN1_DELAY > 0) setTimeout(finish, TURN1_DELAY);
      else finish();
      return;
    }
    // Turn 2: final text after the tool result.
    sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'EVAL-COMPLETE: tool ran and result received.' }, finish_reason: null }] });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock-openai listening on ${PORT}`));
