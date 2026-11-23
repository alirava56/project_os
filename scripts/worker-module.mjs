import { registerHooks } from 'node:module';
import { posix } from 'node:path';

const root=new URL('../src/',import.meta.url).href;

export async function loadWorkerModule(path) {
  const hooks=registerHooks({resolve(specifier,context,nextResolve) {
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && !posix.extname(specifier)) {
      const url=new URL(specifier+'.ts',context.parentURL);
      if (url.href.startsWith(root)) return nextResolve(url.href,context);
    }
    return nextResolve(specifier,context);
  }});
  try {return await import(new URL(path,import.meta.url).href);}
  finally {hooks.deregister();}
}
