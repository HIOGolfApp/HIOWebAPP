// Stand-in for `next/headers` (headers() / cookies()), backed by the per-request context.
import { requestContext } from '../runtime';

function current(): Headers {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error('next/headers called outside a request');
  return ctx.headers;
}

export async function headers(): Promise<Headers> {
  return current();
}

export async function cookies() {
  const jar = new Map<string, string>();
  for (const part of (current().get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!jar.has(name)) jar.set(name, part.slice(i + 1).trim());
  }
  return {
    get(name: string) {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  };
}
