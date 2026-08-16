---
name: specreview
description: Multi-agent spec review tool. Spawns specialized reviewer agents in parallel to analyze a project specification from 8 angles (security, scalability, business, architecture, privacy, adversarial, DX, marketing), then synthesizes findings and iterates toward consensus. Each reviewer conducts independent research. Uses Claude Code Agent Teams for cross-examination.
user_invocable: true
---

# SpecReview -- Multi-Agent Specification Review

> *"Eight lenses. One spec. Zero blind spots."*

A tool for rigorous, multi-perspective review of project specifications. Spawns specialized AI reviewer agents that independently analyze a spec, then synthesizes their findings and iterates toward consensus. Each reviewer conducts independent research to ground their analysis in real-world context.

## Usage

```
/specreview <spec-path> [--focus "section name"] [--reviewers security,scalability,adversarial] [--rounds 2]
```

**Arguments**:
- `<spec-path>` -- Path to the specification document (required)
- `--focus` -- Review only a specific section/initiative (optional)
- `--reviewers` -- Comma-separated list of specific reviewers to run (default: all 8)
- `--rounds` -- Maximum iteration rounds (default: 2)

---

## Architecture

```
Phase 1: INDEPENDENT REVIEW (parallel subagents)
  - 8 specialized reviewers analyze the spec simultaneously
  - Each conducts independent research relevant to their domain
  - Each produces a structured report with approval status

Phase 2: SYNTHESIS (orchestrator)
  - Collect all reports
  - Identify consensus, conflicts, and gaps
  - Produce consolidated review

Phase 3: CROSS-EXAMINATION (optional, Agent Teams)
  - If conflicts exist, reviewers debate specific points
  - Reviewers can challenge each other's findings
  - Converge on resolution or explicit disagreement

Phase 4: ITERATION (if needed)
  - Spec author addresses critical issues
  - Re-run only affected reviewers
  - Check convergence
```

---

## Step 1: Parse Arguments

```
Args: [raw args string]
- Spec path: [parsed]
- Focus: [parsed or "full document"]
- Reviewers: [parsed or "all"]
- Max rounds: [parsed or 2]
```

Read the spec document:

```bash
cat [SPEC_PATH]
```

If `--focus` is specified, extract only the relevant section.

---

## Step 2: Prepare Review Context

Create a timestamped output directory:

```bash
REVIEW_ID=$(date +%Y%m%d-%H%M%S)
mkdir -p .claude/skills/specreview/output/$REVIEW_ID
```

Prepare the review brief that each reviewer will receive:

```markdown
# Review Brief

**Spec**: [filename]
**Focus**: [section or "full document"]
**Review ID**: [REVIEW_ID]
**Round**: [current round number]

## Spec Content

[The spec text, or focused section]

## Your Task

Review this specification from your specialized perspective.
Produce a structured report using the template below.
Be specific, cite line numbers or sections, and provide actionable feedback.

## Report Template

### Approval Status: [APPROVE / CONDITIONAL / BLOCK]

### Critical Issues (must fix before building)
- [Issue]: [Why it matters] [Suggested fix]

### Recommendations (should fix, not blocking)
- [Recommendation]: [Why] [How]

### Observations (nice to know)
- [Observation]

### Scalability Assessment
- **Phase 1 (MVP)**: [Will it work? What breaks?]
- **Phase 2 (Growth, 10x)**: [What needs to change?]
- **Phase 3 (Scale, 100x)**: [Architecture changes needed?]
- **Viral spike handling**: [What happens if 1000 agents sign up in a day?]

### Score: [1-10] with brief justification
```

---

## Step 3: Launch Parallel Reviews

Spawn all selected reviewers as parallel subagents. Each reviewer gets:
1. The review brief (spec + template)
2. Their specialized reviewer prompt (from `reviewers/` directory)

**Available reviewers:**

