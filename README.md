# DeepSearch

按 [设计方案](docs/design.md) 实现的 P0 网页搜索。Next.js App Router + TypeScript，服务端直接接入 DeepSeek Search API，使用两个独立 Redis 实例保存临时内容及费用控制状态。

## 已实现

- 中文首页与结果页，手机、平板、桌面响应式布局；完整 Light / Dark 主题，默认跟随系统，手动选择以独立 Cookie 保存，服务端直接输出所选主题。
- 右上角「设置 → 配置 API key」支持当前会话的个人密钥，优先于站点默认密钥。AES-256-GCM 加密保存在不持久化的内容 Redis，最长 24 小时；不回显密钥，不写入浏览器本地存储，清除会话数据时一并删除。
- Enter 提交与中文输入法保护；语言、包含/排除站点、最近一周/一月、自定义日期过滤；服务端校验 Unicode 字符数及操作符冲突。
- 一次检索 `count: 50, need_content: false`，保持上游顺序，安全 URL 过滤、规范化去重。快照每页固定 10 条，最多 5 页；翻页、刷新和浏览器返回读取同会话快照。
- 30 分钟快照；普通结果 5 分钟缓存、10 分钟硬过期，后半段仅在上游故障时回退；时效查询 30 秒、空结果 15 秒，不使用陈旧回退。缓存时间始终保留最初获取时间。
- 匿名签名会话、同源写入检查、会话归属检查、脱敏 HMAC 缓存键；跨实例请求锁、限流、每日费用预留、至多一次重试、401/402 熔断。
- 原子清除会话数据并使在途写入失效；不重置预算或防滥用配额；无永久搜索历史、第三方图标或远程字体请求。
- 健康检查、受令牌保护的 Prometheus 指标、脱敏结构化日志；Docker 多阶段构建、双 Redis 配置与 HTTPS 反向代理示例。

AI 总结、正文预览及账户属于后续阶段，P0 无需配置模型。

页眉及浏览器图标使用鲸鱼娘头像，透明原图、发布尺寸及生成提示词见 [品牌素材说明](docs/brand/README.md)。

## 本地启动

需要 Node.js 24 LTS、npm 和已运行的 Docker Desktop / Docker Engine。

```powershell
npm ci
Copy-Item .env.example .env
```

