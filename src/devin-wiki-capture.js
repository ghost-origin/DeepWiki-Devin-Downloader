/**
 * Devin Wiki 实时版一键抓取器（交互式 · 标准化工具）
 *
 * 运行后先向你索取目标 wiki 链接（或 owner/repo），解析确认后再抓取：
 *   1) 询问目标：支持完整链接或 owner/repo
 *      - 完整链接: https://app.devin.ai/org/xxx/wiki/owner/repo?branch=main
 *      - 简写:     owner/repo
 *   2) 连接本机调试浏览器（--remote-debugging-port=9222）
 *   3) 若浏览器未打开该 wiki 页，自动开新标签页并等待加载
 *   4) 刷新页面并在 Network 中旁观真实请求，捕获 /api/wiki/... 的鉴权头
 *      （Authorization / x-cog-org-id，来自你的登录会话，仅内存使用、不落盘）
 *   5) 以会话身份拉取全量 wiki（一次请求 = 全部章节的原始 markdown）
 *   6) 落盘 wiki/{REPO}-wiki-md/（章节 md + repo-note.md + _index.md）并输出验证摘要
 *
 * 前置条件（用户侧，约 1 分钟）：
 *   - 调试浏览器已启动并登录 Devin（保持开启）：
 *       chrome.exe --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\chrome-dw-debug"
 *     （或 Edge 同参；若用默认 profile 需先完全退出原浏览器）
 *   - 目标 wiki 页可以不用事先打开——脚本会自动开标签页
 *
 * 用法（交互式，推荐）：
 *   node devin-wiki-capture.js
 *   → 提示输入目标链接，回车后自动抓取
 *
 * 用法（参数式 / 批处理 / 测试）：
 *   node devin-wiki-capture.js owner/repo [branch] [输出目录]
 *   node devin-wiki-capture.js "https://app.devin.ai/org/xxx/wiki/owner/repo?branch=dev" [输出目录]
 *   管道输入亦可：echo "owner/repo" | node devin-wiki-capture.js
 *   环境变量：CDP_PORT=9222（默认）
 *
 * 退出码：0 成功；2 找不到 wiki 页面/浏览器不在线；3 鉴权头捕获超时；
 *         4 API 失败；5 目标输入无法解析；1 其他错误
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
// 项目根 = src/ 上一级（产物统一输出到根下的 wiki/）
const ROOT = path.join(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

let OWNER = null, REPO = null, BRANCH = 'main', OUT_DIR = null, OPEN_URL = null;

/* ---------------- 第 1 步：交互询问目标 ---------------- */

/** 解析用户输入 → {owner, repo, branch, openUrl?}，非法返回 null */
function parseTarget(input) {
  const s = (input || '').trim();
  if (!s) return null;
  // 完整 URL：/org/<orgSlug>/wiki/<owner>/<repo>?branch=xxx
  const m = s.match(/\/wiki\/([^/?#]+)\/([^/?#]+)/);
  if (m) {
    const owner = m[1], repo = m[2];
    const b = s.match(/[?&]branch=([^&#]+)/);
    const org = s.match(/\/org\/([^/]+)\//);
    return {
      owner, repo,
      branch: (b ? b[1] : BRANCH),
      openUrl: s.startsWith('http') ? s.split(/[?#]/)[0] + (b ? '?branch=' + b[1] : '') : null,
      orgSlug: org ? org[1] : owner,
    };
  }
  // 简写 owner/repo
  const p = s.split('/').filter(Boolean);
  if (p.length === 2 && !s.includes(' ')) {
    return { owner: p[0], repo: p[1], branch: BRANCH, openUrl: null, orgSlug: p[0] };
  }
  return null;
}

async function askTarget() {
  const question = (prompt) => new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => { rl.close(); res(ans); });
  });
  if (process.stdin.isTTY) {
    let raw = '';
    while (!raw) {
      raw = (await question(
        '请输入目标 Devin wiki 链接（或 owner/repo 简写，可含 ?branch=分支）：\n' +
        '  例1: https://app.devin.ai/org/xxx/wiki/owner/repo?branch=main\n' +
        '  例2: owner/repo\n> '
      )) || '';
      raw = raw.trim();
      if (!raw) console.log('（输入不能为空，请粘贴目标链接后回车）');
    }
    return raw;
  }
  // 非交互（管道/批处理）：读 stdin 第一行
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) return line.trim();
  return '';
}

/* ---------------- CDP 工具 ---------------- */

async function getTargets() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  return r.json();
}

function connectWS(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); return; }
      for (const h of handlers) { try { h(m); } catch (err) {} }
    };
    ws.onopen = () => resolve({
      ws,
      send: (method, params = {}) => new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
      onEvent: (fn) => handlers.push(fn),
      close: () => { try { ws.close(); } catch (e) {} },
    });
    ws.onerror = (e) => reject(new Error('CDP websocket: ' + (e.message || 'unknown')));
  });
}

