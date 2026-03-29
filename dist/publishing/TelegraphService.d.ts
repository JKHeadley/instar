/**
 * Telegraph publishing service for Instar agents.
 *
 * Converts markdown to Telegraph Node format and publishes
 * content via the Telegraph API (telegra.ph). Zero-config,
 * no rate limits, instant web pages accessible from anywhere.
 *
 * IMPORTANT: All Telegraph pages are PUBLIC. There is no authentication
 * or access control — anyone with the URL can view the content.
 * Do NOT publish sensitive, private, or confidential information.
 * For private content, use the Cloudflare Tunnel viewer (when configured).
 *
 * Telegraph API docs: https://telegra.ph/api
 */
/** Valid Telegraph element tags */
export type TelegraphTag = 'a' | 'aside' | 'b' | 'blockquote' | 'br' | 'code' | 'em' | 'figcaption' | 'figure' | 'h3' | 'h4' | 'hr' | 'i' | 'iframe' | 'img' | 'li' | 'ol' | 'p' | 'pre' | 's' | 'strong' | 'u' | 'ul' | 'video';
/** Telegraph element node — tag with optional attrs and children */
export interface TelegraphElement {
    tag: TelegraphTag;
    attrs?: {
        href?: string;
        src?: string;
    };
    children?: TelegraphNode[];
}
/** A Telegraph node is either a text string or an element */
export type TelegraphNode = string | TelegraphElement;
export interface TelegraphAccount {
    short_name: string;
    author_name?: string;
    author_url?: string;
    access_token: string;
    auth_url?: string;
}
export interface TelegraphPage {
    path: string;
    url: string;
    title: string;
    description?: string;
    views?: number;
    can_edit?: boolean;
}
export interface TelegraphPageList {
    total_count: number;
    pages: TelegraphPage[];
}
export interface PublishedPage {
    path: string;
    url: string;
    title: string;
    publishedAt: string;
    updatedAt?: string;
    /** Original markdown for diffing/re-publishing */
    markdownHash?: string;
    /** Access token used to create this page (required for editing) */
    accessToken?: string;
}
export interface PublishingState {
    accessToken?: string;
    shortName?: string;
    authorName?: string;
    pages: PublishedPage[];
}
export interface TelegraphConfig {
    /** State directory where publishing.json is stored */
    stateDir: string;
    /** Short name for the Telegraph account (e.g., agent name) */
    shortName?: string;
    /** Author name shown on published pages */
    authorName?: string;
    /** Author URL shown on published pages */
    authorUrl?: string;
}
export declare class TelegraphService {
    private config;
    private stateFile;
    private state;
    constructor(config: TelegraphConfig);
    /**
     * Ensure a Telegraph account exists. Creates one if needed.
     * Returns the access token.
     */
    ensureAccount(): Promise<string>;
    /**
     * Create a new Telegraph account.
     */
    createAccount(shortName: string, authorName?: string): Promise<TelegraphAccount>;
    /**
     * Publish markdown content as a PUBLIC Telegraph page.
     *
     * WARNING: The published page is publicly accessible to anyone with the URL.
     * Do not publish sensitive or private information.
     *
     * Returns the page URL and path.
     */
    publishPage(title: string, markdown: string): Promise<TelegraphPage>;
    /**
     * Edit an existing Telegraph page.
     * Uses the original access token stored when the page was created.
     * Throws a clear error if the page is orphaned (token lost/rotated).
     */
    editPage(pagePath: string, title: string, markdown: string): Promise<TelegraphPage>;
    /**
     * Get page view count from Telegraph.
     */
    getPageViews(pagePath: string): Promise<number>;
    /**
     * List all locally tracked published pages.
     */
    listPages(): PublishedPage[];
    /**
     * Get state for inspection/testing.
     */
    getState(): PublishingState;
    private loadState;
    private saveState;
    private apiCall;
}
/**
 * Convert markdown text to Telegraph Node[] format.
 *
 * Supports: headings (h3/h4), bold, italic, strikethrough, code,
 * code blocks, links, images, blockquotes, lists (ol/ul),
 * horizontal rules, and paragraphs.
 *
 * Telegraph only supports h3 and h4, so # and ## map to h3,
 * ### maps to h3, #### and deeper map to h4.
 */
export declare function markdownToNodes(markdown: string): TelegraphNode[];
/**
 * Parse inline markdown formatting into Telegraph nodes.
 *
 * Handles: **bold**, *italic*, ~~strikethrough~~, `code`,
 * [links](url), and nested combinations.
 */
export declare function parseInline(text: string): TelegraphNode[];
//# sourceMappingURL=TelegraphService.d.ts.map