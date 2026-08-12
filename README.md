# Google Health Mobile

这是一个面向个人使用的、只读的 Google Health 桥接服务。它同时提供：

- Custom GPT Actions REST API：部署后可在 ChatGPT 安卓 App 里通过专属 GPT 使用；
- 远程 MCP `/mcp`：供支持自定义远程 MCP 的客户端使用；
- Google OAuth：refresh token 使用 AES-256-GCM 加密后保存；
- 步数、距离、活动热量、心率、睡眠、体重、体脂等查询与区间摘要。

项目参考并复用了 [davidmosiah/google-health-mcp](https://github.com/davidmosiah/google-health-mcp) 的 Google Health API v4 端点、只读 scope、日期范围及隐私设计。此实现是独立的远程单用户适配层，不会把上游默认的本地 HTTP 端口直接暴露到公网。

> 非 Google/Fitbit 官方产品，不是医疗器械，也不提供医疗建议。Google Health API 仍可能变化。这里读取的是 Google/Fitbit 云端 Google Health API 数据，不是直接读取手机本地 Health Connect 数据库。

## 1. 本地启动

需要 Node.js 20+ 或 Docker。

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -base64 32
openssl rand -base64 24
```

把三个结果分别填入 `TOKEN_ENCRYPTION_KEY`、`SERVICE_TOKEN` 和 `SETUP_TOKEN`。然后在 Google Cloud：

1. 创建项目并启用 Google Health API。
2. 配置 OAuth consent screen；个人测试时将自己的 Google 账号加入测试用户。
3. 创建 Web application 类型的 OAuth client。
4. 添加精确回调：`https://你的域名/oauth/google/callback`。
5. 把 client ID、client secret 和公网 HTTPS 地址填入 `.env`。

启动：

```bash
docker compose up -d --build
```

生产环境要在容器前放置 HTTPS 反向代理，并为 OAuth token 配置 PostgreSQL 或持久卷。不要直接公开 `3000` 端口；`docker-compose.yml` 默认只绑定本机。

### Render 部署

仓库提供 `render.yaml` Blueprint，默认使用 Render 免费 Web Service 和 Neon 免费 PostgreSQL。先在 Neon 创建项目，把 pooled connection string 填入 Render 的 `DATABASE_URL`；OAuth token 会加密后保存在数据库中，不依赖 Render 的临时磁盘。

创建 Blueprint 时，将 `.env` 中的 Google OAuth 配置和三个随机密钥复制到 Render Environment；不要上传 `.env` 文件。服务创建后，把 `PUBLIC_URL` 设置为 Render 分配的 HTTPS URL，并将同一地址配置为 Google OAuth 的精确回调：`https://你的Render域名/oauth/google/callback`。

Render 免费实例会在空闲后休眠，首次请求可能需要等待几十秒；Neon 免费数据库也会在空闲时自动缩容。这不影响个人使用，只会让首次调用稍慢。

## 2. 连接自己的 Google Health

浏览器打开下面地址，把占位内容替换成 `.env` 的值：

```text
https://你的域名/connect?token=你的SETUP_TOKEN
```

同意 Google 授权后会回到服务并显示 Connected。`SETUP_TOKEN` 只用于启动授权，不能填入 GPT Action。

验证：

```bash
curl -H "Authorization: Bearer 你的SERVICE_TOKEN" https://你的域名/api/status
```

## 3. 配置 Custom GPT（安卓端实际入口）

在 ChatGPT 网页版创建/编辑一个 GPT：

1. Instructions 可填入 [docs/gpt-instructions.md](docs/gpt-instructions.md) 的内容。
2. Add action → Import from URL，填写 `https://你的域名/openapi.json`。
3. Authentication 选择 **API Key**，Auth Type 选 **Bearer**，值填写 `SERVICE_TOKEN`。
4. 保存为 Only me，先在网页版测试“总结我今天的健康数据”。
5. 安卓 ChatGPT App 登录同一账号，在 GPT 列表打开这个专属 GPT。

普通聊天不会自动获得这项能力；需要进入这个专属 GPT。Actions/移动端的实际可用性仍取决于你的 ChatGPT 方案、地区及当时的产品支持。

## 4. 远程 MCP

MCP 地址为 `https://你的域名/mcp`，请求头为：

```text
Authorization: Bearer 你的SERVICE_TOKEN
```

仓库内 `.mcp.json` 是本地 Codex 插件开发配置。将 `GOOGLE_HEALTH_PUBLIC_URL` 和 `GOOGLE_HEALTH_SERVICE_TOKEN` 设置到客户端环境后再使用。

## 安全边界

- 仅实现读取；没有写入或删除健康记录的工具。
- 查询范围限制为 90 天，返回值递归移除常见身份、令牌和定位字段。
- Google refresh token 使用 AES-256-GCM 加密；务必备份加密密钥，丢失后只能重新授权。
- 这是单用户版本。不要把同一个实例分享给多人；多人服务需要独立用户登录、数据库行级隔离和标准 MCP OAuth。
- `SERVICE_TOKEN` 等同于读取权限。不要放到公开仓库、聊天消息或客户端日志。
- 正式公开发布前，需要真实隐私政策/条款域名、Google OAuth 验证及可能的安全评估，也需要遵循 OpenAI 当前的 App 提交流程。

## 开发验证

```bash
npm install
npm run check
```
