const images:Record<string,{src:string,alt:string}>={
  "golf": {
    "src": "/images/verified-golf-2026.jpg",
    "alt": "佛山高尔夫球会官网公开的球道实景"
  },
  "mobile": {
    "src": "/images/shenzhen-smartphone.jpg",
    "alt": "国内日常生活中的手机应用使用场景"
  },
  "tech": {
    "src": "/images/china-tech-work.jpg",
    "alt": "技术人员使用电脑协作开发软件"
  },
  "academy": {
    "src": "/images/verified-academy-2026.jpg",
    "alt": "CIS公开的君兰合作高尔夫课程场地练习照片"
  },
  "website": {
    "src": "/images/real-website.jpg",
    "alt": "笔记本电脑屏幕上的网页开发代码实景"
  },
  "app": {
    "src": "/images/domestic-app-2026.jpg",
    "alt": "国内华为手机HarmonyOS中文系统界面与移动应用终端实景"
  },
  "range": {
    "src": "/images/verified-range-2026.jpg",
    "alt": "佛山资讯网南国桃园高尔夫介绍中的场地实景"
  },
  "store": {
    "src": "/images/domestic-store-2026.jpg",
    "alt": "国内永辉超市自助收银设备、扫码区与中文业务界面实景"
  },
  "logistics": {
    "src": "/images/verified-logistics-2026.jpg",
    "alt": "祈业官网公开的企业数字化项目现场交流照片"
  },
  "email": {
    "src": "/images/real-email.jpg",
    "alt": "企业邮箱等网络服务使用的服务器机柜实景"
  },
  "miniBusiness": {
    "src": "/images/real-miniBusiness.jpg",
    "alt": "深圳用户实际操作手机的移动业务使用场景"
  },
  "ai": {
    "src": "/images/verified-ai-2026.jpg",
    "alt": "猛骑官网AI无人销售案例页公开的售货设备场景"
  }
};
export function serviceImage(row:{imageKey?:string,category:string}){return images[row.imageKey||'']||images[['高球场地','运动培训','体育服务'].includes(row.category)?'golf':row.category==='小程序开发'?'mobile':'tech'];}
