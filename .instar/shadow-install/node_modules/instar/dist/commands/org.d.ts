/**
 * `instar intent org-init` — Create ORG-INTENT.md for organizational intent.
 *
 * Generates a template ORG-INTENT.md in the project's .instar/ directory
 * following the three-rule contract:
 *   1. Constraints (mandatory — agents cannot override)
 *   2. Goals (defaults — agents can specialize)
 *   3. Agent identity fills the rest
 */
interface OrgInitOptions {
    dir?: string;
    name?: string;
}
export declare function orgInit(options: OrgInitOptions): Promise<void>;
export {};
//# sourceMappingURL=org.d.ts.map