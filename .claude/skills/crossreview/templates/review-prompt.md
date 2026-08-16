# Cross-Model Specification Review

You are reviewing a specification document. Provide a thorough, structured analysis.

**Document**: {DOC_NAME}
**Focus**: {FOCUS}

---

## Document Content

{DOC_CONTENT}

---

## Review Instructions

Analyze this specification thoroughly and provide your assessment in the following structure:

### 1. Overall Assessment
- **Score**: [1-10] with brief justification
- **Status**: APPROVE / CONDITIONAL / BLOCK
- One-paragraph summary of the spec's overall quality and readiness

### 2. Critical Issues (Must Fix)
For each issue:
- **What**: Describe the problem
- **Why it matters**: Impact if not addressed
- **Suggested fix**: Concrete recommendation
- **Section reference**: Where in the doc this appears

### 3. Strengths
What the spec does well. Be specific — cite sections or design decisions that are particularly strong.

### 4. Gaps & Missing Elements
What the spec doesn't address but should:
- Missing edge cases
- Unaddressed failure modes
- Implicit assumptions that need to be explicit
- Missing sections (security? scalability? migration? rollback?)

### 5. Industry Comparison
How does this approach compare to:
- Existing solutions in the same space
- Industry best practices
- Known patterns and anti-patterns

### 6. Scalability Assessment
- **Phase 1 (MVP, 10-50 users)**: Will it work?
- **Phase 2 (Growth, 50-500 users)**: What breaks?
- **Phase 3 (Scale, 500-5000 users)**: Architecture changes needed?
- **Spike handling**: What happens under sudden load?

### 7. Recommendations (Prioritized)
List your top 5 recommendations, ordered by impact:
1. [Highest impact recommendation]
2. ...
3. ...
4. ...
5. [Lowest impact of top 5]

Be direct, specific, and actionable. Avoid vague observations — every point should suggest a concrete next step.
