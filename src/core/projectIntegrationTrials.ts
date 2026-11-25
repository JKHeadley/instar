const trials = [
  ['memory-hygiene', {
    setting: 'memoryHygieneProjectIntegrationTrial', historyField: 'memoryHygieneIntegrationTrial',
  }],
  ['session-continuity-check', {
    setting: 'sessionContinuityProjectIntegrationTrial', historyField: 'sessionContinuityIntegrationTrial',
  }],
  ['state-integrity-check', {
    setting: 'stateIntegrityProjectIntegrationTrial', historyField: 'stateIntegrityIntegrationTrial',
  }],
] as const;

export function projectIntegrationTrialFor(slug: string | undefined) {
  return trials.find(([jobSlug]) => jobSlug === slug)?.[1];
}
