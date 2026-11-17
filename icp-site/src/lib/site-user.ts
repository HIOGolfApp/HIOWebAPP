import {cookies} from 'next/headers';
import {getChatGPTUser} from '../app/chatgpt-auth';
import {getDb} from '../db';
import {sessions,accounts} from '../db/schema';
import {eq} from 'drizzle-orm';
import {env} from 'cloudflare:workers';
export async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('')}
export async function getSiteUser(){const token=(await cookies()).get('xbq_session')?.value;if(token){const db=getDb(),s=(await db.select().from(sessions).where(eq(sessions.token,await digest(token))))[0];if(s&&s.expires>Date.now()){const u=(await db.select().from(accounts).where(eq(accounts.id,s.userId)))[0];if(u)return {userId:u.id,email:u.email,displayName:u.name,fullName:u.name,local:true};}}
const native=await getChatGPTUser();if(native&&env.ADMIN_EMAIL&&native.email.toLowerCase()===String(env.ADMIN_EMAIL).toLowerCase())return {...native,local:false};return null;}
export async function passwordHash(password:string,salt:string){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},key,256);return Array.from(new Uint8Array(bits)).map(x=>x.toString(16).padStart(2,'0')).join('');}
