# Misskey 到 X 同步服务

Cloudflare Worker 服务。Misskey webhook 收到原创帖子后，只有正文或标签包含 `#to_x` 才同步到 X。

## 功能

- 只处理 Misskey `type: "note"`。
- 忽略回复、引用和纯转帖。
- `#to_x` 是唯一发布开关；`#no_to_x` 没有特殊作用。
- 正文超过 X 加权长度 280 时自动发 thread。
- 图片支持 JPEG、PNG、WebP、GIF；普通图片最多 4 张一组，GIF 独占一组。
- 图片只从公开 HTTPS URL 下载。
- D1 保存任务状态，Cron Trigger 负责失败重试和断点恢复。
- 无 TypeScript 构建和第三方运行时依赖。

## 目录

- `worker.js`：Worker 入口和同步逻辑。
- `migrations/0001_init.sql`：D1 初始化 SQL。
- `wrangler.jsonc`：Cloudflare/GitHub 部署配置。
- `.github/workflows/deploy.yml`：GitHub Actions 手动测试和部署。
- `test/worker.test.js`：Node 测试。

## GitHub 部署

### 1. 创建 GitHub 仓库

把当前目录推送为仓库：

```bash
git init
git add .
git commit -m "feat: add Misskey to X worker"
git remote add origin https://github.com/<owner>/<repository>.git
git push -u origin HEAD
```

### 2. 创建 Cloudflare D1

Cloudflare Dashboard：

```text
Workers & Pages -> D1 -> Create database
Database name: misskey-to-x
```

复制 D1 的 `database_id`，保存为 GitHub Secret：

```text
D1_DATABASE_ID
```

仓库中的 `wrangler.jsonc` 继续保留 `YOUR_D1_DATABASE_ID` 占位符。GitHub Actions 部署时由 `/home/luoyu/文档/misskey_to_x/scripts/configure-d1.js` 临时注入，Secret 不会写入 Git。

### 3. 配置 GitHub Secrets

仓库 Settings -> Secrets and variables -> Actions，添加：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
D1_DATABASE_ID
MISSKEY_WEBHOOK_SECRET
X_API_KEY
X_API_KEY_SECRET
X_ACCESS_TOKEN
X_ACCESS_TOKEN_SECRET
```

`CLOUDFLARE_API_TOKEN` 需要 Worker 和 D1 编辑权限。`D1_DATABASE_ID` 只用于 CI 配置 D1 binding。其余五个值同时是 Worker Secret。

### 4. 触发部署

进入 GitHub Actions 页面，选择 `Deploy Cloudflare Worker`，点击 `Run workflow` 手动执行。不会在 push 时自动运行。

工作流会执行语法检查、测试、写入 Worker Secrets、应用 D1 migration，然后调用 Cloudflare 部署。

### 5. 配置 Misskey Webhook

Cloudflare Worker 部署后复制 Worker URL，添加 Misskey Webhook：

```text
URL: https://<worker-name>.<subdomain>.workers.dev/webhooks/misskey
Secret: 与 MISSKEY_WEBHOOK_SECRET 完全一致
Event: Note posted
```

不要启用 Reply、Renote、Mention、Reaction 等事件。

## Cloudflare 控制台直接部署

也可以不使用 GitHub Actions：

1. 在 Dashboard 创建 Worker。
2. 将 `worker.js` 粘贴到 Worker Edit Code 并部署。
3. 创建 D1 数据库并执行 `migrations/0001_init.sql`。
4. 添加 D1 binding：

```text
Variable name: DB
Database: misskey-to-x
```

5. 添加 Secrets：

```text
MISSKEY_WEBHOOK_SECRET
X_API_KEY
X_API_KEY_SECRET
X_ACCESS_TOKEN
X_ACCESS_TOKEN_SECRET
```

6. 添加普通变量：

```text
REQUIRED_TAG=to_x
MEDIA_ALLOWED_HOSTS=
```

7. 添加 Cron Trigger：

```text
*/1 * * * *
```

## X API 凭据

X Developer Portal 创建 App：

```text
App permissions: Read and write
Authentication: OAuth 1.0a
```

生成并保存：

```text
API Key
API Key Secret
Access Token
Access Token Secret
```

修改 App 权限后重新生成 Access Token。X API 套餐必须允许创建帖子和上传媒体。

## 同步规则

- 只有 `#to_x` 才发布。
- `#no_to_x` 只作为普通文本标签，不会阻止发布。
- `replyId`、`renoteId`、`reply`、`renote` 存在时忽略。
- 所有 Misskey visibility 都可同步，以 `#to_x` 作为发布授权。
- `cw` 会变成正文开头的 `CW: ...`。
- 非公开、失效、超限或不支持的附件会跳过，文字仍可同步。
- 第一组图片附在第一条文字帖，其余图片组进入 thread 后续帖。
- 失败重试最多 5 次，任务记录保留在 D1。

## 端点

```text
GET  /healthz
POST /webhooks/misskey
```

Webhook 只接受：

```text
Content-Type: application/json
X-Misskey-Hook-Secret: <MISSKEY_WEBHOOK_SECRET>
```

响应：

```text
202 queued    已创建同步任务
202 duplicate 同一 note.id 已存在
202 ignored   非帖子或没有 #to_x
401 invalid_webhook_secret
400 invalid_json
413 request_body_too_large
415 content_type_must_be_json
405 method_not_allowed
```

## 测试

```bash
npm install
npm test
npm run check
```

## 验证

发布：

```text
#to_x 测试文字和图片
```

应产生 X 帖子。发布：

```text
普通帖子
```

应返回 ignored，不产生 X 帖子。
