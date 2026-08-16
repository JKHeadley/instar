---
name: crossreview
description: Cross-model spec review. Sends a document to GPT, Gemini, and Grok for independent analysis via external API calls, then synthesizes their perspectives. Reveals blind spots that Claude-only reviews miss.
user_invocable: true
---

# CrossReview -- Cross-Model Specification Review

> *"Three models. One spec. Perspectives Claude alone can't see."*

Send a spec or document to GPT 5.2, Gemini 3 Pro, and Grok 4.2 for independent review. Each model analyzes from its own training data and reasoning patterns, then a synthesis highlights where they agree, diverge, and what each uniquely catches.

## Usage

```
/crossreview <doc-path> [--focus "section name"] [--models gpt,gemini,grok]
```

**Arguments**:
- `<doc-path>` -- Path to the document to review (required)
- `--focus` -- Review only a specific section (optional)
- `--models` -- Comma-separated list of models to use (default: all three)

**Examples**:
```
/crossreview docs/specs/MOLTBRIDGE_SPEC.md
/crossreview docs/specs/MOLTBRIDGE_SPEC.md --focus "Phase 1"
/crossreview docs/specs/MOLTBRIDGE_SPEC.md --models gpt,gemini
```

---

## Step 1: Parse Arguments

```
Args: [raw args string]
- Doc path: [parsed]
- Focus: [parsed or "full document"]
- Models: [parsed or "gpt,gemini,grok"]
```

Read the document:

```bash
cat [DOC_PATH]
```

If `--focus` is specified, extract only the relevant section.

---

## Step 2: Prepare Review Context

Create a timestamped output directory:

```bash
REVIEW_ID=$(date +%Y%m%d-%H%M%S)
mkdir -p .claude/skills/crossreview/output/$REVIEW_ID
```

Read the review prompt template:

```bash
cat .claude/skills/crossreview/templates/review-prompt.md
```

Build the full prompt by replacing placeholders in the template:
- `{DOC_CONTENT}` -> the document text (or focused section)
- `{DOC_NAME}` -> the filename
- `{FOCUS}` -> the focus section name or "full document"

Write the assembled prompt to a temp file for each model:

```bash
# Write the prompt (subagents will do this themselves)
```

---

## Step 3: Launch Parallel Model Reviews

For each selected model, spawn a subagent that:
1. Reads the document
2. Reads the review prompt template
3. Assembles the full prompt
4. Writes the prompt to a temp file
5. Calls `call-llm.cjs` to get the model's response
6. Writes the response + analysis to the output file

**CRITICAL: Each subagent MUST write its own output file directly.** Do NOT rely on extracting results from subagent return values. Context blowouts cause TOTAL LOSS of all work.

For each model in the selected list, use the Task tool:

```
Task(
  subagent_type: "general-purpose",
  run_in_background: true,
  description: "CrossReview {MODEL} analysis",
  prompt: "
## CRITICAL: SAVE YOUR OUTPUT

You MUST write your final report to this EXACT file path using the Write tool:
`{ABSOLUTE_PATH}/.claude/skills/crossreview/output/{REVIEW_ID}/{MODEL}.md`

Do NOT just return the report as text. WRITE IT TO THE FILE FIRST.
This is non-negotiable -- if you don't write the file, your work is LOST.

## Your Task

You are sending a document to {MODEL_DISPLAY_NAME} for independent review.

### Step 1: Read the document
Read the file at: {DOC_PATH}
{If --focus specified: Extract only the section about '{FOCUS}'}

### Step 2: Read the review prompt template
Read: {ABSOLUTE_PATH}/.claude/skills/crossreview/templates/review-prompt.md

### Step 3: Assemble the prompt
Replace the placeholders in the template:
- {DOC_CONTENT} -> the document content you just read
- {DOC_NAME} -> the filename
- {FOCUS} -> '{FOCUS}' or 'full document'

Write the assembled prompt to: /tmp/crossreview-{MODEL}-{REVIEW_ID}-prompt.txt

### Step 4: Call the external model
Run this command via Bash:
```bash
node {ABSOLUTE_PATH}/.claude/skills/crossreview/call-llm.cjs --model {MODEL} --prompt-file /tmp/crossreview-{MODEL}-{REVIEW_ID}-prompt.txt --max-tokens 4000
```

Capture the stdout output -- this is {MODEL_DISPLAY_NAME}'s review.

If the command fails (non-zero exit), write the error to the output file with a clear header.

### Step 5: Write the output file
Write to: `{ABSOLUTE_PATH}/.claude/skills/crossreview/output/{REVIEW_ID}/{MODEL}.md`

Format:
```markdown
# {MODEL_DISPLAY_NAME} Review: {DOC_NAME}

