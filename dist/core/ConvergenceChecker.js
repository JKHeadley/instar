/**
 * ConvergenceChecker — TypeScript port of convergence-check.sh.
 *
 * Heuristic content quality gate. No LLM calls. Completes in <10ms.
 * Checks 7 categories of common agent failure modes via regex:
 *
 * 1. capability_claims — Claims about what the agent can't do
 * 2. commitment_overreach — Promises that may not survive sessions
 * 3. settling — Accepting empty results without investigation
 * 4. experiential_fabrication — Claiming first-person experience
 * 5. sycophancy — Reflexive agreement, excessive apology
 * 6. url_provenance — URLs with unfamiliar domains
 * 7. temporal_staleness — Language suggesting outdated perspective
 */
// ── Whitelisted Domains ──────────────────────────────────────────────
const SAFE_DOMAINS = new Set([
    'github.com', 'vercel.app', 'vercel.com', 'netlify.app', 'netlify.com',
    'npmjs.com', 'npmjs.org', 'cloudflare.com', 'google.com', 'twitter.com',
    'x.com', 'youtube.com', 'reddit.com', 'discord.com', 'discord.gg',
    'telegram.org', 't.me', 'localhost', '127.0.0.1', 'stackoverflow.com',
    'developer.mozilla.org', 'docs.anthropic.com', 'anthropic.com',
    'openai.com', 'claude.ai', 'notion.so', 'linear.app', 'fly.io',
    'render.com', 'railway.app', 'heroku.com', 'amazonaws.com', 'azure.com',
    'gitlab.com', 'bitbucket.org', 'docker.com', 'hub.docker.com',
    'pypi.org', 'crates.io', 'rubygems.org', 'pkg.go.dev', 'wikipedia.org',
    'medium.com', 'substack.com', 'circle.so', 'ghost.io', 'telegraph.ph',
]);
const CHECKS = [
    {
        category: 'capability_claims',
        pattern: /(unfortunately.{0,20}(i can.t|i.m unable|not (possible|available|supported))|i don.t have (the ability|access|a way)|this (isn.t|is not) (possible|available|supported))/i,
        detail: 'Claims a limitation without verifying capabilities first.',
    },
    {
        category: 'commitment_overreach',
        pattern: /(i.ll (make sure|ensure|guarantee|always|never forget)|i (promise|commit to|will always)|you can count on me to|i.ll remember (to|this)|from now on i.ll)/i,
        detail: 'Makes a promise that may not survive context compaction or session end.',
    },
    {
        category: 'settling',
        pattern: /(no (data|results|information) (available|found|exists)|nothing (to report|happened|was found)|there (is|are) no|could(n.t| not) find (any|the)|appears to be empty|no (relevant|matching|applicable))/i,
        detail: 'Reports nothing found without investigating multiple sources.',
    },
    {
        category: 'experiential_fabrication',
        pattern: /(i (can see|noticed|observed|felt|sensed|perceived) (that |the |a |an )|looking at (this|the|your)|from what i.ve (seen|read|observed)|i.ve (reviewed|examined|analyzed|inspected) (the|your|this))/i,
        detail: 'Claims first-person experience without tool verification.',
    },
    {
        category: 'sycophancy',
        pattern: /(you.re (absolutely|totally|completely) right|i (completely|totally|fully) (agree|understand)|great (question|point|observation)|i apologize for|sorry.{0,20}(mistake|confusion|error|oversight)|that.s (a |an )?(excellent|great|wonderful|fantastic) (point|question|idea|suggestion))/i,
        detail: 'Reflexive agreement or excessive apology detected.',
    },
    {
        category: 'temporal_staleness',
        pattern: /(i used to (think|believe|feel|assume)|back when i (first|started|was new)|at (that|the) time i|my (early|earlier|initial|original|first) (understanding|thinking|view|perspective|approach)|i didn.t yet understand|before i (learned|realized|discovered|knew)|i (once|previously) (thought|believed|felt)|this was (before|when) i)/i,
        detail: 'References past understanding that may be outdated.',
    },
];
// ── URL Extraction ──────────────────────────────────────────────────
const URL_PATTERN = /https?:\/\/[^\s)"'>]+/g;
function extractDomain(url) {
    try {
        const match = url.match(/^https?:\/\/([^/:]+)/);
        return match ? match[1].toLowerCase() : null;
    }
    catch {
        return null;
    }
}
function isDomainSafe(domain) {
    // Check exact match first
    if (SAFE_DOMAINS.has(domain))
        return true;
    // Check if domain is a subdomain of a safe domain
    for (const safe of SAFE_DOMAINS) {
        if (domain.endsWith('.' + safe))
            return true;
    }
    return false;
}
// ── Main Function ───────────────────────────────────────────────────
export function checkConvergence(content) {
    const issues = [];
    // Run regex checks (categories 1-5, 7)
    for (const check of CHECKS) {
        if (check.pattern.test(content)) {
            issues.push({ category: check.category, detail: check.detail });
        }
    }
    // Category 6: URL provenance
    const urls = content.match(URL_PATTERN);
    if (urls) {
        const unfamiliar = [];
        for (const url of urls) {
            const domain = extractDomain(url);
            if (domain && !isDomainSafe(domain)) {
                unfamiliar.push(url);
            }
        }
        if (unfamiliar.length > 0) {
            issues.push({
                category: 'url_provenance',
                detail: `Unfamiliar domain(s) detected: ${unfamiliar.join(', ')}. Verify these URLs appeared in actual tool output.`,
            });
        }
    }
    return {
        pass: issues.length === 0,
        issues,
    };
}
//# sourceMappingURL=ConvergenceChecker.js.map