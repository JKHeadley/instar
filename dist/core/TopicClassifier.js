/**
 * TopicClassifier — Deterministic, rule-based topic classification.
 *
 * Part of the Consent & Discovery Framework (Round 2 hardening).
 *
 * Why not LLM-based:
 *   Adversarial reviewer flagged that LLM-based topic extraction reintroduces
 *   prompt injection risk into the discovery pipeline. A user could craft input
 *   that manipulates the topic classifier to trigger specific feature surfacing.
 *
 * This classifier uses keyword matching against a fixed taxonomy. It's less
 * nuanced than an LLM classifier but has zero injection surface. The evaluator
 * (which IS LLM-based) receives these labels as sanitized input.
 *
 * Design:
 *   - Fixed taxonomy of ~15 topic categories
 *   - Keyword sets per category, scored by match density
 *   - Returns top category + confidence score
 *   - Also classifies conversation intent (same approach)
 *   - Input sanitized: lowercased, truncated, non-alpha stripped
 */
// ── Keyword Taxonomy ─────────────────────────────────────────────────
const TOPIC_KEYWORDS = {
    debugging: ['bug', 'error', 'fix', 'broken', 'crash', 'fail', 'exception', 'stack trace', 'debug', 'issue', 'wrong', 'not working', 'undefined', 'null', 'timeout', 'hang', 'stuck'],
    configuration: ['config', 'setting', 'enable', 'disable', 'toggle', 'option', 'preference', 'setup', 'configure', 'turn on', 'turn off', 'activate', 'deactivate', 'parameter'],
    deployment: ['deploy', 'ship', 'release', 'publish', 'build', 'ci', 'cd', 'pipeline', 'production', 'staging', 'rollback', 'version', 'upgrade'],
    security: ['security', 'auth', 'token', 'secret', 'permission', 'access', 'encrypt', 'credential', 'password', 'vulnerability', 'trust', 'certificate'],
    communication: ['message', 'telegram', 'email', 'notify', 'alert', 'send', 'reply', 'chat', 'notification', 'whatsapp', 'slack'],
    monitoring: ['monitor', 'health', 'status', 'metric', 'log', 'dashboard', 'alert', 'uptime', 'latency', 'memory', 'disk', 'cpu', 'usage'],
    development: ['code', 'implement', 'function', 'class', 'test', 'refactor', 'api', 'endpoint', 'module', 'type', 'interface', 'typescript', 'javascript'],
    documentation: ['doc', 'readme', 'spec', 'document', 'explain', 'comment', 'description', 'guide', 'tutorial', 'wiki'],
    collaboration: ['agent', 'threadline', 'network', 'machine', 'sync', 'share', 'collaborate', 'peer', 'relay', 'handshake', 'discover'],
    'data-management': ['database', 'sqlite', 'backup', 'restore', 'snapshot', 'migrate', 'data', 'storage', 'file', 'persist', 'cache'],
    automation: ['job', 'schedule', 'cron', 'automate', 'workflow', 'task', 'recurring', 'trigger', 'hook', 'event'],
    performance: ['slow', 'fast', 'performance', 'optimize', 'speed', 'efficient', 'bottleneck', 'profil', 'memory leak', 'resource'],
    architecture: ['architecture', 'design', 'pattern', 'structure', 'system', 'framework', 'component', 'layer', 'module', 'principle'],
    onboarding: ['new', 'start', 'begin', 'init', 'first', 'getting started', 'install', 'setup', 'introduction', 'welcome'],
    general: [],
};
const INTENT_KEYWORDS = {
    debugging: ['bug', 'error', 'fix', 'broken', 'crash', 'fail', 'not working', 'wrong', 'issue', 'debug', 'trace'],
    configuring: ['config', 'setting', 'enable', 'disable', 'setup', 'configure', 'option', 'toggle', 'turn on', 'turn off'],
    exploring: ['what', 'how', 'why', 'show', 'list', 'tell me', 'capabilities', 'features', 'can you', 'do you'],
    building: ['build', 'create', 'implement', 'add', 'make', 'write', 'develop', 'code', 'new feature', 'spec'],
    asking: ['question', 'help', 'explain', 'clarify', 'understand', 'meaning', 'difference', 'purpose'],
    monitoring: ['check', 'status', 'health', 'monitor', 'watch', 'track', 'log', 'dashboard', 'metric'],
    unknown: [],
};
const PROBLEM_KEYWORDS = {
    'connectivity': ['connect', 'network', 'timeout', 'offline', 'unreachable', 'dns', 'tunnel'],
    'authentication': ['auth', 'login', '401', '403', 'forbidden', 'unauthorized', 'token expired'],
    'data-loss': ['lost', 'missing', 'deleted', 'gone', 'disappeared', 'corrupted', 'empty'],
    'resource-exhaustion': ['memory', 'disk full', 'out of space', 'quota', 'limit', 'exceeded', 'oom'],
    'permission': ['permission', 'denied', 'access', 'readonly', 'write', 'forbidden'],
};
// ── Classifier ───────────────────────────────────────────────────────
const MAX_INPUT_LENGTH = 500;
/**
 * Sanitize input text for classification.
 * Strips control characters, lowercases, truncates.
 */
export function sanitizeInput(text) {
    return text
        .slice(0, MAX_INPUT_LENGTH)
        .toLowerCase()
        .replace(/[^\w\s\-'.?!]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Score a text against a keyword set.
 * Returns 0-1 based on match density.
 */
function scoreKeywords(text, keywords) {
    if (keywords.length === 0)
        return 0;
    let matches = 0;
    for (const kw of keywords) {
        if (text.includes(kw))
            matches++;
    }
    return matches / keywords.length;
}
/**
 * Classify a text into topic category and conversation intent.
 * Purely deterministic — no LLM, no injection surface.
 */
export function classify(rawText) {
    const text = sanitizeInput(rawText);
    // Score topics
    let bestTopic = 'general';
    let bestTopicScore = 0;
    for (const [category, keywords] of Object.entries(TOPIC_KEYWORDS)) {
        if (category === 'general')
            continue;
        const score = scoreKeywords(text, keywords);
        if (score > bestTopicScore) {
            bestTopicScore = score;
            bestTopic = category;
        }
    }
    // Score intents
    let bestIntent = 'unknown';
    let bestIntentScore = 0;
    for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
        if (intent === 'unknown')
            continue;
        const score = scoreKeywords(text, keywords);
        if (score > bestIntentScore) {
            bestIntentScore = score;
            bestIntent = intent;
        }
    }
    // Detect problem categories
    const problemCategories = [];
    for (const [problem, keywords] of Object.entries(PROBLEM_KEYWORDS)) {
        if (scoreKeywords(text, keywords) > 0) {
            problemCategories.push(problem);
        }
    }
    return {
        topicCategory: bestTopic,
        topicConfidence: Math.min(bestTopicScore * 5, 1), // Scale up for useful range
        conversationIntent: bestIntent,
        intentConfidence: Math.min(bestIntentScore * 5, 1),
        problemCategories,
    };
}
/**
 * Classify and return a sanitized DiscoveryContext-compatible object.
 * This is the main entry point for the discovery pipeline.
 */
export function classifyForDiscovery(rawText, autonomyProfile, enabledFeatures, userId) {
    const result = classify(rawText);
    return {
        topicCategory: result.topicCategory,
        conversationIntent: result.conversationIntent,
        problemCategories: result.problemCategories,
        autonomyProfile,
        enabledFeatures,
        userId: userId || 'default',
    };
}
//# sourceMappingURL=TopicClassifier.js.map