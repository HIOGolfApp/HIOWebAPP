declare module '*.sql' {
  const sql: string;
  export default sql;
}
declare module 'cloudflare:workers' {
  export const env: { readonly DB: import('./d1').D1Database };
}
