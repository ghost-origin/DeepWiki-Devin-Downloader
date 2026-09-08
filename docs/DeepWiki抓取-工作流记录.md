# DeepWiki 批量下载完整工作流与抓取路径记录

## 0. 重要更正（务必先读）

第一版方案（deepwiki.com 公开站批量下载）**已废弃**，原因：

1、`deepwiki.com` 是 DeepWiki 的**公开缓存站点**（约 7 天刷新一轮、只反映公开索引快照）；
2、`https://app.devin.ai/org/xxx/wiki/owner/repo?branch=main` 是**用户账号侧实时 wiki**（可随时触发刷新/重新生成，跟随 `branch=main` 最新代码）；
3、两者内容差异巨大：deepwiki.com 版只有 7 大章 23 页（旧代码结构，基于 commit 42187444），实时版为 **28 章全新结构**（commit 4c2ac1ea，含 `src/ai/`、`navigation_bot.py`、`combat_ai.py`、Kalman Filter、Testing & Benchmarking 等全部最新模块）。

用旧版内容写报告会直接产生事实错误。**本记录与产物均以 app.devin.ai 实时版为准**。
旧 deepwiki.com 版产物目录与公开站脚本已随清理删除（见 git/目录现状）；公开站方案要点保留在 §0 与 SOP §2 决策树中备查。

---

## 1. 目标与最终结论

把 Devin（app.devin.ai）账号内生成的 wiki 全部章节保存为本地原始 markdown。

