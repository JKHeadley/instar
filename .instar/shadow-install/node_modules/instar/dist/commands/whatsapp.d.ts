/**
 * WhatsApp CLI commands — add, login, doctor, status.
 */
interface AddWhatsAppOptions {
    backend?: string;
    authMethod?: string;
    phone?: string;
    authorized?: string;
    encrypt?: boolean;
    phoneNumberId?: string;
    accessToken?: string;
    webhookVerifyToken?: string;
    webhookPort?: number;
}
export declare function addWhatsApp(opts: AddWhatsAppOptions): Promise<void>;
interface ChannelLoginOptions {
    dir?: string;
    method?: string;
    phone?: string;
}
export declare function channelLogin(adapter: string, opts: ChannelLoginOptions): Promise<void>;
interface ChannelDoctorOptions {
    dir?: string;
}
export declare function channelDoctor(adapter: string | undefined, opts: ChannelDoctorOptions): Promise<void>;
interface ChannelStatusOptions {
    dir?: string;
}
export declare function channelStatus(opts: ChannelStatusOptions): Promise<void>;
export {};
//# sourceMappingURL=whatsapp.d.ts.map