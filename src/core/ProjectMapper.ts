/**
 * Project Mapper — Auto-generates a territory map of the project structure.
 *
 * Scans the project directory and produces a human-readable map that
 * agents can reference to understand their spatial context: what files
 * exist, what they do, and how they relate.
 *
 * Born from the Luna incident (2026-02-25): An agent modified the wrong
 * project because it had no spatial awareness of its working environment.
 * A project map would have shown "you are HERE, working on THIS project."
 *
 * Inspired by Dawn's Guardian Territory Map (95 domains, 9,147 files).
 * Simplified for general-purpose agents: focused, practical, auto-generated.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeGitExecutor } from './SafeGitExecutor.js';
import { DEFAULT_SKIP_DIRS } from './skipDirs.js';

export interface ProjectMapConfig {
  /** Project root directory */
  projectDir: string;
  /** Instar state directory */
  stateDir: string;
  /** Max depth for directory traversal (default: 4) */
  maxDepth?: number;
  /** Directories to skip (default: node_modules, .git, dist, etc.) */
  skipDirs?: string[];
  /** Max files to enumerate per directory (default: 50) */
  maxFilesPerDir?: number;
  /** Additional roots containing related git worktrees to summarize */
  relatedWorktreeRoots?: string[];
}

export interface ProjectMapEntry {
  /** Relative path from project root */
  path: string;
  /** 'file' or 'directory' */
  type: 'file' | 'directory';
  /** File count (for directories) */
  fileCount?: number;
  /** File extension */
  extension?: string;
}

export interface ProjectMap {
  /** Project name (from package.json, CLAUDE.md, or directory name) */
  projectName: string;
  /** Absolute path to project root */
  projectDir: string;
  /** Git remote URL (if git repo) */
  gitRemote: string | null;
  /** Current git branch */
  gitBranch: string | null;
  /** Total file count */
  totalFiles: number;
  /** Top-level directory summary */
  directories: Array<{
    name: string;
    description: string;
    fileCount: number;
  }>;
  /** Key files (configs, entry points, etc.) */
  keyFiles: string[];
  /** Detected project type (nextjs, express, library, etc.) */
  projectType: string;
  /** Deployment targets detected */
  deploymentTargets: string[];
  /** Nearby worktrees that are part of the same agent workspace */
  relatedWorktrees?: RelatedWorktreeSummary[];
  /** Generated at timestamp */
  generatedAt: string;
}

export interface RelatedWorktreeSummary {
  /** Worktree directory name */
  name: string;
  /** Absolute path to the worktree */
  path: string;
  /** Current git branch */
  gitBranch: string | null;
  /** Git remote URL */
  gitRemote: string | null;
  /** High-signal top-level directories present in the worktree */
  keyDirectories: string[];
}

// DEFAULT_SKIP_DIRS now lives in ./skipDirs.ts — one shared source of truth for
// repo-structure walkers (ProjectMapper + CartographerTree), so they cannot drift.

const KEY_FILE_PATTERNS = [
  'package.json', 'tsconfig.json',
  // Identity files: AGENT.md is canonical (provider-portability v1.0.0);
  // CLAUDE.md / AGENTS.md / GEMINI.md are framework-specific shadows
  // rendered from AGENT.md but listed here so they show up in the map.
  'AGENT.md', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md',
  'README.md',
  'vercel.json', 'next.config.js', 'next.config.ts', 'next.config.mjs',
  'Dockerfile', 'docker-compose.yml', '.env.example',
  'prisma/schema.prisma', 'Makefile', 'Cargo.toml',
  'pyproject.toml', 'requirements.txt', 'go.mod',
];

export class ProjectMapper {
  private config: ProjectMapConfig;
  private skipDirs: Set<string>;

  constructor(config: ProjectMapConfig) {
    this.config = config;
    this.skipDirs = new Set([
      ...DEFAULT_SKIP_DIRS,
      ...(config.skipDirs || []),
    ]);
  }

