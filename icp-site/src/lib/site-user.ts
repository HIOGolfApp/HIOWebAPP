import {cookies} from 'next/headers';
import {getDb} from '../db';
import {sessions,accounts} from '../db/schema';
import {eq} from 'drizzle-orm';
// 独立部署改动:原版在没有本站会话时退回读取 Sites 注入的 oai-authenticated-user-* 请求头,并以 ADMIN_EMAIL
// 匹配判定管理员。离开 Sites 后这些头任何人都能伪造,只要知道或猜中管理员邮箱就能进后台,所以去掉;管理员改为本站账号上
// 的 is_admin 标记,只能在服务器上用 `node dist/server.mjs create-admin <邮箱>` 设置。
export type SiteUser={userId:string,email:string,displayName:string,fullName:string,local:true,admin:boolean};
export async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('')}
export async function getSiteUser():Promise<SiteUser|null>{const token=(await cookies()).get('xbq_session')?.value;if(!token)return null;const db=getDb(),s=(await db.select().from(sessions).where(eq(sessions.token,await digest(token))))[0];if(!s||s.expires<=Date.now())return null;const u=(await db.select().from(accounts).where(eq(accounts.id,s.userId)))[0];if(!u)return null;return {userId:u.id,email:u.email,displayName:u.name,fullName:u.name,local:true,admin:u.isAdmin===1};}
export function isAdmin(u:SiteUser|null){return !!u&&u.admin;}
export async function passwordHash(password:string,salt:string){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},key,256);return Array.from(new Uint8Array(bits)).map(x=>x.toString(16).padStart(2,'0')).join('');}
