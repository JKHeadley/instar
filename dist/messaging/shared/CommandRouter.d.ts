/**
 * Platform-agnostic command router.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Parses slash commands from incoming messages and routes them to
 * registered handlers. Platform adapters register their own command
 * handlers at startup.
 */
export interface CommandContext {
    /** The full original text (before parsing) */
    rawText: string;
    /** The command name without slash, lowercased (e.g., 'status') */
    command: string;
    /** Arguments after the command (trimmed), empty string if none */
    args: string;
    /** Channel/topic ID where the command was received */
    channelId: string;
    /** User ID who sent the command */
    userId: string;
    /** Platform-specific metadata */
    metadata?: Record<string, unknown>;
}
/**
 * A command handler returns true if the command was handled,
 * false to pass to the next handler or fall through to normal message routing.
 */
export type CommandHandler = (ctx: CommandContext) => Promise<boolean>;
export declare class CommandRouter {
    private commands;
    private platform;
    /** Interceptors run before command routing (e.g., attention topic commands) */
    private interceptors;
    constructor(platform: string);
    /**
     * Register a command handler.
     *
     * @param names - Command name(s). First is primary, rest are aliases.
     *   e.g., ['status'] matches '/status'
     *   e.g., ['switch-account', 'sa'] matches '/switch-account' and '/sa'
     * @param handler - Async function that handles the command
     * @param options - Additional options
     */
    register(names: string | string[], handler: CommandHandler, options?: {
        exact?: boolean;
        description?: string;
        platforms?: string[];
    }): void;
    /**
     * Add an interceptor that runs before command routing.
     * Interceptors receive the parsed context and return true to short-circuit.
     * Use for context-dependent routing (e.g., attention topic commands).
     */
    addInterceptor(interceptor: (ctx: CommandContext) => Promise<boolean>): void;
    /**
     * Parse and route a command. Returns true if handled.
     *
     * @param text - The raw message text
     * @param channelId - Channel/topic where the message was received
     * @param userId - User who sent the message
     * @param metadata - Optional platform-specific metadata
     */
    route(text: string, channelId: string, userId: string, metadata?: Record<string, unknown>): Promise<boolean>;
    /**
     * Parse a command string into command name and arguments.
     * Returns null if the text is not a valid command.
     */
    parse(text: string): {
        command: string;
        args: string;
    } | null;
    /**
     * Get all registered commands (for /help generation).
     */
    getRegisteredCommands(): Array<{
        names: string[];
        description?: string;
        platforms?: string[];
    }>;
    /**
     * Generate a help text listing all available commands.
     */
    generateHelp(): string;
}
//# sourceMappingURL=CommandRouter.d.ts.map