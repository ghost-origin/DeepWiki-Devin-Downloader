# Devin Wiki 本地化下载SOP

> 版本：v1.0（2026-09-06）
> 适用范围：把 Devin（app.devin.ai）为 GitHub 仓库生成的 wiki 保存为本地原始 markdown
> 配套资产：`devin-wiki-capture.js`（一键自动版，唯一现行工具）· 产物统一放 `wiki/` 下，命名规范 `wiki/{REPO}-wiki-md/`
> 实战记录见同目录《DeepWiki抓取-工作流记录.md》

---

## 1. 概念速览（30 秒）

| 概念    | 说明                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 两套内容源 | 账号实时版（app.devin.ai，可随时刷新、跟随最新 commit）≠ 公共缓存版（deepwiki.com，约 7 天刷新）。**默认抓账号实时版**，两版内容可能完全不同，交付前必须核对 commit                                       |
| 会话凭据  | 登录后浏览器内存中的 `auth1_xxx` token，随请求头发送：`Authorization: Bearer ...` 与 `x-cog-org-id: ...`。接口只认这两个头，匿名访问会静默回退到公共版                                    |
| 核心接口  | `GET /api/wiki/get_full_multi_language_wiki?repo_name={owner}/{repo}&branch_name={branch}` —— 一次请求返回全部章节的**原始 markdown**（含 mermaid/details 引用块） |
| 调试浏览器 | `--remote-debugging-port=9222` 启动的 Chrome/Edge，本机程序可经 CDP 读取页面与网络请求——用于"借用"登录态，不需要密码/cookie                                                     |

## 2. 决策树：先定抓哪个源

```
仓库是公开的、且内容与 app.devin.ai 账号侧一致就够用？
   ├─ 是（可接受 7 天旧缓存）→ deepwiki.com 公开抓取（无需登录；公开站脚本已归档移除，非本 SOP 主流程）
   └─ 否（默认）→ 走本 SOP：app.devin.ai 账号实时版 ↓

wiki 是否由你本人账号生成/可见？
   ├─ 是 → 标准流程（P1–P5）——推荐用 devin-wiki-capture.js 一键完成
   └─ 否（别人账号/私库）→ 需要该账号拥有者配合执行同一流程（凭据不出其浏览器）
```

## 3. 前置条件清单

- [ ] 本机 Node.js ≥ 18（内置 fetch/WebSocket）
- [ ] Chrome 或 Edge（支持 CDP 即可）
- [ ] 目标仓库在 Devin 账号内已生成 wiki（页面可打开、能看到左侧章节树）
- [ ] 网络可达 app.devin.ai

## 4. 标准流程（P1–P5，约 3 分钟）

### P1 启动调试浏览器

```powershell
# 关闭已打开的该浏览器进程后执行（隔离 profile 方式，不影响日常浏览器与登录）
chrome.exe --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\chrome-dw-debug"
```

```powershell
# Edge 用户
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\edge-dw-debug"
```

自检：浏览器访问 `http://127.0.0.1:9222/json/version` 能返回 JSON 即端口就绪。

### P2 登录（目标页面可以不用先打开）

1、在调试窗口登录 Devin（GitHub OAuth）；
2、保持窗口开启即可——目标 wiki 页无需事先打开，P3 运行后会向你索取链接并**自动打开**对应页面。

自检：调试窗口能正常浏览 app.devin.ai 即满足条件。

### P3 运行脚本 → 输入目标链接 → 自动抓取

以下命令均在项目根目录（`deepwiki-downloader/`）执行，脚本位于 `src/`：

```powershell
node "C:\Users\Your\Path\to\deepwiki-downloader\src\devin-wiki-capture.js"
```

脚本会先询问目标（交互式）：

```
请输入目标 Devin wiki 链接（或 owner/repo 简写，可含 ?branch=分支）：
  例1: https://app.devin.ai/org/xxx/wiki/owner/repo?branch=main
  例2: owner/repo
>
```