  /**
   * Generate a full project map.
   */
  generate(): ProjectMap {
    const projectDir = this.config.projectDir;

    return {
      projectName: this.detectProjectName(),
      projectDir,
      gitRemote: this.detectGitRemote(),
      gitBranch: this.detectGitBranch(),
      totalFiles: this.countFiles(projectDir, 0),
      directories: this.scanTopLevelDirs(),
      keyFiles: this.findKeyFiles(),
      projectType: this.detectProjectType(),
      deploymentTargets: this.detectDeploymentTargets(),
      relatedWorktrees: this.findRelatedWorktrees(),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Generate and save the project map to .instar/project-map.json + .md
   */
  generateAndSave(): ProjectMap {
    const map = this.generate();

    // Save JSON for programmatic access
    const jsonPath = path.join(this.config.stateDir, 'project-map.json');
    fs.writeFileSync(jsonPath, JSON.stringify(map, null, 2));

    // Save readable markdown for hook injection
    const mdPath = path.join(this.config.stateDir, 'project-map.md');
    fs.writeFileSync(mdPath, this.toMarkdown(map));

    return map;
  }

  /**
   * Convert a project map to human-readable markdown for session injection.
   */
  toMarkdown(map: ProjectMap): string {
    const relatedWorktrees = map.relatedWorktrees ?? [];
    const lines: string[] = [
      `# Project Map: ${map.projectName}`,
      '',
      `**Type**: ${map.projectType}`,
      `**Path**: ${map.projectDir}`,
    ];

    if (map.gitRemote) {
      lines.push(`**Git Remote**: ${map.gitRemote}`);
    }
    if (map.gitBranch) {
      lines.push(`**Branch**: ${map.gitBranch}`);
    }
    lines.push(`**Total Files**: ${map.totalFiles}`);

    if (map.deploymentTargets.length > 0) {
      lines.push(`**Deployment Targets**: ${map.deploymentTargets.join(', ')}`);
    }

    if (relatedWorktrees.length > 0) {
      lines.push(`**Related Worktrees**: ${relatedWorktrees.length}`);
    }

    lines.push('');
    lines.push('## Directory Structure');
    lines.push('');

    for (const dir of map.directories) {
      lines.push(`- **${dir.name}/** (${dir.fileCount} files) — ${dir.description}`);
    }

    if (map.keyFiles.length > 0) {
      lines.push('');
      lines.push('## Key Files');
      lines.push('');
      for (const file of map.keyFiles) {
        lines.push(`- ${file}`);
      }
    }

    if (relatedWorktrees.length > 0) {
      lines.push('');
      lines.push('## Related Worktrees');
      lines.push('');
      for (const worktree of relatedWorktrees.slice(0, 12)) {
        const branch = worktree.gitBranch ? ` [${worktree.gitBranch}]` : '';
        const dirs = worktree.keyDirectories.length > 0
          ? ` — ${worktree.keyDirectories.join(', ')}`
          : '';
        lines.push(`- **${worktree.name}/**${branch}${dirs}`);
      }
      if (relatedWorktrees.length > 12) {
        lines.push(`- ... and ${relatedWorktrees.length - 12} more worktrees`);
      }
    }

    lines.push('');
    lines.push(`*Generated: ${map.generatedAt}*`);

    return lines.join('\n');
  }

  /**
   * Get a compact summary for session-start injection (max ~20 lines).
   */
  getCompactSummary(map?: ProjectMap): string {
    const m = map || this.loadSavedMap();
    if (!m) return '';
    const relatedWorktrees = m.relatedWorktrees ?? [];

    const lines: string[] = [
      `Project: ${m.projectName} (${m.projectType})`,
      `Path: ${m.projectDir}`,
    ];

    if (m.gitRemote) {
      lines.push(`Git: ${m.gitRemote} [${m.gitBranch || 'unknown'}]`);
    }

    if (m.deploymentTargets.length > 0) {
      lines.push(`Deploy: ${m.deploymentTargets.join(', ')}`);
    }

    lines.push(`Files: ${m.totalFiles} across ${m.directories.length} directories`);

    if (relatedWorktrees.length > 0) {
      lines.push(`Related worktrees: ${relatedWorktrees.length}`);
    }
    lines.push('');

    // Top directories
    const topDirs = m.directories.slice(0, 8);
    for (const dir of topDirs) {
      lines.push(`  ${dir.name}/ (${dir.fileCount}) — ${dir.description}`);
    }
    if (m.directories.length > 8) {
      lines.push(`  ... and ${m.directories.length - 8} more directories`);
    }

    for (const worktree of relatedWorktrees.slice(0, 5)) {
      const branch = worktree.gitBranch ? ` [${worktree.gitBranch}]` : '';
      const dirs = worktree.keyDirectories.length > 0
        ? ` — ${worktree.keyDirectories.join(', ')}`
        : '';
      lines.push(`  worktree: ${worktree.name}${branch}${dirs}`);
    }
    if (relatedWorktrees.length > 5) {
      lines.push(`  ... and ${relatedWorktrees.length - 5} more worktrees`);
    }

    return lines.join('\n');
  }

  /**
   * Load a previously saved project map.
   */
  loadSavedMap(): ProjectMap | null {
    const jsonPath = path.join(this.config.stateDir, 'project-map.json');
    try {
      if (fs.existsSync(jsonPath)) {
        return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      }
    } catch {
      // @silent-fallback-ok — corrupt map, caller regenerates
    }
    return null;
  }

  // ── Detection Methods ──────────────────────────────────────────

  private detectProjectName(): string {
    // Try package.json first
    const pkgPath = path.join(this.config.projectDir, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name) return pkg.name;
      }
    } catch { /* ignore */ }

    // Try AGENT.md first (canonical) then framework-specific shadows for backwards-compat.
    // Provider-portability v1.0.0 made AGENT.md the source of truth; CLAUDE.md and
    // AGENTS.md are rendered shadows. Legacy installs with only CLAUDE.md still work.
    for (const name of ['.instar/AGENT.md', 'AGENT.md', 'CLAUDE.md', 'AGENTS.md']) {
      const filePath = path.join(this.config.projectDir, name);
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          const match = content.match(/^#\s+(.+)/m);
          if (match) return match[1].trim();
        }
      } catch {
        // @silent-fallback-ok — CLAUDE.md parse fallback
      }
    }

