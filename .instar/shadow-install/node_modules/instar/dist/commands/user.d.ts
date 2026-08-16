/**
 * `instar user add|list` — Manage user profiles.
 */
interface UserAddOptions {
    id: string;
    name: string;
    telegram?: string;
    email?: string;
    slack?: string;
    permissions?: string[];
}
export declare function addUser(options: UserAddOptions): Promise<void>;
export declare function listUsers(_options: {
    dir?: string;
}): Promise<void>;
export {};
//# sourceMappingURL=user.d.ts.map