/** 通过 CDP 刷新页面并旁观目标 API 请求，返回鉴权头 */
async function captureAuthHeaders(target) {
  const cdp = await connectWS(target.webSocketDebuggerUrl);
  const authPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('auth timeout')), 30000);
    cdp.onEvent((m) => {
      if (m.method === 'Network.requestWillBeSent') {
        const req = m.params.request;
        if (req.url.includes('get_full_multi_language_wiki')) {
          const h = req.headers || {};
          const auth = h.Authorization || h.authorization;
          if (auth) {
            clearTimeout(timer);
            resolve({ Authorization: auth, 'x-cog-org-id': h['x-cog-org-id'] || h['X-Cog-Org-Id'] || '' });
            cdp.close();
          }
        }
      }
    });
  });
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: false });
  return authPromise;
}

/** 浏览器里找到目标 wiki 页；没有则自动开新标签页 */
async function ensureWikiPage(targetInfo) {
  const wanted = `/wiki/${targetInfo.owner}/${targetInfo.repo}`;
  const targets = await getTargets();
  const hit = targets.find((p) => p.type === 'page' && (p.url || '').includes(wanted));
  if (hit) { console.log('已找到打开的 wiki 页，直接使用'); return hit; }
  console.log('调试浏览器未打开该 wiki 页，正在自动开新标签页…');
  const url = targetInfo.openUrl
    || `https://app.devin.ai/org/${targetInfo.orgSlug}/wiki/${targetInfo.owner}/${targetInfo.repo}?branch=${targetInfo.branch}`;
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('创建标签页失败 HTTP ' + r.status);
  const created = await r.json();
  console.log('新标签页已创建，等待页面加载（登录态自动带出）…');
  await new Promise((res) => setTimeout(res, 6000)); // 给 SPA 首屏时间
  return created;
}

/* ---------------- 抓取与落盘 ---------------- */

