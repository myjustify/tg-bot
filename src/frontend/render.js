// ============================================================
// 前端页面渲染 — 密码验证页 + 投稿列表页
// ============================================================

import { extractCookie, verifyAuthToken } from '../auth/auth.js';
import { listPosts } from '../storage/kv.js';
import { POST_DAYS } from '../utils/constants.js';

/**
 * 前端页面入口
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function renderPage(request, env) {
  // 检查 Cookie 是否已登录
  const token = extractCookie(request, 'auth');
  const isAuthed = token ? await verifyAuthToken(token, env) : false;

  if (isAuthed) {
    const posts = await listPosts(POST_DAYS, env);
    return new Response(renderPostList(posts), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  return new Response(renderPasswordForm(null), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * 密码验证失败后返回带错误信息的表单
 * @param {string} error
 * @returns {Response}
 */
export function renderPasswordError(error) {
  return new Response(renderPasswordForm(error), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ============================================================
// HTML 模板
// ============================================================

/**
 * 密码输入页
 * @param {string|null} error - 错误提示信息
 */
function renderPasswordForm(error) {
  const errorHtml = error
    ? `<p style="color: #e74c3c; margin-top: 1rem; font-size: 0.95rem;">${escapeHtml(error)}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>投稿统计 — 访问验证</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f0f2f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.08);
      padding: 2.5rem 2rem;
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    .card h1 {
      font-size: 1.5rem;
      color: #1a1a2e;
      margin-bottom: 0.5rem;
    }
    .card p {
      color: #666;
      font-size: 0.95rem;
      margin-bottom: 1.5rem;
    }
    input[type="password"] {
      width: 100%;
      padding: 0.75rem 1rem;
      border: 1px solid #d0d5dd;
      border-radius: 8px;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus {
      border-color: #4f46e5;
      box-shadow: 0 0 0 3px rgba(79,70,229,0.1);
    }
    button {
      width: 100%;
      margin-top: 1rem;
      padding: 0.75rem;
      background: #4f46e5;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #4338ca; }
    button:active { background: #3730a3; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔒 访问验证</h1>
    <p>请输入密码以查看投稿统计</p>
    <form method="POST" action="/">
      <input type="password" name="password" placeholder="请输入访问密码" required autofocus>
      <button type="submit">验证</button>
    </form>
    ${errorHtml}
  </div>
</body>
</html>`;
}

/**
 * 投稿列表页
 * @param {Array<object>} posts
 */
function renderPostList(posts) {
  const lightboxes = [];

  const rows = posts.length === 0
    ? '<tr><td colspan="6" style="text-align:center;padding:3rem;color:#999;">暂无投稿数据</td></tr>'
    : posts.map((p, postIdx) => {
        const time = new Date(p.timestamp).toLocaleString('zh-CN', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit',
        });
        const type = p.isAnonymous
          ? '<span style="color:#888;">🙈 匿名</span>'
          : '<span style="color:#4f46e5;">👤 实名</span>';
        const author = p.username
          ? `@${escapeHtml(p.username)}`
          : (p.firstName ? escapeHtml((p.firstName + ' ' + (p.lastName || '')).trim()) : String(p.userId));
        const caption = p.caption
          ? escapeHtml(p.caption.length > 80 ? p.caption.slice(0, 80) + '...' : p.caption)
          : '<span style="color:#bbb;">无</span>';
        const { cellHtml: mediaHtml, lbHtml } = buildMediaCell(p.media || [], postIdx);
        if (lbHtml) lightboxes.push(lbHtml);
        const safeKey = escapeHtml(p._key || '').replace(/'/g, '&#39;');

        return `<tr>
          <td>${time}</td>
          <td>${type}</td>
          <td>${author}</td>
          <td class="caption-cell">${caption}</td>
          <td class="media-cell">${mediaHtml}</td>
          <td class="action-cell"><button class="btn-del" onclick="deletePost('${safeKey}')" title="删除此投稿">🗑️</button></td>
        </tr>`;
      }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>投稿统计</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f0f2f5;
      color: #1a1a2e;
      min-height: 100vh;
      padding: 1rem;
    }
    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 2rem 1rem;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    header h1 { font-size: 1.5rem; }
    header span { color: #888; font-size: 0.9rem; }
    .table-wrapper {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.06);
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 600px;
    }
    th, td {
      padding: 0.85rem 1rem;
      text-align: left;
      border-bottom: 1px solid #eee;
      font-size: 0.9rem;
    }
    th {
      background: #fafbfc;
      color: #555;
      font-weight: 600;
      white-space: nowrap;
    }
    tr:hover td { background: #f8f9ff; }
    .caption-cell { max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .media-cell { white-space: nowrap; min-width: 80px; }
    .media-cell img { object-fit: cover; }
    .action-cell { text-align: center; }
    .btn-del {
      background: none;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      padding: 0.3rem 0.6rem;
      font-size: 0.9rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-del:hover { background: #fee; border-color: #e74c3c; }

    /* Lightbox 全屏图片查看 */
    .lightbox {
      display: none;
      position: fixed;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      background: rgba(0,0,0,0.92);
      z-index: 9999;
      justify-content: center;
      align-items: center;
    }
    .lightbox:target {
      display: flex;
    }
    .lightbox-img {
      max-width: 90vw;
      max-height: 90vh;
      object-fit: contain;
      border-radius: 8px;
      box-shadow: 0 4px 32px rgba(0,0,0,0.5);
    }
    .lightbox-close {
      position: absolute;
      top: 16px;
      right: 28px;
      color: #fff;
      font-size: 42px;
      font-weight: 300;
      text-decoration: none;
      line-height: 1;
      opacity: 0.8;
      transition: opacity 0.2s;
    }
    .lightbox-close:hover { opacity: 1; }

    @media (max-width: 768px) {
      .container { padding: 1rem 0.5rem; }
      th, td { padding: 0.65rem 0.6rem; font-size: 0.82rem; }
      .table-wrapper { border-radius: 8px; }
      header h1 { font-size: 1.2rem; }
      /* 在移动端隐藏文案列和素材列以节省空间 */
      .caption-cell, .media-cell, th:nth-child(4), th:nth-child(5) { display: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📊 投稿统计</h1>
      <span>近 7 天 · 共 ${posts.length} 条</span>
    </header>
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>投稿人</th>
            <th>文案</th>
            <th>素材</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    ${lightboxes.join('\n')}
  </div>
  <script>
    async function deletePost(key) {
      if (!confirm('确定要删除这条投稿吗？此操作不可撤销。')) return;
      try {
        const resp = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        if (resp.ok) {
          location.reload();
        } else {
          alert('删除失败，请重试');
        }
      } catch {
        alert('网络错误，请重试');
      }
    }
    // 每 60 秒自动刷新（Lightbox 打开时暂停计时）
    let refreshPaused = false, refreshTimer;
    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      if (!refreshPaused) {
        refreshTimer = setTimeout(() => location.reload(), 60000);
      }
    }
    window.addEventListener('hashchange', () => {
      if (window.location.hash.startsWith('#lb-')) {
        refreshPaused = true;
        clearTimeout(refreshTimer);
      } else {
        refreshPaused = false;
        scheduleRefresh();
      }
    });
    scheduleRefresh();
  </script>
</body>
</html>`;
}

/**
 * 构建素材缩略图 HTML
 * @param {Array<{type: string, file_id: string}>} media
 */
/**
 * 构建素材缩略图 HTML（返回 cell 和 lightbox 两部分）
 * @param {Array<{type: string, file_id: string}>} media
 * @param {number} postIdx - 投稿索引，用于生成唯一 lightbox id
 * @returns {{cellHtml: string, lbHtml: string}}
 */
function buildMediaCell(media, postIdx) {
  if (!media || media.length === 0) {
    return { cellHtml: '<span style="color:#bbb;">—</span>', lbHtml: '' };
  }
  const maxShow = 3;
  const photos = media.filter((m) => m.type === 'photo');
  const otherCount = media.length - photos.length;

  let cellHtml = '';
  let lbHtml = '';
  const showPhotos = photos.slice(0, maxShow);
  for (let i = 0; i < showPhotos.length; i++) {
    const p = showPhotos[i];
    if (!p.file_id) continue;
    const imgUrl = `/api/image?file_id=${encodeURIComponent(p.file_id)}`;
    const lbId = `lb-${postIdx}-${i}`;
    cellHtml += `<a href="#${lbId}"><img src="${imgUrl}" style="max-height:120px;max-width:180px;border-radius:6px;margin-right:4px;vertical-align:middle;object-fit:cover;cursor:pointer;" loading="lazy" alt="" title="点击放大查看"></a>`;
    lbHtml += `<div id="${lbId}" class="lightbox"><a href="#" class="lightbox-close" title="关闭">&times;</a><img src="${imgUrl}" class="lightbox-img" alt=""></div>`;
  }
  const extra = photos.length - maxShow + otherCount;
  if (extra > 0) {
    cellHtml += `<span style="font-size:0.78rem;color:#888;">+${extra}</span>`;
  }
  if (photos.length === 0 && otherCount > 0) {
    cellHtml += `<span style="font-size:0.78rem;color:#666;">${media.map((m) => m.type).slice(0, 3).join(', ')}</span>`;
  }
  return { cellHtml: cellHtml || '<span style="color:#bbb;">—</span>', lbHtml };
}

/**
 * HTML 转义（防 XSS）
 */
function escapeHtml(str) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(str).replace(/[&<>"']/g, (c) => map[c]);
}
