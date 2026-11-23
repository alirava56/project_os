import type { IncomingMessage, ServerResponse } from 'node:http';

export const providerFixtureEnv: Readonly<Record<string,string>>;
export function localProvider(handler: (request:IncomingMessage,response:ServerResponse,body:unknown) => void | Promise<void>):
  Promise<{origin:string;close():Promise<void>}>;
export function reply(response:ServerResponse,status:number,body:unknown,headers?:Record<string,string>): void;
