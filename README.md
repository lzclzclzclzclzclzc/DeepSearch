# DeepSearch

## 产品介绍

DeepSearch 是一个基于 DeepSeek Search 的轻量网页搜索工具，支持中文界面、明暗主题和手机访问。

- 按语言、站点和日期筛选，直接查看摘要并跳转原网页。
- 点击「生成 AI 总结」，基于本次搜索生成带来源引用的总结；支持停止、跨页查看引用和刷新后恢复。
- 每次最多获取 50 条结果，每页 10 条；翻页使用已有结果，无需重复调用搜索接口。
- 可使用站点默认 API key，也可在「设置 → 配置 API key」中填写个人密钥。
- 在设置中查看今日开销估算，按北京时间统计；实际费用以 DeepSeek 账单为准。
- 搜索数据临时保存，支持一键清除当前会话；个人密钥加密保存，最长保留 24 小时。

## 部署方法

需要 **Node.js 24 LTS** 和 **Docker Compose**，网络需能访问 DeepSeek API。

下载项目后，在项目目录执行：

```sh
npm ci
cp .env.example .env
```

Windows PowerShell 可使用 `Copy-Item .env.example .env` 复制配置文件。

编辑 `.env` 中的以下配置，其余选项可保持默认：

| 配置 | 说明 |
| --- | --- |
| `SESSION_SECRET` | 至少 32 字符的随机密钥，用于会话签名及个人 API key 加密 |
| `APP_ORIGIN` | 实际访问地址，默认 `http://localhost:3333`；域名、协议及端口须与浏览器一致 |
| `DEEPSEEK_API_KEY` | 可选的站点默认密钥；留空时，用户需在设置中填写个人密钥 |
| `SUMMARY_MODEL` | 总结模型，默认 `deepseek-flash`；与搜索使用同一个 API key |

生成随机会话密钥：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

将生成值填入 `.env`，再启动完整服务：

```sh
npm run deploy:up
```

打开 [http://localhost:3333](http://localhost:3333)。应用和两个 Redis 实例会一起启动，开销记录保存在持久化卷中。服务不设置每日预算上限，保留请求限流。

本地开发可改用：

```sh
npm run infra:up
npm run dev
```

默认应用端口为 `3333`，内容与费用 Redis 分别使用本机 `6381`、`6380` 端口。修改 `.env` 后需重启应用；Docker 部署可重新执行 `npm run deploy:up`。

对外部署时，配置 HTTPS 域名并同步更新 `APP_ORIGIN`，反向代理示例见 [ops/nginx/deepsearch.conf](ops/nginx/deepsearch.conf)。`.env` 不纳入版本管理，请保管好其中的密钥。

AI 总结仅手动触发，可能产生模型及补读网页的费用；设置中的今日开销一并统计。默认模型费率采用高峰单价保守估算，可通过 `.env.example` 中的 `SUMMARY_*_PRICE` 按所用模型调整，实际费用以供应商账单为准。
