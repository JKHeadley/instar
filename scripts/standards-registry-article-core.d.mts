export interface RegistryArticleBlock {
  name: string;
  startLine: number;
  endLine: number;
  raw: string;
  visibleLines: Array<string | null>;
}

export interface RegistrySectionBlock {
  heading: string;
  blocks: RegistryArticleBlock[];
}

export const ARTICLE_ID_RE: RegExp;
export function parseRegistryStructure(markdown: string): RegistrySectionBlock[];
export function articleIds(block: RegistryArticleBlock): string[];
