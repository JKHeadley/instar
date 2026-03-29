/**
 * Private content viewer for Instar agents.
 *
 * Stores markdown content locally and serves it as rendered HTML
 * via the agent's HTTP server. When combined with a Cloudflare Tunnel,
 * this provides authenticated access to rendered content from anywhere.
 *
 * Unlike Telegraph (public), private views are gated by the agent's
 * auth token and only accessible through the tunnel URL.
 */
export interface PrivateView {
    id: string;
    title: string;
    markdown: string;
    /** SHA-256 hash of the PIN, if PIN-protected */
    pinHash?: string;
    createdAt: string;
    updatedAt?: string;
}
export interface PrivateViewerConfig {
    /** Directory to store views */
    viewsDir: string;
}
export declare class PrivateViewer {
    private viewsDir;
    private lastTimestamp;
    constructor(config: PrivateViewerConfig);
    /**
     * Store markdown content for private viewing.
     * If a PIN is provided, the view requires PIN entry before content is shown.
     */
    create(title: string, markdown: string, pin?: string): PrivateView;
    /**
     * Update an existing view.
     */
    update(id: string, title: string, markdown: string): PrivateView | null;
    /**
     * Get a view by ID.
     */
    get(id: string): PrivateView | null;
    /**
     * List all views.
     */
    list(): PrivateView[];
    /**
     * Delete a view.
     */
    delete(id: string): boolean;
    /**
     * Verify a PIN against a view's stored hash.
     */
    verifyPin(id: string, pin: string): boolean;
    /**
     * Render a PIN entry page for a protected view.
     */
    renderPinPage(view: PrivateView, error?: boolean): string;
    /**
     * Render a view as self-contained HTML.
     */
    renderHtml(view: PrivateView): string;
    private save;
}
//# sourceMappingURL=PrivateViewer.d.ts.map