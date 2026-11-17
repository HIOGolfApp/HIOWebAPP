// Stand-in for `cloudflare:workers`: env.DB is the node:sqlite-backed D1 wrapper.
// ADMIN_EMAIL is deliberately absent: admin rights come from accounts.is_admin (see src/lib/site-user.ts).
import { getD1 } from '../runtime';

export const env = {
  get DB() {
    return getD1();
  },
};
