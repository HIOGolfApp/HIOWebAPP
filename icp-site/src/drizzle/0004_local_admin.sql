-- 独立部署:管理员改为本站账号上的服务端标记(原版靠 Sites 注入的 oai-authenticated-user-* 请求头,
-- 那些头在 Sites 之外任何人都能伪造)。只能在服务器上用 `node dist/server.mjs create-admin <邮箱>` 设置。
ALTER TABLE `accounts` ADD `is_admin` integer DEFAULT 0 NOT NULL;