粘贴链接（或简写）回车后，脚本自动完成：解析 → 确认目标 → 找到或自动打开页面 → 刷新旁观真实请求 → 捕获会话鉴权头（仅内存）→ 拉取全量 → 落盘 → 输出验证摘要。页面会刷新一次，属正常。

```
目标已确认: owner/repo（branch=main）
输出目录: ...\wiki\repo-wiki-md
已找到打开的 wiki 页，直接使用        （或：自动开新标签页…）
刷新页面并旁观 API 请求…
已捕获会话鉴权头（仅本次进程内存使用）
commit: 4c2ac1ea | generated_at: 2026-09-03T12:50:23 | pages: 28
...
完成：30 个文件 → ...\wiki\repo-wiki-md
验证：代码围栏 110 ｜ mermaid 52 ｜ details 引用块 28 ｜ 总字符 185789
```

批处理/测试时也可用参数直传或管道输入（跳过询问）：

```powershell
node src\devin-wiki-capture.js owner/repo                                   # 参数式
node src\devin-wiki-capture.js owner/repo dev-branch D:\out\wiki-md          # 自定义分支/输出目录
"https://app.devin.ai/org/xxx/wiki/owner/repo?branch=main" | node src\devin-wiki-capture.js   # 管道式
```

自定义调试端口：`$env:CDP_PORT = "9223"; node src\devin-wiki-capture.js`

退出码约定：`0` 成功 · `2` 浏览器不在线/未启动 · `3` 鉴权头捕获超时 · `4` 接口失败 · `5` 目标输入无法解析 · `1` 其他。

### P4 验证清单（交付前必做）

