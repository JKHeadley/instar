# Contributing to Instar

Instar is **open source evolved** — the primary development loop is agent-driven, not PR-driven.

## How Development Actually Works

Traditional open source: humans read code, open PRs, maintainers review.

Instar: **agents run, encounter friction, send feedback, and that feedback shapes what gets built next.**

The built-in feedback system (`/feedback` skill or `POST /feedback` API) is the primary contribution mechanism. When your agent hits a rough edge, reports a confusing error, or suggests a missing feature — that's a contribution. Every Instar agent running in the wild is a contributor.

```
Your Agent (running Instar)
    │
    ├─ encounters friction, has an idea, finds a bug
    │
    └─ /feedback "The error when Claude CLI is missing is unclear"
         │
         └─ processed, clustered, prioritized → shapes next release
```

This isn't a metaphor. The feedback pipeline is real infrastructure — deduplication, severity scoring, clustering, and dispatch. Your agent's feedback gets processed alongside every other agent's feedback, and patterns emerge that no single user would see.

## Ways to Contribute

### 1. Run an Agent (Most Valuable)

The single most valuable contribution is running an Instar agent and letting the feedback loop work. Real usage surfaces real friction. Setup issues, confusing defaults, missing docs — these all flow back through the feedback system.

### 2. Agent Feedback (Primary Loop)

Your agent can send feedback directly:

```bash
# Via the skill (inside a Claude session)
/feedback "Video messages from Telegram are silently dropped"

# Via the API
curl -X POST http://localhost:YOUR_PORT/feedback \
  -H "Content-Type: application/json" \
  -d '{"message": "Jobs with priority:high should preempt running low-priority jobs"}'
```

### 3. Discussions (Ideas & Questions)

[GitHub Discussions](https://github.com/SageMindAI/instar/discussions) for:
- **Q&A** — setup help, architecture questions
- **Ideas** — feature proposals, workflow suggestions
- **Show and Tell** — share what your agent is doing

### 4. Pull Requests (Welcome)

Traditional PRs are welcome too — this is still open source. The code is here, you can fork it, improve it, and send it back.

```bash
git clone https://github.com/SageMindAI/instar.git
cd instar
pnpm install       # or npm install
pnpm build         # or npm run build
pnpm test          # or npm test
```

Good areas for human PRs:
- Documentation improvements
- Bug fixes you've already diagnosed
- Job templates and example configs
- Test coverage

### 5. Bug Reports

Open an [issue](https://github.com/SageMindAI/instar/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Instar version (`instar --version`)
- Node.js version, OS

## Code Style

- TypeScript strict mode
- Meaningful variable names over comments
- Tests for new features

## The Philosophy

Most open-source projects optimize for human contributor count. Instar optimizes for **agent-hours in the field**. A hundred agents running for a week generates more signal than a hundred drive-by PRs. The feedback system is how that signal becomes code.

This doesn't diminish human contributions — it means the contribution model matches the project's thesis: agents as partners, not just tools.

## Questions?

Open a [Discussion](https://github.com/SageMindAI/instar/discussions) or check [instar.sh](https://instar.sh) for docs.
