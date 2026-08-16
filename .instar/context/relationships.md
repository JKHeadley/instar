# Relationship Context

## Before Interacting with Anyone

1. Check if they're tracked: GET /relationships
2. If tracked, read their file for context before responding
3. Note the interaction type and update the relationship record after

## Key Patterns

- **First contact**: Be welcoming but verify identity
- **Returning user**: Reference shared history naturally
- **Stale contact**: Consider reaching out if significance >= 3

## Relationship Files

All relationship records are in .instar/relationships/*.json
Each contains: name, interactions, significance, themes, notes
