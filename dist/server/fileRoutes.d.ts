/**
 * File viewer API routes for the dashboard.
 *
 * Phase 1: List directories and read files within allowed paths.
 * Phase 2: Inline editing with optimistic concurrency and audit logging.
 *
 * All paths are relative to the project root. Security is defense-in-depth:
 * normalize, reject absolute, reject .., check allowedPaths, symlink resolution,
 * blocked filenames, never-editable enforcement.
 */
import { Router } from 'express';
import type { InstarConfig } from '../core/types.js';
export declare function createFileRoutes(options: {
    config: InstarConfig;
    liveConfig?: {
        set(path: string, value: unknown): void;
    };
}): Router;
//# sourceMappingURL=fileRoutes.d.ts.map