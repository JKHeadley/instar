/**
 * Closed structural registry for canonical accepted-intake pipelines.
 *
 * This registry is intentionally metadata-only. Runtime constructors export
 * their own `CanonicalPipelineStageMetadata`; the canonical pipeline manifest
 * cites those symbols and the completeness lint verifies the citation graph.
 */

export type CanonicalPipelineId = 'feedback-factory';

export interface CanonicalPipelineStageMetadata<
  Pipeline extends CanonicalPipelineId = CanonicalPipelineId,
  Stage extends string = string,
> {
  readonly canonicalPipelineId: Pipeline;
  readonly stage: Stage;
}

export interface CanonicalIntakeSurface {
  readonly id: string;
  readonly kind: 'route' | 'job';
  readonly sourcePath: string;
  readonly method?: 'POST' | 'PUT' | 'PATCH';
  readonly route?: string;
  readonly jobSlug?: string;
  readonly canonicalPipelineId: CanonicalPipelineId;
}

export interface ReviewedNonCanonicalIntakeSurface {
  readonly id: string;
  readonly kind: 'route' | 'job';
  readonly sourcePath: string;
  readonly method?: 'POST' | 'PUT' | 'PATCH';
  readonly route?: string;
  readonly jobSlug?: string;
  readonly nonCanonicalReason: string;
  readonly owner: string;
  readonly expiresAt: string;
}

export type IntakeSurfaceDeclaration =
  | CanonicalIntakeSurface
  | ReviewedNonCanonicalIntakeSurface;

/**
 * The operated feedback receiver is external to this repository. The first
 * repository-owned accepted-intake boundary is the inbox drainer job; the
 * processing trigger advances that accepted intake and is enrolled as well.
 */
export const CANONICAL_INTAKE_SURFACES = [
  {
    id: 'feedback-factory-process-route',
    kind: 'route',
    sourcePath: 'src/server/routes.ts',
    method: 'POST',
    route: '/feedback-factory/process',
    canonicalPipelineId: 'feedback-factory',
  },
  {
    id: 'feedback-factory-process-job',
    kind: 'job',
    sourcePath: 'src/scaffold/templates/jobs/instar/feedback-factory-process.md',
    jobSlug: 'Feedback-Factory Operating Drain',
    canonicalPipelineId: 'feedback-factory',
  },
  {
    id: 'feedback-factory-drain-route',
    kind: 'route',
    sourcePath: 'src/server/routes.ts',
    method: 'POST',
    route: '/feedback-factory/drain/tick',
    canonicalPipelineId: 'feedback-factory',
  },
] as const satisfies readonly IntakeSurfaceDeclaration[];

export const CANONICAL_PIPELINE_IDS = [
  'feedback-factory',
] as const satisfies readonly CanonicalPipelineId[];

// Existing feedback-factory ingress stages predate the per-constructor metadata
// convention. These typed declarations enroll them without changing runtime
// behavior; all new downstream constructors export their own stage metadata.
export const FEEDBACK_FACTORY_RECEIVE_STAGE = {
  canonicalPipelineId: 'feedback-factory',
  stage: 'receive',
} as const satisfies CanonicalPipelineStageMetadata;

export const FEEDBACK_FACTORY_PERSIST_STAGE = {
  canonicalPipelineId: 'feedback-factory',
  stage: 'persist',
} as const satisfies CanonicalPipelineStageMetadata;

export const FEEDBACK_FACTORY_CLUSTER_STAGE = {
  canonicalPipelineId: 'feedback-factory',
  stage: 'cluster',
} as const satisfies CanonicalPipelineStageMetadata;