**Model**: {MODEL_ID}
**Date**: {TIMESTAMP}
**Focus**: {FOCUS}

---

## Raw Model Response

[paste the full response from the model here]

---

## Subagent Analysis

Brief notes on the quality and specificity of the model's response:
- Was the review substantive?
- Any notable gaps in the model's analysis?
- Unique insights this model provided?
```
"
)
```

**Model display names and IDs:**

| Key | Display Name | Model ID |
|-----|-------------|----------|
| `gpt` | GPT 5.4 | `gpt-5.4` |
| `gemini` | Gemini 3.1 Pro | `gemini-3.1-pro-preview` |
| `grok` | Grok 4.1 Fast | `grok-4-1-fast` |

---

## Step 4: Wait for All Models

Poll background tasks until all model reviews are complete.

Use `Read` tool to check if each output file exists:
- `.claude/skills/crossreview/output/{REVIEW_ID}/gpt.md`
- `.claude/skills/crossreview/output/{REVIEW_ID}/gemini.md`
- `.claude/skills/crossreview/output/{REVIEW_ID}/grok.md`

---

## Step 5: Synthesis

Launch a synthesis subagent that reads all model outputs and produces a combined analysis. The synthesis subagent should also write its own output file directly.

```
Task(
  subagent_type: "general-purpose",
  description: "CrossReview synthesis",
  prompt: "
## CRITICAL: SAVE YOUR OUTPUT

You MUST write your final synthesis to this EXACT file path using the Write tool:
`{ABSOLUTE_PATH}/.claude/skills/crossreview/output/{REVIEW_ID}/synthesis.md`

Do NOT just return the synthesis as text. WRITE IT TO THE FILE FIRST.

## Your Task

Read the cross-model review template:
`{ABSOLUTE_PATH}/.claude/skills/crossreview/templates/synthesis.md`

Read all model review outputs from:
`{ABSOLUTE_PATH}/.claude/skills/crossreview/output/{REVIEW_ID}/`

Files to read (only those that exist):
- gpt.md
- gemini.md
- grok.md

Then produce a synthesis following the template. Key things to identify:

1. **Consensus**: Issues all models flagged independently (strongest signal)
2. **Unique Findings**: Things only one model caught (potential blind spots)
3. **Divergence**: Where models disagree (needs human judgment)
4. **Model Strengths**: What each model was best/worst at reviewing
5. **Actionable Recommendations**: Prioritized list combining all perspectives

Write the complete synthesis to the output path above.
"
)
```

---

## Step 6: Present Results

Read the synthesis file and present key findings to the user:

1. Overall verdict
2. Consensus findings (all 3 models agree)
3. Unique catches (per model)
4. Key divergences
5. Prioritized recommendations

Point the user to the full output directory:
```
Output: .claude/skills/crossreview/output/{REVIEW_ID}/
  - gpt.md       (GPT 5.3 review)
  - gemini.md    (Gemini 3 Pro review)
  - grok.md      (Grok 4.2 review)
  - synthesis.md (Combined analysis)
```

---

*Generated by CrossReview cross-model analysis.*
