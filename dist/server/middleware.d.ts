/**
 * Express middleware — JSON parsing, CORS, auth, error handling.
 */
import type { Request, Response, NextFunction } from 'express';
export declare function corsMiddleware(req: Request, res: Response, next: NextFunction): void;
/**
 * Auth middleware — enforces Bearer token on API endpoints.
 * Health endpoint is exempt (used for external monitoring).
 */
export declare function authMiddleware(authToken?: string): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Simple in-memory rate limiter using a sliding window.
 * No external dependencies. Suitable for a local management API.
 */
export declare function rateLimiter(windowMs?: number, maxRequests?: number): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Request timeout middleware — prevents slow requests from hanging.
 * Returns 408 if the request takes longer than the timeout.
 */
export declare function requestTimeout(timeoutMs?: number): (req: Request, res: Response, next: NextFunction) => void;
/**
 * HMAC-sign a view path so the URL can be opened in a browser without exposing the auth token.
 * The signature is path-specific — sharing a signed URL only grants access to that one view.
 */
export declare function signViewPath(viewPath: string, authToken: string): string;
/**
 * Security headers for dashboard paths — prevents clickjacking, MIME-sniffing,
 * and restricts resource loading to trusted sources.
 */
export declare function dashboardSecurityHeaders(req: Request, res: Response, next: NextFunction): void;
export declare function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void;
//# sourceMappingURL=middleware.d.ts.map