| Reviewer | File | Specialization |
|----------|------|---------------|
| Security | `reviewers/security.md` | Attack vectors, auth, data exposure |
| Scalability | `reviewers/scalability.md` | Bottlenecks, growth, viral spikes |
| Business Model | `reviewers/business.md` | Market fit, revenue, competition |
| Architecture | `reviewers/architecture.md` | System design, tech stack, integration |
| Privacy & Ethics | `reviewers/privacy.md` | Data handling, consent, fairness |
| Adversarial | `reviewers/adversarial.md` | Edge cases, gaming, failure modes |
| DX / API | `reviewers/dx.md` | Developer experience, onboarding |
| Marketing | `reviewers/marketing.md` | Naming, positioning, go-to-market |

**For each reviewer**, use the Task tool with `general-purpose` subagent type. Each reviewer has access to WebSearch and WebFetch tools and should conduct independent research to ground their analysis.

**CRITICAL: Each subagent MUST write its own output file directly.** Do NOT rely on extracting results from subagent return values — this risks total loss if the orchestrator hits context limits. The subagent prompt must include explicit instructions to write to the output file path.

```
Task(
  subagent_type: "general-purpose",
  run_in_background: true,  // Run all 8 in background
  prompt: "
## CRITICAL: SAVE YOUR OUTPUT

You MUST write your final report to this EXACT file path using the Write tool:
`[ABSOLUTE_PATH]/.claude/skills/specreview/output/[REVIEW_ID]/[reviewer-name].md`

Do NOT just return the report as text. WRITE IT TO THE FILE FIRST.
This is non-negotiable — if you don't write the file, your work is LOST.

## Your Role

[reviewer prompt from file]

## Independent Research (MANDATORY)

Before writing your review, conduct research relevant to your domain:
- Search for competitors, existing solutions, and market context
- Look up any technologies, protocols, or standards mentioned in the spec
- Verify claims made in the spec against current reality
- Find relevant benchmarks, case studies, or precedents

Include a 'Research Findings' section in your report.

## Review Brief

**Spec file to read**: [ABSOLUTE_PATH_TO_SPEC]
**Focus**: [section or 'full document']
**Review ID**: [REVIEW_ID]
**Round**: [round number]

If Round 2+, also read prior synthesis:
**Prior synthesis**: [ABSOLUTE_PATH]/.claude/skills/specreview/output/[PRIOR_REVIEW_ID]/synthesis.md

### Steps:
1. Read the spec file
2. If Round 2+, read prior synthesis
3. Conduct independent research
4. Write structured review
5. WRITE the report to the output file (Step 0)
  ",
  description: "[Reviewer name] spec review",
  model: "sonnet"  // Use sonnet for speed; opus for critical reviews
)
```

**Launch ALL reviewers in a single message** to maximize parallelism. Use `run_in_background: true` for all.

Output files are written by each subagent to:
```
.claude/skills/specreview/output/[REVIEW_ID]/[reviewer-name].md
```

---

## Step 4: Verify Output Files

Before synthesis, verify that all reviewer subagents wrote their files:

```bash
ls -la .claude/skills/specreview/output/[REVIEW_ID]/
```

**Expected files**: One `.md` per reviewer. If any are missing, check the subagent output for errors. Do NOT proceed to synthesis with missing reviews.

---

## Step 5: Synthesis (via subagent)

**CRITICAL: Synthesis should also be done by a subagent** to protect the orchestrator's context. The synthesis subagent reads all 8 review files and writes the synthesis directly.

```
Task(
  subagent_type: "general-purpose",
  prompt: "
## CRITICAL: SAVE YOUR OUTPUT
Write your synthesis to: `[ABSOLUTE_PATH]/.claude/skills/specreview/output/[REVIEW_ID]/synthesis.md`

## Your Task
Read all 8 reviewer reports from the output directory and synthesize:
1. Identify consensus (findings 3+ reviewers agree on)
2. Flag conflicts (where reviewers disagree)
3. Surface gaps (areas no reviewer covered)
4. Aggregate scores (average, min, max)
5. Determine overall status (READY / NEEDS WORK / BLOCKED)

Read each file:
- [ABSOLUTE_PATH]/.claude/skills/specreview/output/[REVIEW_ID]/security.md
- [ABSOLUTE_PATH]/.claude/skills/specreview/output/[REVIEW_ID]/scalability.md
- [ABSOLUTE_PATH]/.claude/skills/specreview/output/[REVIEW_ID]/business.md
- [ABSOLUTE_PATH]/.claude/skills/specreview/output/[REVIEW_ID]/architecture.md
- [ABSOLUTE_PATH]/.claude/skills/specreview/output/[REVIEW_ID]/privacy.md
- [ABSOLUTE_PATH]/.claude/skills/specreview/output/[REVIEW_ID]/adversarial.md
- [ABSOLUTE_PATH]/.claude/skills/specreview/output/[REVIEW_ID]/dx.md
- [ABSOLUTE_PATH]/.claude/skills/specreview/output/[REVIEW_ID]/marketing.md

Use the synthesis template from templates/synthesis.md.
WRITE the synthesis to the output file.
  "
)
```