    return path.basename(this.config.projectDir);
  }

  private detectGitRemote(): string | null {
    try {
      const result = SafeGitExecutor.readSync(['remote', 'get-url', 'origin'], { cwd: this.config.projectDir,
        encoding: 'utf-8',
        stdio: 'pipe', operation: 'src/core/ProjectMapper.ts:262' });
      return result.trim() || null;
    } catch {
      // @silent-fallback-ok — git remote detection
      return null;
    }
  }

  private detectGitBranch(): string | null {
    try {
      const result = SafeGitExecutor.readSync(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.config.projectDir,
        encoding: 'utf-8',
        stdio: 'pipe', operation: 'src/core/ProjectMapper.ts:277' });
      return result.trim() || null;
    } catch {
      // @silent-fallback-ok — git branch detection
      return null;
    }
  }

  private detectProjectType(): string {
    const projectDir = this.config.projectDir;
    const has = (f: string) => fs.existsSync(path.join(projectDir, f));

    if (has('next.config.js') || has('next.config.ts') || has('next.config.mjs')) return 'nextjs';
    if (has('nuxt.config.ts') || has('nuxt.config.js')) return 'nuxt';
    if (has('svelte.config.js')) return 'sveltekit';
    if (has('astro.config.mjs')) return 'astro';
    if (has('angular.json')) return 'angular';
    if (has('Cargo.toml')) return 'rust';
    if (has('go.mod')) return 'go';
    if (has('pyproject.toml') || has('setup.py')) return 'python';
    if (has('Gemfile')) return 'ruby';

    // Check package.json for more hints
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
      if (pkg.dependencies?.express || pkg.dependencies?.fastify) return 'node-server';
      if (pkg.dependencies?.react) return 'react';
      if (pkg.dependencies?.vue) return 'vue';
      if (pkg.main || pkg.exports) return 'node-library';
    } catch { /* ignore */ }

    if (has('index.html')) return 'static-site';
    return 'unknown';
  }

  private detectDeploymentTargets(): string[] {
    const targets: string[] = [];
    const projectDir = this.config.projectDir;
    const has = (f: string) => fs.existsSync(path.join(projectDir, f));

    if (has('vercel.json') || has('.vercel')) targets.push('vercel');
    if (has('netlify.toml')) targets.push('netlify');
    if (has('Dockerfile') || has('docker-compose.yml')) targets.push('docker');
    if (has('.github/workflows')) targets.push('github-actions');
    if (has('fly.toml')) targets.push('fly.io');
    if (has('render.yaml')) targets.push('render');
    if (has('railway.json')) targets.push('railway');
    if (has('Procfile')) targets.push('heroku');

    // Check package.json scripts for deploy commands
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
      if (pkg.scripts?.deploy) {
        const deploy = pkg.scripts.deploy;
        if (deploy.includes('vercel') && !targets.includes('vercel')) targets.push('vercel');
        if (deploy.includes('netlify') && !targets.includes('netlify')) targets.push('netlify');
        if (deploy.includes('firebase')) targets.push('firebase');
      }
    } catch { /* ignore */ }

    return targets;
  }

  private scanTopLevelDirs(): ProjectMap['directories'] {
    const dirs: ProjectMap['directories'] = [];

    try {
      const entries = fs.readdirSync(this.config.projectDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (this.skipDirs.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;

        const dirPath = path.join(this.config.projectDir, entry.name);
        const fileCount = this.countFiles(dirPath, 0);

        dirs.push({
          name: entry.name,
          description: this.describeDirectory(entry.name),
          fileCount,
        });
      }
    } catch { /* ignore */ }

    return dirs.sort((a, b) => b.fileCount - a.fileCount);
  }

  private describeDirectory(name: string): string {
    const descriptions: Record<string, string> = {
      src: 'Source code',
      lib: 'Library/utility code',
      pages: 'Page routes (Next.js/Nuxt)',
      app: 'Application routes (Next.js App Router)',
      components: 'UI components',
      hooks: 'React hooks',
      styles: 'Stylesheets',
      public: 'Static assets',
      assets: 'Static assets',
      api: 'API routes',
      config: 'Configuration files',
      utils: 'Utility functions',
      helpers: 'Helper functions',
      types: 'Type definitions',
      tests: 'Test files',
      __tests__: 'Test files',
      cypress: 'E2E tests',
      scripts: 'Build/utility scripts',
      docs: 'Documentation',
      prisma: 'Database schema & migrations',
      migrations: 'Database migrations',
      templates: 'Template files',
      locales: 'Internationalization files',
      i18n: 'Internationalization',
    };

    return descriptions[name] || 'Project directory';
  }

  private findKeyFiles(): string[] {
    const found: string[] = [];

    for (const pattern of KEY_FILE_PATTERNS) {
      const filePath = path.join(this.config.projectDir, pattern);
      if (fs.existsSync(filePath)) {
        found.push(pattern);
      }
    }

    return found;
  }

  private findRelatedWorktrees(): RelatedWorktreeSummary[] {
    const roots = this.findRelatedWorktreeRoots();
    const byPath = new Map<string, RelatedWorktreeSummary>();

    for (const root of roots) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const worktreePath = path.join(root, entry.name);
        if (!this.isGitWorktree(worktreePath)) continue;
        const realPath = this.realpathOrNull(worktreePath);
        if (!realPath || byPath.has(realPath)) continue;

        byPath.set(realPath, {
          name: entry.name,
          path: realPath,
          gitBranch: this.detectGitBranchFor(realPath),
          gitRemote: this.detectGitRemoteFor(realPath),
          keyDirectories: this.findKeyDirectories(realPath),
        });
      }
    }

    return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private findRelatedWorktreeRoots(): string[] {
    const roots = new Set<string>();

    for (const configured of this.config.relatedWorktreeRoots ?? []) {
      if (!configured.trim()) continue;
      roots.add(path.resolve(configured));
    }

    const projectBasename = path.basename(this.config.projectDir);
    roots.add(path.join(os.homedir(), '.instar', 'agents', projectBasename, '.worktrees'));

    return [...roots]
      .map((root) => this.realpathOrNull(root))
      .filter((root): root is string => Boolean(root));
  }

  private isGitWorktree(dir: string): boolean {
    return fs.existsSync(path.join(dir, '.git'));
  }

  private detectGitRemoteFor(dir: string): string | null {
    try {
      const result = SafeGitExecutor.readSync(['remote', 'get-url', 'JKHeadley'], { cwd: dir,
        encoding: 'utf-8',
        stdio: 'pipe', sourceTreeReadOk: true, operation: 'src/core/ProjectMapper.ts:related-remote-jkheadley' });
      return result.trim() || null;
    } catch {
      try {
        const result = SafeGitExecutor.readSync(['remote', 'get-url', 'origin'], { cwd: dir,
          encoding: 'utf-8',
          stdio: 'pipe', sourceTreeReadOk: true, operation: 'src/core/ProjectMapper.ts:related-remote-origin' });
        return result.trim() || null;
      } catch {
        return null;
      }
    }
  }

  private detectGitBranchFor(dir: string): string | null {
    try {
      const result = SafeGitExecutor.readSync(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir,
        encoding: 'utf-8', sourceTreeReadOk: true,
        stdio: 'pipe', operation: 'src/core/ProjectMapper.ts:related-branch' });
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  private findKeyDirectories(dir: string): string[] {
    const priority = ['src', 'tests', 'docs', 'dashboard', 'scripts', 'upgrades', 'skills', 'packages'];
    return priority.filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  private realpathOrNull(target: string): string | null {
    try {
      return fs.realpathSync(target);
    } catch {
      return null;
    }
  }

  private countFiles(dir: string, depth: number): number {
    const maxDepth = this.config.maxDepth ?? 4;
    if (depth > maxDepth) return 0;

    let count = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (this.skipDirs.has(entry.name)) continue;
        if (entry.isDirectory() && entry.name.startsWith('.')) continue;

        if (entry.isFile()) {
          count++;
        } else if (entry.isDirectory()) {
          count += this.countFiles(path.join(dir, entry.name), depth + 1);
        }
      }
    } catch { /* permission error, broken symlink, etc. */ }

    return count;
  }
}
