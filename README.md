# CC98-SearchPro

面向“找讨论 → 判断相关性 → 阅读上下文 → 引用证据”的独立只读 MCP 与 Codex 插件。支持校园网或已有 VPN 直连。

[下载发行包](https://github.com/Vita0818/CC98-SearchPro/releases/latest) · [版本记录](CHANGELOG.md) · [隐私说明](PRIVACY.md)

## 搜索能力

- **多路召回**：完整关键词优先，结合中文分词和有限的查询变体补查；精确标题不足时参考相关标题中的高频片段。
- **证据排序**：标题完整短语、首帖正文完整短语、标题全词、正文全词、弱相关依次排列；反馈词只用于召回，不计作相关性证据。
- **正文核对与摘要**：按预算读取候选首帖，返回命中片段、验证状态、主题与楼层编号。
- **版面与日期筛选**：版内查询使用 CC98 的版内搜索接口；日期在已召回候选中按发帖时间筛选，支持相关性、最新、阅读数排序。
- **可续读**：搜索快照分页不重复发请求；帖子按楼层读取，单楼长正文可按字符位置继续，支持原始 UBB／Markdown。
- **有限请求**：请求串行且至少间隔 400 ms；搜索 403 或 API 429 冷却后最多重试一次；持续失败保留已有结果。

插件不含发帖、回帖、私信、点赞等写工具，不调用大模型 API，不需要任何 AI 供应商密钥。

## 安装

需要 Node.js **22.18+**，交互登录脚本需要 Python 3。仓库与发行包包含内置依赖的 `runtime/`，使用时无需 npm 安装或编译。

### 从 GitHub 安装到 Codex

```sh
codex plugin marketplace add Vita0818/CC98-SearchPro --ref v0.1.0
codex plugin add cc98-searchpro@cc98-searchpro
```

安装后打开新聊天，使用 **CC98-SearchPro** 检查登录状态。状态工具会返回当前安装位置的 `setup_command`，在本机终端运行它即可隐藏输入 CC98 账号密码。

仓库插件市场遵循 [Codex 官方插件分发格式](https://developers.openai.com/plugins/build/plugins#marketplace-metadata)，位于 `.agents/plugins/marketplace.json`。这里提供的是 GitHub 仓库分发，不是官方公共插件目录上架。

### 下载 ZIP 或克隆源码

将 Release 中的 ZIP 解压到用户主目录下，或克隆仓库：

```sh
git clone https://github.com/Vita0818/CC98-SearchPro.git
cd CC98-SearchPro
python3 scripts/login.py
node runtime/cli.mjs status --check
python3 scripts/install-local.py --apply
```

安装器会注册现有目录并保留个人市场中的其他条目；安装后请保留该目录。同名插件指向其他目录时会停止，不覆盖原条目。只预览安装位置时省略 `--apply`。

## 登录与本地数据

在插件目录也可以使用 npm 命令配置和检查登录，无需先安装 npm 依赖：

```sh
npm run configure
npm run status
```

`configure` 在本机终端隐藏输入 CC98 密码，只通过子进程标准输入传给登录程序。密码不保存、不进入命令参数；新安装的会话令牌保存在 `~/.local/share/cc98-searchpro/session.json`（文件权限 `0600`）。设置 `CC98_SEARCHPRO_DATA_DIR` 可选择独立数据目录；兼容旧变量 `CC98_SEARCH_DATA_DIR`，未设置时也遵循 `XDG_DATA_HOME`。如果开发版目录 `cc98-search-mcp` 中已有会话而新目录尚无会话，会继续使用原会话。令牌过期自动刷新，刷新被拒绝后提示重新登录，不自动重试密码。

已持有会话 JSON 时可以导入（不把令牌粘进聊天）：

```sh
node runtime/cli.mjs import-session < /path/to/session.json
npm run status
```

支持 `access_token` / `accessToken`、`refresh_token` / `refreshToken`，以及桌面端 `expires_at`（Unix 秒）、`expires_at_ms` 或网页 `accessToken_expirationTime`。兼容网页的 `str-` 包装和 `Bearer` 前缀。导入会为本插件创建独立副本，不会自动读取或修改其他客户端的会话；不同客户端共享刷新令牌可能受服务端令牌轮换影响，独立登录更稳定。

删除本插件会话：`node runtime/cli.mjs logout`。

## 通用 stdio MCP

将以下配置中的路径替换为实际目录，可供支持 stdio MCP 的客户端使用：

```json
{
  "mcpServers": {
    "cc98-searchpro": {
      "command": "node",
      "args": ["/absolute/path/CC98-SearchPro/runtime/server.mjs"]
    }
  }
}
```

## 五个工具

| 工具 | 用途 |
| --- | --- |
| `cc98_status` | 检查配置；`check=true` 读取当前账号验证连接 |
| `cc98_find_boards` | 按名称查找版面编号，支持分页 |
| `cc98_search` | 多路搜索、去重排序、正文验证，产生搜索快照 |
| `cc98_search_results` | 通过 `search_id`、`offset` 翻阅已有候选 |
| `cc98_read_topic` | 阅读主题与楼层，用 `next` 继续长正文或后续楼层 |

示例搜索参数：

```json
{
  "keyword": "保研经验",
  "terms": ["保研", "经验"],
  "depth": "balanced",
  "created_after": "2025-01-01",
  "sort": "relevance",
  "limit": 10
}
```

`terms` 可省略，由本地分词生成。日期均为北京时间，`created_before` 包含指定日期全天；上游时间缺少时区时不猜测，日期筛选会跳过并计入 `unknown_dates`。`limit` 只控制结果每页数量。

阅读工具接受含页码和楼层锚点的链接，例如 `/topic/42/3#7` 从第 27 楼开始；显式传 `from` 时以该偏移为准。引用链接按论坛每页 10 楼的规则生成。

| 深度 | 原词最多页数 | 首帖验证上限 | 业务 API 调用上限 | 单次搜索时间上限 |
| --- | ---: | ---: | ---: | ---: |
| `quick` | 1 | 5 | 10 | 12 秒 |
| `balanced`（默认） | 2 | 12 | 20 | 25 秒 |
| `deep` | 3 | 24 | 32 | 45 秒 |

每个补查词只取一页，每页请求 20 条；最多 3 个初始补查词和 2 个标题反馈词。调用统计按业务 GET 计数，不含令牌刷新及每次 GET 的有限重试。达到时间、请求预算或发生错误时返回 `partial` 和 `stop_reason`。

相同参数的完整搜索两分钟内复用快照，`refresh=true` 强制重新搜索。快照仅驻留内存，最多 20 份、15 分钟有效；翻页不会扩大召回范围。服务重启、登录切换或退出会使对应快照失效。多客户端使用时各自保有搜索快照。

## 覆盖范围与验证

官方主题索引决定候选范围，插件再对候选首帖做正文验证。它不是全站全文索引，不能保证召回正文命中但标题索引完全未召回的帖子，也不搜索全部回复、图片或附件。`coverage.exhaustive` 始终为 `false`，`total_candidates` 只是本次筛选后候选数量；`complete` 表示本次设定范围的执行完成，不表示搜索了整个论坛。

`match` 与 `first_post_verification` 分开返回：标题可以精确匹配而正文尚未读取；正文不可访问不会伪装成已验证。日期筛选和排序作用于已召回候选，因此“按最新”不是服务端完整的最新匹配列表。

离线测试使用模拟 CC98 响应。2026-10-22 已使用构建后的插件直连公开版面接口，读取到 12 个分区、267 个版面；账号登录、搜索和受限帖阅读尚未完成真实账号联调。真实验收先运行 `npm run status`，再用自己知道标题和正文的帖子测试搜索、版内限制、引用楼层和翻页。

## 开发与打包

```sh
npm ci --ignore-scripts
npm run check           # 类型、行为、安装器、构建与独立运行测试
npm run release:package # 在 release/v0.1.0/ 生成 ZIP、npm tgz 与 SHA256SUMS
```

`src/` 为源代码，`dist/` 为普通编译输出，`runtime/` 为包含运行依赖的发布文件。后者随仓库提交，支持 Git 插件市场安装。`npm-shrinkwrap.json` 锁定构建与运行依赖，`runtime/THIRD_PARTY_LICENSES.txt` 保留被打包依赖的许可文本。发布包不包含账号会话、环境文件、npm 缓存或 `node_modules`。

## 实现来源

查询变体、标题反馈与匹配策略基于 [CC98-SearchPlus](https://github.com/Vita0818/CC98-SearchPlus) 适配；UBB 解析来自本地 `cc98-desktop` 项目。登录、请求队列、搜索编排、快照、长帖阅读与 MCP 工具独立实现。详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
