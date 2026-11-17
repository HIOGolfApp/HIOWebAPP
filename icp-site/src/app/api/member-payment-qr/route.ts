import {getSiteUser} from '../../../lib/site-user';
import {memberPaymentPng} from '../../../lib/member-payment-image';
export const dynamic='force-dynamic';
export async function GET(){
 const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Vary':'Cookie'};
 try{if(!await getSiteUser())return Response.json({error:'请先登录后查看会员收款码'},{status:401,headers});
 const bytes=Uint8Array.from(atob(memberPaymentPng),c=>c.charCodeAt(0));
 return new Response(bytes,{headers:{...headers,'Content-Type':'image/png'}});
 }catch{return Response.json({error:'收款码暂时不可用，请稍后重试'},{status:503,headers})}
}
