# 来源说明

- `src/search/queryVariants.ts`、`src/search/refine.ts`：来自本地兄弟项目 `cc98-search`（Vita0818 / CC98-SearchPlus）；`src/search/rank.ts` 和 `src/text.ts` 的评分层级、摘要策略基于同项目适配。原始前端及浏览器通信代码未包含在本插件中。
- `src/ubb.ts`：来自本地兄弟项目 `cc98-desktop`。`src/text.ts` 增加面向 MCP 阅读的文本投影。
- `scripts/install-local.py`：基于本地 `XZZD-mcp/zju-tronclass` 的个人市场安装器（MIT，Copyright (c) 2026 Vita0818），调整插件身份并增加构建产物检查。
- CC98 REST 与 OIDC 请求格式以以上本地项目中的接口适配为依据；公开 OAuth 客户端参数不是用户凭据。上游参考包括 CC98 官方前端 ZJU-CC98/Forum、ZJU-CC98/CC98-V4 和社区客户端。运行时请求只发送到 `api.cc98.org` 与 `openid.cc98.org`。
- MCP SDK、Zod、TypeScript 及 Node.js 类型声明沿用各自许可证；版本锁定于 `npm-shrinkwrap.json`，安装包保留同一份锁文件。
- `runtime/` 使用 esbuild 打包，包含 MCP SDK、Zod 及其必要的运行依赖；完整依赖许可文本位于 `runtime/THIRD_PARTY_LICENSES.txt`。esbuild 额外提取出许可注释时，也会保留相应 `.LEGAL.txt` 文件。

本插件不是 CC98 或浙江大学官方产品。论坛文字及其附件不因本软件的许可证而变更权利归属。
