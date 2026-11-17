// Server-only. 独立部署改动:原版把收款码 PNG 以 Base64 写死在本文件里。本仓库是公开的,收款码又只给登录用户看,
// 所以改为读取服务器本地文件(deploy/install.sh 安装到 /etc/hio-icp-site/member-payment-qr.png,root 所有)。
import {readFileSync} from 'node:fs';
const path=process.env.ICP_PAYMENT_QR||'/etc/hio-icp-site/member-payment-qr.png';
const PNG=[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
export function memberPaymentPng():Uint8Array<ArrayBuffer>|null{try{const b=new Uint8Array(readFileSync(path));return PNG.every((x,i)=>b[i]===x)?b:null}catch{return null}}