编辑 `.env`：将 `SESSION_SECRET` 替换为至少 32 字符的随机值，确认 `APP_ORIGIN=http://localhost:3000`。`DEEPSEEK_API_KEY` 可作为全站默认密钥，也可留空，由访客在 UI 的「设置 → 配置 API key」中保存自己的密钥。可用以下命令生成会话密钥，再保存到 `.env`（生成值只在你的终端显示）：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run infra:up
npm run control:status
```

首次全新安装、确认该账目从未产生调用后，批准当前控制 Redis 运行实例：

```powershell
npm run control:approve -- --fresh-install
npm run dev
```

访问 **http://localhost:3000**。`APP_ORIGIN` 必须与浏览器访问的协议、主机及端口完全一致；若改用 `127.0.0.1` 或其他端口，也应同步修改。没有 API key 时首页和主题仍可预览，搜索提示先在设置中配置密钥，不提供虚假结果。

设置中的密码框支持保存、替换和移除个人密钥，保存本身不发起付费验证；首次搜索时校验供应商权限。401/402 会停用该个人密钥并提示修改或充值，不关闭其他访客的检索入口。更换密钥后使用独立缓存，旧密钥的迟到错误不会停用新密钥。个人密钥产生的费用计入其 DeepSeek 账户，但仍受本站统一的 QPS、匿名会话额度和每日总预算保护。

`.env` 与 `.env.*` 已被 Git 和 Docker 构建上下文忽略，只有 `.env.example` 纳入仓库。不要使用 `NEXT_PUBLIC_` 存放密钥。修改 `.env` 后重启应用；生产环境必须设置稳定的会话密钥。未指定会话密钥的开发环境会自动生成忽略的 `.runtime/session-secret`，供页面和 API 共享；不要删除该文件后继续沿用旧的会话数据。

## 预算、重启与对账

默认每日预算为 **1 元**，按北京时间重置；单次 Search 预留 **0.005 元**，所有应用实例共享控制 Redis。费用以整数微元计算，成功且有上游结果才确认为已消费；明确的无结果/HTTP 失败释放预留，断网、本地超时或响应无法确认时保留为不确定费用。重试也单独取得 QPS 和预算额度。客户端取消当前页面请求不会撤销已开始的供应商调用。

内容 Redis 禁用 AOF/RDB，控制 Redis 使用 AOF `appendfsync always`，二者均为 `noeviction`。应用拒绝使用同一 Redis 进程的两个逻辑数据库替代独立实例。任何存储故障均不绕过费用检查。

**每次控制 Redis 重启后，付费入口默认关闭。** `npm run control:status` 可检查当前实例、预留、确认费用和不确定费用。核对供应商当日用量，将供应商总消费和仍未确认的预留合计后，再明确批准：

```powershell
npm run control:approve -- --usage-reviewed --spent-cny=0.25
```

这里的金额是示例，必须替换为实际核对值，且不能低于本地保守估计。无法核对时不要批准。站点默认密钥返回 401/402 会持久关闭该默认密钥的上游入口；修复密钥/余额并完成对账后，可在上述命令追加 `--clear-circuit`。个人密钥的错误仅停用对应会话的密钥。不要清空控制卷，也不要在恢复场景使用 `--fresh-install`。批准操作不会取消既有预留或不确定费用。

默认所有未配置可信代理的请求共用粗粒度 IP 配额。对外部署时，先配置只允许经可信反向代理访问应用，再设置 `TRUST_PROXY=true`，由代理**覆盖** `X-Real-IP`。程序仅保存按日 HMAC 处理的粗粒度网络标识，不保存完整 IP。

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

普通测试使用内存测试替身，不要求运行 Redis，也不会连接真实 DeepSeek。真实 Redis 集成测试使用独立的 `16379/16380` 端口和固定测试密码，**会清空这两个专用实例**，请勿将业务服务映射到测试端口：

```powershell
npm run test:infra:up
$env:RUN_REDIS_TESTS='1'
npm test
Remove-Item Env:RUN_REDIS_TESTS
npm run test:infra:down
```

浏览器测试需要 Python 3.11+，先安装依赖与 Chromium，然后在另一个终端启动 `npm run dev`：

```powershell
python -m pip install -r tests/e2e/requirements.txt
python -m playwright install chromium
npm run test:e2e
```

也可将 Python 依赖装入 `.runtime/python`，测试启动脚本会自动发现；已有兼容 Chromium 时设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定其完整路径。`TEST_BASE_URL` 可覆盖默认地址。浏览器测试拦截本项目 API 并返回确定样本，覆盖分页、刷新返回、过滤、主题、中文输入、空状态、错误、过期及旧响应覆盖防护；截图保存在忽略的 `.runtime/test-results/browser/`。服务端测试按 `tests/unit/` 和 `tests/integration/` 分组，共享样本位于 `tests/fixtures/`；验收记录见 [verification.md](docs/verification.md)。

完整 HTTP 集成测试实际执行 Route Handler、适配层和 Redis，只替换供应商 HTTP 响应，验证不会真实消费。真实账户的权限、延迟、日期边界和检索相关性需要填入密钥后另行实测；当前测试结果不代表生产 SLA。

## 生产部署

配置 `.env` 的正式 HTTPS `APP_ORIGIN`、随机会话密钥、API key、预算和监控令牌，然后：

```powershell
npm run deploy:up
npm run control:status
```

按上述首次安装或对账流程批准控制 Redis。应用默认仅向本机发布 3000 端口，Redis 端口也只绑定回环。参照 `ops/nginx/deepsearch.conf` 设置域名及证书，并在可信入口统一设置真实客户端 IP。日志格式不含请求查询串。构建期间不需要或注入真实密钥，运行时由 Compose 加载根目录 `.env`。部署文件集中在 `ops/docker/`，构建上下文仍是仓库根目录；可单独执行 `docker build -f ops/docker/Dockerfile -t deepsearch:p0 .`。

`GET /api/health` 不产生上游调用，只返回 `ready` 或 `unavailable`；Redis 不可用或控制实例未获批准时返回 503。未配置站点密钥不影响健康检查，访客可以在 UI 配置个人密钥。使用私密 `METRICS_TOKEN` 访问指标：

```text
GET /api/metrics
Authorization: Bearer <METRICS_TOKEN>
```

指标包括各操作的请求数、延迟直方图、缓存命中/陈旧回退、上游结果/错误/空结果及当日费用占用状态。可在监控系统计算 QPS、P95、429/超时率与缓存命中率。未配置或认证错误返回 404。日志仅输出操作类别、请求 ID、状态、错误码与耗时；反向代理、主机和第三方监控也需遵循相同隐私配置。

## 代码结构

```text
config/                  独立工具配置
docs/                    设计方案、验收记录与品牌素材说明
ops/docker/              Dockerfile、应用及测试环境 Compose
ops/nginx/               HTTPS 反向代理示例
ops/scripts/             费用控制与对账管理
public/                  浏览器直接访问的静态资源
src/app/                 页面、API 与布局
src/components/          搜索、筛选、分页、主题和设置控件
src/styles/              全局语义主题
src/server/              DeepSeek 接入、搜索编排、存储与费用控制
src/shared/              请求、响应和错误契约
tests/unit/              输入、上游契约、编排与加密单元测试
tests/integration/       真实 Redis 和 HTTP 接口测试
tests/e2e/               浏览器验收、启动器与 Python 依赖
tests/fixtures/          共享确定性样本和内存测试替身
tests/smoke/             生产容器启动检查
.runtime/                忽略的本地依赖、临时状态与测试输出
```

接口契约与官方依据见 [设计方案](docs/design.md)。当前 P0 接口为 `POST /api/search`、`GET /api/search/:searchId?page=N`、`GET/POST/DELETE /api/session/config`、`DELETE /api/session/data`、`GET /api/health`、`GET /api/metrics`。