- [ ] 文件数 = 章节数 + 2（repo-note.md + _index.md）
- [ ] `_index.md` 可打开，章节与网页侧边栏一一对应
- [ ] `_index.md` 头部 commit/generated_at 与 Devin 网页"Last indexed"一致
- [ ] 抽查 1 个含图章节：代码围栏（```mermaid）完整
- [ ] 抽查 1 个含代码章节：`<details>Relevant source files` 引用块存在
- [ ] 中文/特殊字符文件内容正常（用编辑器打开确认，勿信终端显示）

### P5 收尾与安全

- [ ] 关闭调试浏览器窗口（普通关闭即可，不影响日常浏览器）
- [ ] 会话 token（auth1_xxx）曾进入工具链：敏感环境可在 Devin 退出重登使其轮换
- [ ] 产物归档：建议按 `{REPO}-wiki-md\{commit前7位}\` 留存版本（同一仓库多次抓取时便于回溯）
- [ ] 若产物将用于写作/引用，记录 commit 与 generated_at（已写入 _index.md 头部）

## 5. 参数化复用矩阵

| 变更项 | 操作 |
| --- | --- |
| 换仓库 | 运行时直接输入新链接/简写即可（交互式）；参数式为 `node devin-wiki-capture.js owner/repo`——页面未打开会自动开 |
| 换分支 | 参数 2：`node devin-wiki-capture.js owner/repo dev-branch` |
| 换输出位置 | 参数 3 或改脚本 `OUT_DIR` 常量 |
| 换调试端口 | 环境变量 `CDP_PORT` |
| 多语言 | 接口返回 `wikis.{lang}`，脚本默认取 `en`；其余语言改脚本中 `langs.includes('en')` 逻辑 |
| 批量仓库 | 对每个仓库重复 P2–P3（脚本单仓单跑），或循环调用并传不同输出目录 |

## 6. 备选路径：无调试浏览器时（接口直调）

适用：不想开调试浏览器；或浏览器已关闭只剩已登录环境。此路径不依赖本工具脚本，直接调接口：

1、浏览器打开 wiki 页 → F12 → Network → 刷新 → 点任一 `/api/wiki/*` 请求 → 复制请求头中 `Authorization`（Bearer 后整串）与 `x-cog-org-id`；
2、用任意 HTTP 客户端带这两个头调用（一次请求即全量）：

```powershell
$h = @{ Authorization = "Bearer auth1_xxx..."; "x-cog-org-id" = "org-xxxxxxxxxxxxxxxxxxxxxxxx" }
$u = "https://app.devin.ai/api/wiki/get_full_multi_language_wiki?repo_name={owner}/{repo}&branch_name={branch}"
Invoke-RestMethod -Uri $u -Headers $h | ConvertTo-Json -Depth 20 | Out-File wiki-raw.json
# 然后按响应结构 wikis.en.pages[].content 拆分落盘（结构见记录文档 §3.5）
# 提示：{owner}/{repo} 需替换为实际值；若手写 URL，斜杠 / 在参数中要编码为 %2F（本工具脚本已自动处理）
```

3、token 有有效期（Auth0 轮换），过期后重复步骤 1 即可。

## 7. 故障排查表

| 现象 | 原因与处理 |
| --- | --- |
| 启动浏览器提示端口占用/打不开 | 原浏览器进程未退干净（含托盘驻留）。全退后重试，或换端口（`--remote-debugging-port=9223` + `$env:CDP_PORT=9223`） |
| 脚本退出码 2 | 调试浏览器未启动/不在线。回到 P1 确认启动命令与端口，P2 完成登录 |
| 脚本退出码 5 | 输入的目标链接无法解析。检查是否为完整 wiki URL（含 `/wiki/{owner}/{repo}`）或 `owner/repo` 简写 |
| 自动开的标签页空白/未登录 | 调试窗口未登录 Devin。回到 P2 登录后重跑；或手动在该窗口打开 wiki 页后再运行 |
| 页面刷新后长时间无输出、退出码 3 | 会话过期或页面未加载出章节。回到 P2 重新登录；或手动进入 wiki 页后再运行 |
| 输出 `Unauthenticated` 或 401 | token 过期或缺失头。手动路径重取 token；一键路径重登 Devin |
| commit 与网页不一致 | 抓到了公共/缓存版本。核对是否带会话头；确认匿名请求会回退公共版（commit 49d14c94 之类） |
| 产物缺章节/章节数变化 | 属正常——wiki 由 AI 按最新代码重新生成，章节结构随代码变化；以 _index.md 与网页侧边栏核对为准 |
| 中文乱码 | 终端显示问题：用 VS Code/Obsidian 打开确认文件为 UTF-8 即可 |
| 抓取被限流 | 接口为账号会话调用，频率极低（1 次全量）；若批量操作在两次运行间 sleep 数秒 |

## 8. 目录结构与资产说明

目录规范：**所有拉取产物统一放 `wiki/` 下**，一个仓库一个目录，命名 `{REPO}-wiki-md/`。

```
deepwiki-downloader\            ← 项目根
├── src\                        ← 代码
│   └── devin-wiki-capture.js   ← 一键自动版（现行唯一工具）
├── docs\                       ← 文档
│   ├── Devin Wiki下载-标准流程SOP.md   ← 本文档
│   └── DeepWiki抓取-工作流记录.md      ← 实战记录
├── wiki\                       ← 产物根目录（脚本默认输出至此，已 gitignore）
│   └── {REPO}-wiki-md\         ← 单仓库产物：章节 md + repo-note.md + _index.md
├── .gitignore
└── LICENSE
```

| 文件 | 用途 | 依赖 |
| --- | --- | --- |
| `src/devin-wiki-capture.js` | 一键自动版：交互询问链接 → CDP 捕获鉴权头 → 拉全量 → 落盘 `wiki/{REPO}-wiki-md/` → 验证摘要 | 调试浏览器在线；Node ≥ 18；零 npm 依赖 |

> 说明：早期的手动 token 版（download_devin_wiki.js）与 deepwiki.com 公开站脚本（download_deepwiki.js）已随精简移除；对应接口用法保留在 §6 与记录文档中。

## 9. 关键红线

1、**凭据不落盘**：token 只进环境变量或进程内存，脚本与产物文件中不得出现；
2、**内容版本可溯**：每次交付记录 commit + generated_at（脚本已写入 _index.md）；
3、**只抓自己有权限的内容**：借用的登录态属于你本人；他人私有 wiki 需其本人执行；
4、**交付前过 P4 清单**：版本核对是最容易出错的一环（本项目第一版即栽在抓错内容源上）。
