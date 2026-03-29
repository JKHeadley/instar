/**
 * `instar playbook` — Context engineering for autonomous AI agents.
 *
 * Wraps the Playbook Python scripts via execFileSync. All Python invocations
 * use array arguments (never shell interpolation) for injection safety.
 *
 * Commands:
 *   instar playbook init                       Initialize playbook for this project
 *   instar playbook doctor                     Validate Python, venv, config integrity
 *   instar playbook status                     Show manifest health and item counts
 *   instar playbook list [--tag TAG]           List manifest items
 *   instar playbook read ITEM_ID               Display a single manifest item
 *   instar playbook add --content "..."        Add a new context item
 *   instar playbook search QUERY               Search items by content/tags
 *   instar playbook assemble [--tags "..."]    Assemble context for a session
 *   instar playbook evaluate SESSION_LOG       Evaluate session context usage
 *   instar playbook lifecycle [--dry-run]      Run full lifecycle pass
 *   instar playbook validate                   Validate manifest schema + integrity
 *   instar playbook mount PATH --name NAME     Mount external manifest overlay
 *   instar playbook unmount NAME               Remove a mount
 *   instar playbook export [--format json|md]  Export manifest
 *   instar playbook import FILE                Import items (validated)
 *   instar playbook eject [script|--all]       Copy scripts for customization
 *   instar playbook user-export USER_ID        DSAR: export user data
 *   instar playbook user-delete USER_ID        DSAR: delete user data
 *   instar playbook user-audit USER_ID         DSAR: audit trail for user
 */
interface PlaybookOptions {
    dir?: string;
    json?: boolean;
    debug?: boolean;
    verbose?: boolean;
    quiet?: boolean;
}
interface PlaybookListOptions extends PlaybookOptions {
    tag?: string;
    type?: string;
}
interface PlaybookAddOptions extends PlaybookOptions {
    content?: string;
    contentFile?: string;
    tags?: string;
    type?: string;
    category?: string;
}
interface PlaybookSearchOptions extends PlaybookOptions {
    limit?: number;
}
interface PlaybookAssembleOptions extends PlaybookOptions {
    tags?: string;
    budget?: number;
    triggers?: string;
}
interface PlaybookLifecycleOptions extends PlaybookOptions {
    dryRun?: boolean;
}
interface PlaybookExportOptions extends PlaybookOptions {
    format?: string;
}
interface PlaybookMountOptions extends PlaybookOptions {
    name: string;
}
interface PlaybookEjectOptions extends PlaybookOptions {
    all?: boolean;
}
interface PlaybookUserOptions extends PlaybookOptions {
    confirm?: boolean;
}
export declare function playbookInit(opts: PlaybookOptions): Promise<void>;
export declare function playbookDoctor(opts: PlaybookOptions): Promise<void>;
export declare function playbookStatus(opts: PlaybookOptions): Promise<void>;
export declare function playbookList(opts: PlaybookListOptions): Promise<void>;
export declare function playbookRead(itemId: string, opts: PlaybookOptions): Promise<void>;
export declare function playbookAdd(opts: PlaybookAddOptions): Promise<void>;
export declare function playbookSearch(query: string, opts: PlaybookSearchOptions): Promise<void>;
export declare function playbookAssemble(opts: PlaybookAssembleOptions): Promise<void>;
export declare function playbookEvaluate(sessionLog: string, opts: PlaybookOptions & {
    demo?: boolean;
}): Promise<void>;
export declare function playbookLifecycle(opts: PlaybookLifecycleOptions): Promise<void>;
export declare function playbookValidate(opts: PlaybookOptions): Promise<void>;
export declare function playbookMount(mountPath: string, opts: PlaybookMountOptions): Promise<void>;
export declare function playbookUnmount(name: string, opts: PlaybookOptions): Promise<void>;
export declare function playbookExport(opts: PlaybookExportOptions): Promise<void>;
export declare function playbookImport(filePath: string, opts: PlaybookOptions): Promise<void>;
export declare function playbookEject(scriptName: string | undefined, opts: PlaybookEjectOptions): Promise<void>;
export declare function playbookUserExport(userId: string, opts: PlaybookOptions): Promise<void>;
export declare function playbookUserDelete(userId: string, opts: PlaybookUserOptions): Promise<void>;
export declare function playbookUserAudit(userId: string, opts: PlaybookOptions): Promise<void>;
export {};
//# sourceMappingURL=playbook.d.ts.map