# Job Handoff Notes

Pass context between job runs. At the end of a job session, write notes for the next run to `.instar/state/job-handoff-{slug}.md`. The next run's session-start hook will inject these notes automatically.

## Writing Handoff Notes

```bash
echo "your notes" > .instar/state/job-handoff-YOUR-SLUG.md
```

## Claims Warning

**CRITICAL**: Handoff notes from previous runs are CLAIMS, not facts. Any assertion about external state (file status, API availability, deployment state) MUST be verified with actual commands before including in your own output. The previous session may have been wrong, or the state may have changed since.

## When to Use

Any job that needs continuity — tracking what was processed, what to check next, what state was observed.
