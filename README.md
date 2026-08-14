# dsh-search-endpoint-guard · 搜索端点守卫

[![npm version](https://img.shields.io/npm/v/dsh-search-endpoint-guard)](https://www.npmjs.com/package/dsh-search-endpoint-guard)
[![npm downloads](https://img.shields.io/npm/dm/dsh-search-endpoint-guard)](https://www.npmjs.com/package/dsh-search-endpoint-guard)
[![License](https://img.shields.io/npm/l/dsh-search-endpoint-guard)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-kanghelyu%2Fdsh--search--endpoint--guard-181717?logo=github)](https://github.com/kanghelyu/dsh-search-endpoint-guard)

**Keep `web_search` on the endpoint that actually accepts your API key.**
**让 `web_search` 始终指向真正接受你 API 密钥的端点。**

A DeepSeek Harness plugin that diagnoses, warns about, and optionally fixes the
case where the `web_search` tool still targets the **official** DeepSeek API
while your chat LLM runs on a **non-official** provider (a proxy, gateway, or
aggregator such as opencode.ai, one-api, new-api, etc.).

一个 DeepSeek Harness 插件：当你的对话 LLM 运行在**非官方**提供商（代理 / 网关 / 聚合器，如 opencode.ai、one-api、new-api 等）上、而 `web_search` 仍指向**官方** DeepSeek API 时，负责诊断、告警，并可自动修复。

## Quick install · 快速安装

```bash
# 1. 安装 pnpm（`dsh plugin` 命令依赖）
npm install -g pnpm

# 2. 从 npm 安装插件（`web` 换成你自己的 profile 名；装完重启 `dsh web`）
dsh plugin --profile web add -w dsh-search-endpoint-guard
```

---

## 1. The problem · 解决的问题

DeepSeek Harness 的 `web_search` 工具由 `web-search-deepseek` 插件实现，它**固定调用官方 Anthropic 兼容端点**：

```
https://api.deepseek.com/anthropic/v1
```

并用 `DEEPSEEK_API_KEY` 凭证做认证。而主对话走的 `llm-deepseek` 端点通常已被你配置到第三方网关（例如 `https://opencode.ai/zen/go/v1`）。

如果你的 API Key 是**网关签发的**（只在网关有效），官方 API 就会拒绝它，`web_search` 报错：

```
Authentication Fails, Your api key: ****EswO is invalid
```

而聊天一切正常——因为聊天走的是网关。这个错误极易误导排查（看起来像"密钥过期"），实际上只是**端点与密钥不匹配**。

**The `web_search` tool in DeepSeek Harness is backed by the `web-search-deepseek` plugin, which always calls the official Anthropic-compatible endpoint `https://api.deepseek.com/anthropic/v1` with the `DEEPSEEK_API_KEY` credential — it deliberately does NOT reuse the chat adapter's `DEEPSEEK_BASE_URL`.** When your LLM runs on a third-party gateway and the key only works there, the official API rejects it:

```
Authentication Fails, Your api key: ****EswO is invalid
```

Chat keeps working (it goes through the gateway), which makes this bug look like a "key expired" problem when it is really an endpoint/key mismatch.

## 2. What it does · 它能做什么

- **诊断（Diagnose）**：在启动时（可配置）和按需（工具 `search_endpoint_check`）对比两个有效端点：
  - 对话端点：`llm-deepseek.baseURL` → `$DEEPSEEK_BASE_URL` → `https://api.deepseek.com`
  - 搜索端点：`web-search-deepseek.baseURL` → `$DEEPSEEK_SEARCH_BASE_URL` → `https://api.deepseek.com/anthropic/v1`
- **告警（Warn）**：当搜索仍是官方默认端点、而对话不是时，输出明确告警和修复方法（三态：`aligned` 一致 / `misaligned` 错位 / `differing` 不同）。
- **对齐（Align）**：`autoAlign: true`（启动时）或工具 `apply: true`（按需）直接把 `web-search-deepseek.baseURL` 写成对话端点。
- **探测（Probe）**：工具 `probe: true` 向有效搜索端点发一条最小请求，实测密钥 + 端点是否兼容（HTTP 状态 / 错误原文，密钥不出现在输出中）。

## 3. Install · 安装

```bash
# 从 npm 安装（推荐；需要 pnpm）
npm install -g pnpm
dsh plugin --profile web add -w dsh-search-endpoint-guard

# 本地路径安装（开发时试用）
dsh plugin --profile web add -w /path/to/dsh-search-endpoint-guard
```

- `--profile <name>` 换成你自己的 profile 名（GUI 默认是 `web`）；装完**重启 `dsh web`** 生效。
- `-w` 是 pnpm 的 workspace-root 标志（profile 目录本身是 pnpm workspace，缺少会报 `ERR_PNPM_ADDING_TO_ROOT`）。
- 本包**零 npm 依赖**（无 `dependencies`/`peerDependencies`）：运行所需的 `@deepseek-ai/*` 由 DSH 安装本身提供（`$DSH_HOME/profiles/node_modules` 的 flat fallback），所以 pnpm 安装时不会去解析任何私有包。
- 源码仓库 / Repository：<https://github.com/kanghelyu/dsh-search-endpoint-guard>

### 手动安装（不需要 pnpm）

把本包复制到 `~/.dsh/profiles/<name>/node_modules/dsh-search-endpoint-guard/`，然后在 profile 的 `package.json` 的 `dsh.profile.bundles` 列表中加入 `"dsh-search-endpoint-guard"`，重启生效。

> `dsh plugin` 需要 `pnpm` 在 PATH 上；安装后**重启 `dsh web`** 生效。
> 手动安装：把本包放进 `~/.dsh/profiles/<name>/node_modules/` 并把 `dsh-search-endpoint-guard` 加入该 profile `package.json` 的 `dsh.profile.bundles` 列表。

## 4. Configuration · 配置

```yaml
# cordis.patch.yml（或 profile 的 patch 覆盖层）
- insert:
    - id: search-endpoint-guard
      name: dsh-search-endpoint-guard
      config:
        autoAlign: false        # 启动时检测到错位是否自动写入 baseURL（默认 false）
        checkOnStartup: true    # 启动时运行一次检查并打日志（默认 true）
        probeTimeoutMs: 30000   # 一次探测请求的超时毫秒数（默认 30000）
```

- `autoAlign` 默认 **false**：对齐意味着把搜索端点改成对话端点，只有当该端点支持 Anthropic 兼容 `/messages` 协议 + 原生 `web_search_20250305` 工具时才安全，因此默认只告警、不自动改。

## 5. Usage · 使用

每个会话都会暴露工具 **`search_endpoint_check`**：

| 参数 | 说明 |
|---|---|
| `apply` | `true` 且状态为 `misaligned` 时，通过 settings 写入 `web-search-deepseek.baseURL = 对话端点` |
| `probe` | `true` 时向有效搜索端点发一条最小请求，返回 HTTP 状态与错误详情（密钥脱敏） |

```text
search_endpoint_check            → 只诊断
search_endpoint_check apply=true → 诊断 + 修复错位
search_endpoint_check probe=true → 诊断 + 实测端点
```

启动日志示例（错位时）：

```
search-endpoint-guard: web_search MISALIGNED — chat LLM uses https://opencode.ai/zen/go/v1
but web_search still targets the official https://api.deepseek.com/anthropic/v1.
Fix: add to settings.yaml: web-search-deepseek: { baseURL: https://opencode.ai/zen/go/v1 }
```

## 6. Manual fix · 手动修复（等价操作）

在 `~/.dsh/settings.yaml` 增加：

```yaml
web-search-deepseek:
  baseURL: https://opencode.ai/zen/go/v1   # 改成你的对话端点
```

## 7. Caveats · 注意事项

1. **对齐的前提**：对话端点必须支持 Anthropic 兼容的 `/messages` 协议与原生 `web_search_20250305` 服务端工具（官方端点与多数主流网关支持）。不确定时先 `probe: true` 实测。
2. **不要覆盖全局 `DEEPSEEK_API_KEY`**：如果聊天在网关上、密钥只在网关有效，别把 `DEEPSEEK_API_KEY` 换成官方 key——聊天会断。要换官方 key 请用独立凭证名（如 `DEEPSEEK_SEARCH_API_KEY`）+ `web-search-deepseek.apiKeyEnv`。
3. **GUI「模型设置」页的占位符陷阱**：DeepSeek 提供商表单里的 baseURL 占位符显示的是官方地址 `https://api.deepseek.com`。那是占位符，不是当前值——照抄保存会把聊天也指向官方端点。留空或填网关地址。
4. `autoAlign` 只作用于 `misaligned` 状态；`differing`（两个自定义端点不同）只告警，由你判断是否有意为之。

## 8. Development · 开发与测试

```bash
node --check lib/index.js          # 语法检查
node test/smoke.mjs                # 冒烟测试（14 项：纯函数 + apply 接线 + 真实端点探测）
```

`smoke.mjs` 通过绝对路径从 profile 的 node_modules 加载插件本体（保证 `@deepseek-ai/*` 依赖解析正确），并用本机 `~/.dsh/.credentials.yaml` 的真实密钥做两次实网探测：修复前打官方端点（预期 401）与修复后打网关端点（预期 200），同时断言密钥永不泄漏到输出。

## 9. License · 许可证

MIT
