import type { RequestHandler } from 'express';
export const LOADING_REQUEST_HEADER:string;
export const LOADING_READ:string;
export function createAccountsLoadingBarrier(options?: {now?:()=>number}): {binding:{holdId:string;requestId:string};middleware:RequestHandler;wait:()=>Promise<void>;checkPending:(binding:unknown)=>any;release:(binding:unknown)=>void;cancel:()=>void;assess:(facts:any)=>any;snapshot:(token:string)=>any};

export function createLoadingRequestHeaders(origin:string,binding?:{requestId:string}): (request:{headers:()=>Record<string,string>;method:()=>string;url:()=>string})=>Record<string,string>;
