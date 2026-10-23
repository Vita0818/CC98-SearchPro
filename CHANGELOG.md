# CC98-SearchPro v0.1.0

发布日期：2026-10-23。

首个公开版本，提供独立的 CC98 搜索增强 MCP 与 Codex 插件包装。

- 中文分词、查询变体和有限标题反馈扩展召回，按主题去重。
- 区分标题／首帖正文精确匹配、全词匹配及弱相关，返回验证状态、摘录和可引用链接。
- 支持版内搜索、候选发帖日期筛选、相关性／最新／阅读数排序。
- 搜索快照分页、长正文续读、原始 UBB／Markdown 阅读。
- 串行节流、有限重试、请求及时间预算，异常时保留已召回结果。
- 五个只读工具；终端登录与令牌刷新；不依赖大模型 API。
- 附带内置依赖的 Node.js 运行文件、搜索 Skill、本地安装器和仓库插件市场。

## 安装

安装 Node.js 22.18+，然后在 Codex 中添加仓库插件市场：

```sh
codex plugin marketplace add Vita0818/CC98-SearchPro --ref v0.1.0
codex plugin add cc98-searchpro@cc98-searchpro
```

或下载本次 Release 的 ZIP，解压到用户主目录下，执行：

```sh
cd CC98-SearchPro
python3 scripts/login.py
python3 scripts/install-local.py --apply
```

首次使用在本机终端配置 CC98 登录；MCP 状态工具会返回对应安装位置的 `setup_command`。

## 已验证的范围

离线行为测试、MCP 协议测试、类型检查、构建，以及脱离源码和 node_modules 的独立运行测试。公开版面接口已真实直连验证；登录后的真实账号搜索和受限帖子阅读尚未联调。

搜索仍依赖官方主题索引，正文验证只覆盖候选首帖，不是全论坛回复全文检索。日期筛选作用于已召回候选，结果数不是全站匹配总数。