async function getJson(url, headers) {
  const r = await fetch(url, { headers: { ...headers, 'user-agent': UA }, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return r.json();
}

async function downloadAll(headers) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const enc = encodeURIComponent;
  const base = 'https://app.devin.ai/api/wiki/';
  const repoQ = `repo_name=${enc(OWNER + '/' + REPO)}`;

  let noteContent = null;
  try {
    const note = await getJson(base + 'repo_note?' + repoQ, headers);
    if (note && note.content) noteContent = note.content.trim() + '\n';
  } catch (e) { console.warn('(repo_note 跳过: ' + e.message + ')'); }

  const j = await getJson(base + 'get_full_multi_language_wiki?' + repoQ + '&branch_name=' + enc(BRANCH), headers);
  const langs = j.wiki && j.wiki.wikis ? Object.keys(j.wiki.wikis) : [];
  if (!langs.includes('en')) throw new Error('响应中没有 en 语言 wiki: ' + langs.join(','));
  const w = j.wiki.wikis.en;
  const pages = w.pages || [];
  const meta = w.metadata || {};

  console.log('来源接口: get_full_multi_language_wiki');
  console.log('commit:', meta.commit_hash, '| generated_at:', meta.generated_at, '| pages:', pages.length);

  if (noteContent) { fs.writeFileSync(path.join(OUT_DIR, 'repo-note.md'), noteContent, 'utf8'); console.log('[ok] repo-note.md'); }

  const toc = ['# ' + `${OWNER}/${REPO} — Devin Wiki（实时版 · 原始 markdown）`, '',
    `> 来源: app.devin.ai 账号会话 API（get_full_multi_language_wiki，branch=${BRANCH}）`, '',
    `> commit: ${meta.commit_hash || '?'} ｜ generated_at: ${meta.generated_at || '?'}`, '',
    `> 共 ${pages.length} 页 + repo-note。每文件为对应章节 md 原文（含 mermaid/details）。`, '',
    '| # | 章节 | 文件 |', '| --- | --- | --- |'];
  let n = 0;
  for (const p of pages) {
    const pid = p.page_plan.id;
    const file = pid + '-' + slugify(p.page_plan.title) + '.md';
    fs.writeFileSync(path.join(OUT_DIR, file), (p.content || '').trim() + '\n', 'utf8');
    toc.push(`| ${pid} | ${p.page_plan.title.replace(/\|/g, '\\|')} | \`${file}\` |`);
    process.stdout.write(`[${++n}/${pages.length}] ${pid} ${p.page_plan.title}\n`);
  }
  toc.push('| — | Repo Note | `repo-note.md` |');
  fs.writeFileSync(path.join(OUT_DIR, '_index.md'), toc.join('\n') + '\n', 'utf8');

  // 验证摘要
  const mdFiles = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.md') && f !== '_index.md');
  let fences = 0, mermaid = 0, details = 0, chars = 0;
  for (const f of mdFiles) {
    const s = fs.readFileSync(path.join(OUT_DIR, f), 'utf8');
    fences += (s.match(/^```/gm) || []).length;
    mermaid += (s.match(/^```mermaid/gm) || []).length;
    details += (s.match(/^<details>/gm) || []).length;
    chars += s.length;
  }
  console.log(`\n完成：${mdFiles.length + 1} 个文件 → ${OUT_DIR}`);
  console.log(`验证：代码围栏 ${fences} ｜ mermaid ${mermaid} ｜ details 引用块 ${details} ｜ 总字符 ${chars}`);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  // 第 1 步：索取目标
  const rawInput = process.argv[2] || (await askTarget());
  const target = parseTarget(rawInput);
  if (!target) {
    console.error('[退出码 5] 无法解析目标输入：' + rawInput + '\n请提供形如 https://app.devin.ai/org/xxx/wiki/owner/repo 的链接或 owner/repo');
    process.exit(5);
  }
  OWNER = target.owner;
  REPO = target.repo;
  BRANCH = process.argv[3] && !target.openUrl ? process.argv[3] : (target.branch || 'main');
  OUT_DIR = process.argv[4]
    ? path.resolve(process.argv[4])
    : path.join(ROOT, 'wiki', `${REPO}-wiki-md`);
  console.log(`目标已确认: ${OWNER}/${REPO}（branch=${BRANCH}）`);
  console.log(`输出目录: ${OUT_DIR}`);

  // 第 2 步：找/开页面
  let pageTarget;
  try {
    pageTarget = await ensureWikiPage(target);
  } catch (e) {
    console.error('[退出码 2] 无法连接调试浏览器（' + e.message + '）。请先启动: chrome.exe --remote-debugging-port=' + CDP_PORT + ' --user-data-dir=... 并登录');
    process.exit(2);
  }
  console.log('页面: ' + (pageTarget.url || '').slice(0, 120));

  // 第 3 步：刷新捕获鉴权头
  console.log('刷新页面并旁观 API 请求（页面会刷新一次，属正常）…');
  let headers;
  try {
    headers = await captureAuthHeaders(pageTarget);
  } catch (e) {
    console.error('[退出码 3] 鉴权头捕获失败（' + e.message + '）。请确认已在调试浏览器登录 Devin 且 wiki 页可正常阅读');
    process.exit(3);
  }
  console.log('已捕获会话鉴权头（仅本次进程内存使用）');

  // 第 4 步：拉取 + 落盘 + 验证
  try {
    await downloadAll(headers);
  } catch (e) {
    console.error('[退出码 4] ' + e.message);
    process.exit(4);
  }
  process.exit(0);
}

main().catch((e) => { console.error('[退出码 1]', e.message); process.exit(1); });