**最终路径（一句话）**：在用户已登录的浏览器会话内请求官方接口
`GET /api/wiki/get_full_multi_language_wiki?repo_name={owner}/{repo}&branch_name={branch}`
```
——一个请求返回整个 wiki 全部 28 页的原始 markdown（含 ```mermaid、`<details>` 引用块、commit/generated_at 元数据），无需逐页抓取、无需 HTML 转换。
```

## 2. 为什么不能直接抓（约束分析）

| 约束 | 详情 |
| --- | --- |
| 页面形态 | app.devin.ai 是登录后 SPA：HTML 为空壳，正文由浏览器内 JS 带鉴权拉取 |
| 无导出 | 页面无"导出全部 md"按钮 |
| 沙箱限制 | 本机受限环境无法跑无头浏览器（命名管道被禁，Chrome/Edge 多进程崩溃）、命令行通道一度只读 |
| 接口鉴权 | `/api/wiki/*` 需要 `Authorization: Bearer <auth1_xxx>` + `x-cog-org-id` 头（仅 cookie 不够） |

因此正解是"**用户自己登录，工具隔着调试口读取**"，全程不索取 cookie/密码。

## 3. 抓取路径（完整实战时间线）

### 3.1 用户启动带调试端口的浏览器

```powershell
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\chrome-dw-debug"
```

用户在新窗口登录 Devin 并打开 wiki 页（保持窗口开启）。

### 3.2 CDP 侦察：确认页面与章节结构

- `GET http://127.0.0.1:9222/json/list` 找到 wiki 页面 target；
- 经 `Runtime.evaluate` 读取 DOM：`document.title` = `Wiki — owner/repo`，侧边栏章节树 29 个链接（`page/repo-note`、`page/1`、`page/1.1` … `page/8`，`?branch=main`）。

### 3.3 捕获数据接口：Network 事件

CDP `Network.enable` → `Page.reload` → 在 `Network.responseReceived`/`requestWillBeSent` 中看到 wiki 页面的真实数据请求：

```
GET /api/wiki/repo_note?repo_name={owner}/{repo}
GET /api/wiki/job_status?repo_name={owner}/{repo}&branch_name={branch}
GET /api/wiki/list_wiki_branches_for_repo?repo_name={owner}/{repo}
GET /api/wiki/list_wiki_repos_by_org_paginated?first=100
GET /api/wiki/get_full_multi_language_wiki?repo_name={owner}/{repo}&branch_name={branch}   ← 191 KB，全量！
```

请求头（关键两个）：

```
Authorization: Bearer auth1_xxxxxxxx
x-cog-org-id:   org-xxxxxxxxxxxxxxxxxxxxxxxx
```

### 3.4 验证接口语义

- 匿名（无头）访问同一接口：200，但返回**公共缓存索引**（commit `49d14c94`，9-05 生成，首章 "Overview"）；
- 带会话头访问：返回**账号侧索引**（commit `4c2ac1ea`，generated_at 2026-09-03T12:50:23，首章 "Project Overview"），与网页所见一致；
- 结论：**必须带会话头**，否则拿到的是另一个（公共）版本。抓取时以浏览器会话所见为准。

### 3.5 提取并落盘

响应结构（每页 content 即原始 markdown，可直接写 .md）：

```json
{ "wiki": { "wikis": { "en": {
    "metadata": { "repo_name": "...", "commit_hash": "4c2ac1ea", "generated_at": "2026-09-03T12:50:23.889580" },
    "pages": [ { "page_plan": { "id": "1", "title": "Project Overview" },
                 "content": "# Project Overview\n\n<details>...```mermaid...```..." } ] } } } }
```

落盘规则：每页 `{id}-{slug(title)}.md`；另抓 `repo_note` 存 `repo-note.md`；生成 `_index.md` 目录表。

### 3.6 产物验证

- 30 文件（28 页 + repo-note.md + _index.md）；
- 统计：110 个代码围栏、52 个 mermaid 图、28 个 `<details>` 源文件引用块、2 个文件含中文（repo-note 等）、总计约 18.6 万字符；
- 抽查页首 `# Project Overview` + `<details>` 引用块与网页一致。

## 4. 复现步骤（换仓库/换时间）

现行标准流程见《Devin Wiki下载-标准流程SOP.md》（P1–P5），要点：

1、启动调试浏览器并登录 Devin（P1–P2）；
2、运行一键脚本，按提示输入目标链接：

```powershell
node "C:\Users\Your\Path\to\deepwiki-downloader\src\devin-wiki-capture.js"
```

脚本自动完成：解析链接 → 找到/自动打开页面 → CDP 捕获会话鉴权头 → 拉取全量 → 落盘。
3、产物写入 `deepwiki-downloader\wiki\{REPO}-wiki-md\`（目录规范：所有拉取产物统一放 `wiki/` 下）。

## 5. 安全提醒

- `auth1_xxx` 是浏览器会话短期凭据，曾出现在本会话日志中——如在意，可在 Devin 里退出重登使其轮换；
- 脚本通过环境变量读 token，不写入任何文件；产物 md 中不含 token。

## 6. 关键知识点与陷阱

1、同一 DeepWiki 有"账号实时版（app.devin.ai）"与"公共缓存版（deepwiki.com）"两套内容源，**索引频率与内容都可能不同**，交付前必须验证 commit/generated_at；
2、SPA 页面无 SSR：正文一律走带鉴权的 XHR；找数据接口最直接的办法是 CDP Network 捕获，而不是猜 URL；
3、`/api/wiki/get_full_multi_language_wiki` 一次返回全量章节原文，是 DeepWiki 系最省请求的取数方式（deepwiki.com 版则是解析 Next.js RSC payload，原理类似）；
4、页面内裸 `fetch()` 会返回 `Unauthenticated`——该接口认 `Authorization` 头而非仅 cookie；匿名访问会静默回退到公共索引，务必用会话头并核对 commit；
5、CDP 编程注意：`ws.onmessage` 必须在 `send()` 之前注册，否则命令响应无人接收导致死锁；表达式含特殊字符时用模板字符串或 `String.raw` 构造；
6、`Runtime.evaluate` 配 `awaitPromise: true` 可直接在页面上下文跑异步 fetch；
7、文件写入前先确认目录归属：现行规范为 `wiki/{REPO}-wiki-md`（所有拉取产物统一放 `wiki/` 下）。

## 7. 接口参考代码

```js
/**
 * Devin Wiki（app.devin.ai）实时版批量下载器 —— 原始 markdown 全量版
 *
 * 数据源：app.devin.ai 账号侧实时 wiki（可随时刷新/重新生成），与 deepwiki.com
 * 公开缓存（约 7 天刷新一次）内容可能完全不同 —— 本脚本以账号侧为准。
 *
 * 接口（在登录会话内发现）：
 *   GET /api/wiki/get_full_multi_language_wiki?repo_name={owner}/{repo}&branch_name={branch}
 *     → { wiki: { wikis: { en: { metadata: {commit_hash, generated_at,...},
 *                              pages: [{ page_plan:{id,title}, content: <原始 markdown> }] } } } }
 *   GET /api/wiki/repo_note?repo_name={owner}/{repo}  → { content: md }
 * 一次请求即返回全部章节的原始 markdown（含 ```mermaid、<details> 引用块等），
 * 网页渲染反而会丢失部分信息，故直接取 API 原文。
 *
 * 鉴权：接口需要 Authorization: Bearer <token> 与 x-cog-org-id 头。
 * token 来自浏览器登录会话（DevTools Network 中任一 /api/wiki/* 请求即可复制）。
 * 为安全，token 不进代码：运行前设置环境变量。
 *
 * 用法（PowerShell）：
 *   $env:DEVIN_WIKI_TOKEN = "auth1_xxxx"                      # 会话 token
 *   $env:DEVIN_ORG_ID     = "org-xxxxxxxxxxxxxxxxxxxxxxxx"     # x-cog-org-id
 *   node download_devin_wiki.js
 *
 * 产物：{REPO}-wiki-md/ 下 {pageId}-{slug}.md × N + repo-note.md + _index.md
 */
