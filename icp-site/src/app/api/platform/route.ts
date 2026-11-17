import { getSiteUser } from '../../../lib/site-user';
import {entitlement} from '../../../lib/membership';
import { getDb } from '../../../db';
import { applications,audit,favorites,posts } from '../../../db/schema';
import { and,eq,desc } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
export const dynamic='force-dynamic';
const json=(v:unknown,s=200)=>Response.json(v,{status:s,headers:{'Cache-Control':'private, no-store'}});
export async function GET(req:Request){try{
 const u=await getSiteUser(); const db=getDb(); const url=new URL(req.url); const action=url.searchParams.get('action');
 const admin=!!u && !u.local && !!env.ADMIN_EMAIL && u.email.toLowerCase()===String(env.ADMIN_EMAIL).toLowerCase();
 const mine=u?await db.select().from(applications).where(eq(applications.userId,u.userId)).orderBy(desc(applications.created)):[];
 const quota=u?await entitlement(u.userId):null;const active=!!quota?.active;
 if(action==='article')return json({error:'该栏目已下线，请前往信息广场。'},410);
 if(action==='admin'){if(!admin)return json({error:'无管理权限，请使用已配置的管理员账号登录。'},403);return json({applications:await db.select().from(applications).orderBy(desc(applications.created)),posts:await db.select().from(posts),audit:await db.select().from(audit).orderBy(desc(audit.id)).limit(100)});}
 return json({user:u?{email:u.email,name:u.displayName,kind:u.local?'account':'native-admin'}:null,admin,active,quota,applications:mine.map(({evidence,...a})=>({...a,status:a.status==='approved'&&!evidence?'needs_review':a.status})),favorites:u?(await db.select().from(favorites).where(eq(favorites.userId,u.userId))).map(f=>f.article):[],articles:[]});
 }catch(e){console.error(e);return json({error:'服务暂时不可用，请稍后重试。'},503);}}
export async function POST(req:Request){try{
 if(req.headers.get('origin')!==new URL(req.url).origin)return json({error:'请求来源无效'},403);
 const u=await getSiteUser();if(!u)return json({error:'请先登录'},401);
 const b:any=await req.json(); const db=getDb();const now=new Date().toISOString();
 const admin=!u.local&&!!env.ADMIN_EMAIL&&u.email.toLowerCase()===String(env.ADMIN_EMAIL).toLowerCase();
 if(b.action==='apply'){
 if(!['vip','svip'].includes(b.tier))return json({error:'请选择申请套餐'},400);
 if(b.consent!==true||typeof b.name!=='string'||b.name.trim().length<2||b.name.length>50||!/^1[3-9]\d{9}$/.test(b.phone||''))return json({error:'请填写姓名、有效手机号并同意协议。'},400);
 const existing=await db.select().from(applications).where(eq(applications.userId,u.userId));if(existing.some(a=>a.status==='pending'||(a.status==='approved'&&!!a.evidence&&a.expires&&new Date(a.expires)>new Date())))return json({error:'已有待处理申请或有效会员，请在会员中心查看。'},409);
 await db.insert(applications).values({id:crypto.randomUUID(),userId:u.userId,email:u.email,name:b.name.trim(),phone:b.phone,status:'pending',tier:b.tier,created:now});return json({message:'申请已保存，等待核对服务方案及收款情况。尚未开通会员。'});
 }
 if(b.action==='favorite'||b.action==='post')return json({error:'该栏目已下线'},410);
 if(!admin)return json({error:'无管理权限'},403);
 if(b.action==='review'){
 if(!['approved','rejected'].includes(b.status)||typeof b.reason!=='string'||b.reason.trim().length<3||b.reason.length>500)return json({error:'请选择状态并填写至少三个字的处理说明。'},400);
 const target=(await db.select().from(applications).where(eq(applications.id,b.id)))[0];if(!target||target.status!=='pending')return json({error:'该申请不存在或已处理'},409);
 if(b.status==='approved'&&(b.confirmed!==true||typeof b.evidence!=='string'||b.evidence.trim().length<5||b.evidence.length>500))return json({error:'开通前须核对真实服务/收款或授权凭证，填写凭证记录并确认。'},400);
 const days=30;if(b.status==='approved'&&(!Number.isInteger(days)||days<1||days>366))return json({error:'会员有效期应为 1—366 天'},400);
 const expires=b.status==='approved'?new Date(Date.now()+days*86400000).toISOString():null;
 await db.batch([db.update(applications).set({status:b.status,reason:b.reason.trim(),reviewed:now,expires,evidence:b.status==='approved'?b.evidence.trim():''}).where(and(eq(applications.id,b.id),eq(applications.status,'pending'))),db.insert(audit).values({actor:u.email,action:b.status,target:b.id,detail:b.reason.trim(),created:now})]);return json({message:'处理结果已保存，用户可在会员中心查看。'});
 }
 return json({error:'不支持的操作'},400);
 }catch(e){console.error(e);return json({error:'保存失败，请稍后重试。'},503);}}
