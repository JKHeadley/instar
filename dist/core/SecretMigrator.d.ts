/**
 * Config Secret Migrator — extracts secrets from config.json into SecretStore.
 *
 * When transitioning to multi-machine, secrets must leave the git-tracked
 * config.json and move into the encrypted SecretStore. The migrator:
 *
 * 1. Scans config.json for fields annotated with { "secret": true }
 * 2. Extracts their actual values into the SecretStore
 * 3. Replaces those fields with { "secret": true } placeholders
 * 4. On loadConfig, merges config.json + SecretStore transparently
 *
 * This runs during `instar pair` (initial multi-machine setup) and can be
 * re-run safely (idempotent — already-migrated fields are skipped).
 *
 * Part of Phase 4 (secret sync via tunnel).
 */
export interface MigrationResult {
    /** Number of secret fields extracted. */
    extracted: number;
    /** Paths of extracted fields (e.g., ['messaging.0.config.token']). */
    fields: string[];
    /** Whether config.json was modified. */
    configModified: boolean;
}
/**
 * Extract secrets from config.json into the encrypted SecretStore.
 *
 * Idempotent: fields already replaced with { "secret": true } are skipped.
 * Fields that are undefined or null are skipped.
 */
export declare function migrateSecrets(configPath: string, stateDir: string): MigrationResult;
/**
 * Merge config.json + SecretStore, replacing { "secret": true } placeholders
 * with actual values from the encrypted store.
 *
 * This is called by loadConfig() to transparently merge the two sources.
 */
export declare function mergeConfigWithSecrets(config: Record<string, unknown>, stateDir: string): Record<string, unknown>;
//# sourceMappingURL=SecretMigrator.d.ts.map