The orchestrator then only needs to read the final synthesis file — keeping its own context minimal.

Use the synthesis template from `templates/synthesis.md`.

---

## Step 5: Cross-Examination (If Conflicts Exist)

**Only run this phase if reviewers disagree on material points.**

This is where Agent Teams shine -- reviewers can directly debate:

```
If conflicts found in synthesis:
  1. Identify the specific conflict points
  2. Spawn an Agent Team with the conflicting reviewers
  3. Present each conflict as a debate topic
  4. Let reviewers argue their positions
  5. Record the resolution or explicit disagreement
```

If Agent Teams are not available, fall back to:
- Present Reviewer A's finding to Reviewer B as a subagent
- Ask Reviewer B to respond
- Synthesize the exchange

---

## Step 6: Report

Present the consolidated review to the user:

```markdown
# SpecReview: [Spec Name]

**Review ID**: [ID]
**Date**: [timestamp]
**Reviewers**: [list]
**Overall Status**: [READY / NEEDS WORK / BLOCKED]
**Average Score**: [X/10]

## Consensus (all reviewers agree)
- [Finding 1]
- [Finding 2]

## Critical Issues (any reviewer blocked)
- [Issue]: [Reviewer] -- [Details]

## Conflicts (reviewers disagree)
- [Topic]: [Reviewer A says X, Reviewer B says Y]
  - Resolution: [if cross-examined]

## Recommendations (prioritized)
1. [Highest impact recommendation]
2. [Next highest]
...

## Scalability Summary
| Phase | Assessment | Key Risks |
|-------|-----------|-----------|
| MVP | [consensus view] | [risks] |
| Growth (10x) | [consensus view] | [risks] |
| Scale (100x) | [consensus view] | [risks] |
| Viral spike | [consensus view] | [risks] |

## Next Steps
- [ ] Address critical issues
- [ ] Consider recommendations
- [ ] Re-run review if major changes made (/specreview --round 2)
```

---

## Step 7: Iteration (Optional)

If the user addresses feedback and wants a re-review:

```
/specreview <spec-path> --round 2 --reviewers [only affected reviewers]
```

On subsequent rounds:
1. Load previous round's synthesis
2. Run only the reviewers whose areas were affected by changes
3. Compare new findings to previous findings
4. Check if critical issues are resolved
5. Update convergence status

---

## Configuration

### Model Selection

| Review Complexity | Recommended Model |
|-------------------|-------------------|
| Standard review | `sonnet` (fast, cost-effective) |
| Critical/security review | `opus` (thorough, catches subtle issues) |
| Quick pass | `haiku` (fast screening) |

### Customization

To add a new reviewer:
1. Create `reviewers/[name].md` with the specialized prompt
2. Add to the reviewer table in Step 3
3. The orchestrator will automatically include it

To modify review depth:
- Edit the reviewer prompt to be more/less detailed
- Adjust the report template in Step 2

---

## Philosophy

> *"A single perspective, no matter how expert, has blind spots. Eight perspectives in parallel — each grounded in independent research — surface what none would find alone."*

This tool embodies the principle that **structure beats willpower** for thorough review. Instead of hoping one reviewer catches everything, we guarantee coverage through specialization, independent research, and synthesis.

The cross-examination phase addresses the limitation of independent review -- sometimes the most important insights emerge from the *collision* of different perspectives.

---

## Related

- `.claude/skills/specreview/reviewers/` -- Individual reviewer prompts
- `.claude/skills/specreview/templates/` -- Report and synthesis templates
- `.claude/skills/specreview/output/` -- Review results (gitignored)
- Agent Teams feature: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
