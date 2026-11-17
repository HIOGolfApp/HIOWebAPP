// 原版是 Next.js App Router(vinext 在 Cloudflare Workers 上渲染);页面本身是纯客户端组件('use client',
// hash 路由),所以这里直接挂载成静态单页,由 nginx 提供,接口走同源 /api/。
import { createRoot } from 'react-dom/client';
import '../src/app/globals.css';
import Home from '../src/app/page';

createRoot(document.getElementById('root')!).render(<Home />);