const fs = require('fs');
const path = require('path');

const OWNER = 'owner';   // 替换为你的 GitHub 用户名/组织
const REPO = 'repo';     // 替换为你的仓库名
const BRANCH = 'main';
const OUT_DIR = path.join(__dirname, `${REPO}-wiki-md`);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

const TOKEN = process.env.DEVIN_WIKI_TOKEN;
const ORG_ID = process.env.DEVIN_ORG_ID;
if (!TOKEN || !ORG_ID) {
  console.error('缺少环境变量 DEVIN_WIKI_TOKEN / DEVIN_ORG_ID（从浏览器 Network 复制 /api/wiki/* 请求的 Authorization 与 x-cog-org-id）');
  process.exit(1);
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'x-cog-org-id': ORG_ID,
      'user-agent': UA,
    },
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return r.json();
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const enc = encodeURIComponent;
  const base = 'https://app.devin.ai/api/wiki/';
  const repoQ = `repo_name=${enc(OWNER + '/' + REPO)}`;

  // Repo Note（仓库笔记页）
  let noteContent = null;
  try {
    const note = await getJson(base + 'repo_note?' + repoQ);
    if (note && note.content) noteContent = note.content.trim() + '\n';
  } catch (e) { console.warn('repo_note 抓取失败（忽略）: ' + e.message); }

  // 全量 wiki（一次请求包含全部章节）
  const j = await getJson(base + 'get_full_multi_language_wiki?' + repoQ + '&branch_name=' + enc(BRANCH));
  const langs = j.wiki && j.wiki.wikis ? Object.keys(j.wiki.wikis) : [];
  if (!langs.includes('en')) throw new Error('响应中没有 en 语言 wiki: ' + langs.join(','));
  const w = j.wiki.wikis.en;
  const pages = w.pages || [];
  const meta = w.metadata || {};

  console.log('commit:', meta.commit_hash, '| generated_at:', meta.generated_at, '| pages:', pages.length);
  if (noteContent) { fs.writeFileSync(path.join(OUT_DIR, 'repo-note.md'), noteContent, 'utf8'); console.log('[ok] repo-note.md'); }

  const toc = ['# ' + `${OWNER}/${REPO} — Devin Wiki（实时版 · 原始 markdown）`, '',
    `> 来源: app.devin.ai 账号会话 API（get_full_multi_language_wiki，branch=${BRANCH}）`, '',
    `> commit: ${meta.commit_hash || '?'} ｜ generated_at: ${meta.generated_at || '?'}`, '',
    `> 共 ${pages.length} 页 + repo-note。每文件为对应章节 md 原文（含 mermaid/details）。`, '',
    '| # | 章节 | 文件 |', '| --- | --- | --- |'];
  let n = 0;
  for (const p of pages) {
    const id = p.page_plan.id;
    const file = id === 'repo-note' ? 'repo-note.md' : id + '-' + slugify(p.page_plan.title) + '.md';
    fs.writeFileSync(path.join(OUT_DIR, file), (p.content || '').trim() + '\n', 'utf8');
    toc.push(`| ${id} | ${p.page_plan.title.replace(/\|/g, '\\|')} | \`${file}\` |`);
    process.stdout.write(`[${++n}/${pages.length}] ${id} ${p.page_plan.title}\n`);
  }
  toc.push('| — | Repo Note | `repo-note.md` |');
  fs.writeFileSync(path.join(OUT_DIR, '_index.md'), toc.join('\n') + '\n', 'utf8');
  console.log('\n完成：' + fs.readdirSync(OUT_DIR).length + ' 个文件 → ' + OUT_DIR);
}

main().catch((e) => { console.error('出错:', e.message); process.exit(1); });
```

