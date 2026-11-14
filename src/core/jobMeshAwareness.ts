/** Shared agent guidance: fresh installs and existing-agent migrations use the same text. */
export interface JobMeshGuide {
  capability: string;
  registry: string;
  proactive: string;
  building: string;
}

export function jobCoverageGuide(port: number): JobMeshGuide {
  return {
    capability: `- **Lease job coverage and catch-up**: inspect \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/jobs?scope=pool"\` and its \`pool.coverage\` evidence after takeover. Repeated gate or machine-scope skips and overdue enabled jobs raise durable attention; a successful run clears the silence episode. Signed metadata snapshots retain offline peers; stale, missing, pinned and unknown jobs are gaps, not proof that no job exists. \`GET /jobs/coverage-snapshot?nonce=<64 hex characters>\` is the authenticated signed peer snapshot, not permission to execute. Promotion catch-up defaults to \`ask\`; per-job \`catchUpPolicy\` may be \`skip\`, \`run-once\` or \`ask\`, and a cross-machine run-once without a shared witness still asks. Never replay all missed work or enable git-sync to repair coverage.\n`,
    registry: '| Which scheduled jobs are missing after a machine takes over? | **Lease job coverage registry:** `GET /jobs?scope=pool` → `pool.coverage`; retain source and age, and report unknown evidence |\n',
    proactive: '- User reports **jobs stopped after a machine change or restore** → inspect lease job coverage, explain each missing/pinned/dependency/unknown gap, and review catch-up per job before triggering overdue work.\n',
    building: '9. **Need a job to survive machine takeover?** Declare its `requiredPaths` dependencies and any true `machines` restriction; choose a deliberate `catchUpPolicy` instead of replaying missed work.\n',
  };
}

export function jobTransferGuide(port: number): JobMeshGuide {
  return {
    capability: `- **Private job transfer approvals**: this capability ships off behind \`multiMachine.jobDefinitionSync.enabled\`; \`multiMachine.jobDefinitionSync.dryRun\` defaults to preview-only. With it enabled, inspect \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/jobs/portable/export/SLUG\` and \`GET /jobs/portable/import/SOURCE/SLUG\` for the exact root and file/hash list. Source \`POST /jobs/portable/export/SLUG/approve\` and destination \`POST /jobs/portable/import/SOURCE/SLUG/approve\` require the operator's local PIN and that exact root; never collect a PIN in chat or approve on the operator's behalf. Peer signatures and a bearer alone cannot activate a copy. Changed roots need fresh approval at both ends. \`POST /jobs/portable/import/SLUG/revoke\`, \`/jobs/portable/rollback\` and \`/jobs/portable/rearm\` are PIN-gated safety actions. A staged, preview-only, conflicted or disarmed copy is not a runnable job. Never use git-sync or copy config/secret files to bypass this path.\n`,
    registry: '| Which transferred job is waiting for local approval? | **Private job transfer registry:** `GET /jobs/portable/import/SOURCE/SLUG` previews a staged root; use `GET /jobs?scope=pool` → `pool.coverage` for gaps, and do not infer job absence from a missing preview |\n',
    proactive: '- User wants to **copy jobs between machines** → check capability availability and coverage, preview the declared files, and hold for each machine operator to approve the exact root. Keep git-sync off and report quarantined or conflicting copies honestly.\n',
    building: '10. **Need an approved private job copy?** Mark the user job `portable: true`, declare `requiredPaths` explicitly (including `[]` for a reviewed self-contained job), and use the private transfer preview/approval workflow. Keep true machine restrictions intact; never guess dependencies.\n',
  };
}

/** Add only missing guidance; custom text is kept and repeated updates are inert. */
export function applyJobMeshGuide(content: string, guide: JobMeshGuide): string {
  const pieces: Array<[string, string]> = [
    ['/jobs/SLUG/trigger', guide.capability],
    ['| What jobs do I have? |', guide.registry],
    ['**Context-triggered actions:**', guide.proactive],
    ['8. **Need external API access?**', guide.building],
  ];
  for (const [anchor, text] of pieces) {
    const tableRow = text.startsWith('|');
    const marker = tableRow ? text.split('|')[1].trim() : (text.match(/\*\*[^*]+\*\*/)?.[0] ?? text.trim());
    if (content.includes(marker)) continue;
    const at = content.indexOf(anchor);
    const end = at < 0 ? -1 : content.indexOf('\n', at);
    const fallback = tableRow ? `\n| Question | Read first |\n|---|---|\n${text}` : text;
    content = end < 0 ? `${content}\n${fallback}` : `${content.slice(0, end + 1)}${text}${content.slice(end + 1)}`;
  }
  return content;
}
