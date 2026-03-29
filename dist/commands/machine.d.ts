/**
 * Multi-machine CLI commands.
 *
 * Commands:
 *   instar machines          — List paired machines and their roles
 *   instar machines remove   — Revoke a machine
 *   instar whoami            — Show this machine's identity and role
 *   instar pair              — Generate a pairing code for a new machine
 *   instar join              — Join an existing mesh (clone, pair, setup)
 *   instar wakeup            — Move agent to this machine (transfer awake role)
 *   instar leave             — Self-remove from the mesh
 *   instar doctor            — Diagnose multi-machine health
 *
 * Part of Phase 1-6 of the multi-machine spec.
 */
interface MachinesOptions {
    dir?: string;
}
export declare function listMachines(options: MachinesOptions): Promise<void>;
interface RemoveMachineOptions {
    dir?: string;
}
export declare function removeMachine(nameOrId: string, options: RemoveMachineOptions): Promise<void>;
interface WhoamiOptions {
    dir?: string;
}
export declare function whoami(options: WhoamiOptions): Promise<void>;
interface PairOptions {
    dir?: string;
    qr?: boolean;
}
export declare function startPairing(options: PairOptions): Promise<void>;
interface JoinOptions {
    dir?: string;
    code?: string;
    name?: string;
}
export declare function joinMesh(repoUrl: string, options: JoinOptions): Promise<void>;
interface LeaveOptions {
    dir?: string;
}
export declare function leaveMesh(options: LeaveOptions): Promise<void>;
interface WakeupOptions {
    dir?: string;
    force?: boolean;
}
export declare function wakeup(options: WakeupOptions): Promise<void>;
interface DoctorOptions {
    dir?: string;
}
export declare function doctor(options: DoctorOptions): Promise<void>;
export {};
//# sourceMappingURL=machine.d.ts.map