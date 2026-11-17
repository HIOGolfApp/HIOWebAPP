import {getDb} from '../db';
import {applications,submissions} from '../db/schema';
import {eq} from 'drizzle-orm';
import {plans} from './plans';
export {plans};
export async function entitlement(userId:string){const db=getDb(),rows=await db.select().from(applications).where(eq(applications.userId,userId));const valid=rows.filter(x=>x.status==='approved'&&!!x.evidence&&x.expires&&Date.parse(x.expires)>Date.now()&&['vip','svip'].includes(x.tier));valid.sort((a,b)=>plans[b.tier as 'vip'|'svip'].limit-plans[a.tier as 'vip'|'svip'].limit);const selected=valid[0],tier=selected?selected.tier as 'vip'|'svip':'free';const own=await db.select().from(submissions).where(eq(submissions.userId,userId)),used=own.filter(x=>['pending','published'].includes(x.status)).length;return {tier,...plans[tier],used,remaining:Math.max(0,plans[tier].limit-used),expires:selected?.expires||null,active:tier!=='free'};}
