const SEARCH = 'GET /mobile/conversations/search?q=...&scope=pool';

export const CONVERSATION_SEARCH_REGISTRY_ROW =
  `| Where did we discuss this before? | \`${SEARCH}\` (app, Telegram, and Slack history) |`;
export const CONVERSATION_SEARCH_CAPABILITY_ROW =
  '| **Conversation Search** | Keyword and meaning search over captured app, Telegram, and Slack history |';
export const SEMANTIC_LEARNINGS_REGISTRY_ROW =
  '| My past learnings about X? | `GET /semantic/search?q=X` (stored facts and learnings) |';
export const CONVERSATION_SEARCH_LOOKUP =
  `5. **Need to find a previous conversation?** Use \`${SEARCH}\`.`;
export const CONVERSATION_SEARCH_PROACTIVE =
  `- User asks **"didn't we talk about X?"** or **"where did I put that?"** → Search conversation history first (\`${SEARCH}\`). Check the relevant work records before concluding that nothing exists.`;

export function conversationSearchGuide(port: number): string {
  return [
    '**Conversation Search** — Search captured app, Telegram, and Slack messages the caller can access.',
    `- Search: \`curl -G -H "Authorization: Bearer $AUTH" --data-urlencode "q=QUERY" "http://localhost:${port}/mobile/conversations/search?scope=pool&limit=10"\``,
    '- Add `mode=meaning` to search by meaning. If that mode is unavailable, use keyword search. If conversation search returns 503 or is unavailable, use `GET /topic/search?q=...` for captured Telegram history.',
    '- Read `partial`, `unsearched`, and `failedMachines` for coverage. A zero-result response only describes the history searched. Check the relevant work records for specs, branches, pull requests, or cards.',
  ].join('\n');
}

/** Replace only shipped pointers in legacy full-length agent guidance. The
 * current reference layout regenerates these sections from the template. */
export function migrateConversationSearchGuidance(content: string): string {
  const replaceLine = (line: string): string => {
    switch (line) {
      case '| Something I wrote before | `GET /memory/search?q=...` |':
        return CONVERSATION_SEARCH_REGISTRY_ROW;
      case '| **Memory Search** | Full-text search over all memory files (FTS5) |':
        return CONVERSATION_SEARCH_CAPABILITY_ROW;
      case '| My past learnings about X? | `GET /memory/search?q=X` |':
        return SEMANTIC_LEARNINGS_REGISTRY_ROW;
      case '5. **Need to find something I wrote before?** Use memory search (`GET /memory/search?q=...`).':
        return CONVERSATION_SEARCH_LOOKUP;
      case '- User asks **"didn\'t we talk about X?"** or **"where did I put that?"** → Use memory search (`GET /memory/search?q=...`). The full-text index covers everything I\'ve written.':
        return CONVERSATION_SEARCH_PROACTIVE;
      default:
        return line;
    }
  };

  const legacyPort = /^- Search: `curl -H "Authorization: Bearer \$AUTH" "http:\/\/localhost:(\d+)\/memory\/search\?q=QUERY&limit=10"`$/m.exec(content)?.[1];
  if (legacyPort) {
    const old = [
      "**Memory Search** — Full-text search over all indexed memory files using SQLite FTS5. Find anything you've ever written to MEMORY.md, handoff notes, or state files.",
      `- Search: \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${legacyPort}/memory/search?q=QUERY&limit=10"\``,
      `- Stats: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${legacyPort}/memory/stats\``,
      `- Reindex: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${legacyPort}/memory/reindex\``,
      `- Sync (incremental): \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${legacyPort}/memory/sync\``,
      '- **Auto-sync**: Search automatically syncs before querying, so results are always current.',
      `- **When to use**: When looking for something you know you wrote but can't remember where. When a user asks "didn't we discuss X?" When building context for a task from past learnings.`,
    ].join('\n');
    content = content.replace(old, () => conversationSearchGuide(Number(legacyPort)));
  }
  return content.split('\n').map(replaceLine).join('\n');
}
