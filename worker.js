// ==================== 常量配置 ====================

const CONTENT_TYPE_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  webm: 'video/webm'
};

const CACHE_CONFIG = {
  HTML: 3600,
  IMAGE: 86400,
  API: 300
};

const MAX_SNAPSHOT_LIMIT = 100;
const TG_MAX_FILE_SIZE = 45 * 1024 * 1024; // 45MB Telegram 限制

// ==================== 工具函数 ====================

function extractConfig(env) {
  return {
    domain: env.DOMAIN,
    database: env.DATABASE,
    username: env.USERNAME,
    password: env.PASSWORD,
    adminPath: env.ADMIN_PATH,
    enableAuth: env.ENABLE_AUTH === 'true',
    tgBotToken: env.TG_BOT_TOKEN,
    tgChatId: env.TG_CHAT_ID,
    maxSize: (env.MAX_SIZE_MB ? parseInt(env.MAX_SIZE_MB, 10) : 20) * 1024 * 1024
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function unauthorizedResponse() {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Admin"' }
  });
}

function createCachedResponse(body, contentType, cacheMaxAge) {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${cacheMaxAge}`,
      'CDN-Cache-Control': `public, max-age=${cacheMaxAge}`
    }
  });
}

function getFileExtension(url) {
  return url.split('.').pop().toLowerCase();
}

function getContentType(extension) {
  return CONTENT_TYPE_MAP[extension] || 'application/octet-stream';
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

function authenticate(request, username, password) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Basic ')) return false;
  try {
    const [user, pass] = atob(authHeader.split(' ')[1]).split(':');
    return user === username && pass === password;
  } catch {
    return false;
  }
}

function requireAuth(handler) {
  return async (request, config) => {
    if (config.enableAuth && !authenticate(request, config.username, config.password)) {
      return unauthorizedResponse();
    }
    return handler(request, config);
  };
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}: ${await res.text()}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function extractFileId(result) {
  return (
    result.video?.file_id ??
    result.document?.file_id ??
    result.sticker?.file_id ??
    result.photo?.at(-1)?.file_id ??
    null
  );
}

async function getTelegramFilePath(tgBotToken, fileId) {
  const res = await fetchWithRetry(
    `https://api.telegram.org/bot${tgBotToken}/getFile?file_id=${fileId}`
  );
  const data = await res.json();
  if (!data.ok || !data.result?.file_path) throw new Error('无法获取 Telegram 文件路径');
  return data.result.file_path;
}

// ==================== 路由入口 ====================

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const config = extractConfig(env);

    const routes = [
      ['/', null, handleRootRequest],
      [`/${config.adminPath}`, null, requireAuth(handleAdminRequest)],
      ['/upload', 'POST', requireAuth(handleUploadRequest)],
      ['/bing-images', 'GET', handleBingImagesRequest],
      ['/delete-images', 'POST', requireAuth(handleDeleteImagesRequest)],
      ['/api/snapshot/upload', 'POST', requireAuth(handleSnapshotUpload)],
      ['/api/snapshot/get', 'GET', requireAuth(handleSnapshotGet)],
      ['/api/snapshot/recent', 'GET', requireAuth(handleSnapshotRecent)],
      ['/api/snapshot/delete', null, requireAuth(handleSnapshotDelete)],
    ];

    for (const [path, method, handler] of routes) {
      if (pathname !== path) continue;
      if (method && request.method !== method) {
        return new Response('Method Not Allowed', { status: 405 });
      }
      return handler(request, config);
    }

    // 默认：图片资源请求
    return handleImageRequest(request, config);
  }
};

// ==================== 页面：上传首页 ====================

async function handleRootRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config.username, config.password)) {
    return unauthorizedResponse();
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url);
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const response = createCachedResponse(getUploadPageHtml(), 'text/html;charset=UTF-8', CACHE_CONFIG.HTML);
  await cache.put(cacheKey, response.clone());
  return response;
}

// ==================== 页面：管理后台 ====================

async function handleAdminRequest(request, config) {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  return generateAdminPage(config.database, page);
}

async function generateAdminPage(DATABASE, page = 1) {
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  const [totalResult, mediaData] = await Promise.all([
    DATABASE.prepare('SELECT COUNT(*) as count FROM media').first(),
    fetchMediaData(DATABASE, pageSize, offset)
  ]);

  const totalCount = totalResult.count;
  const totalPages = Math.ceil(totalCount / pageSize);

  const mediaHtml = mediaData.map(({ url }) => {
    const ext = url.split('.').pop().toLowerCase();
    const timestamp = url.split('/').pop().split('.')[0];
    const escapedUrl = escapeHtml(url);
    const supportedImages = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg'];
    const supportedVideos = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm'];
    const isImage = supportedImages.includes(ext);
    const isVideo = supportedVideos.includes(ext);
    const uploadTime = escapeHtml(
      new Date(parseInt(timestamp)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    );

    return `
    <div class="media-container" data-key="${escapedUrl}" onclick="toggleImageSelection(this)">
      <div class="skeleton"></div>
      <div class="media-type">${escapeHtml(ext)}</div>
      ${isVideo
        ? `<video class="gallery-video" preload="none" controls>
             <source data-src="${escapedUrl}" type="video/${escapeHtml(ext)}">
           </video>`
        : isImage
          ? `<img class="gallery-image lazy" data-src="${escapedUrl}" alt="Image">`
          : `<div class="file-icon">📁</div>`
      }
      <div class="upload-time">上传时间: ${uploadTime}</div>
    </div>`;
  }).join('');

  const html = getAdminPageHtml({ totalCount, page, totalPages, mediaHtml, hasMedia: mediaData.length > 0 });
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function fetchMediaData(DATABASE, limit = null, offset = 0) {
  let query = 'SELECT url, fileId FROM media ORDER BY url DESC';
  if (limit !== null) query += ` LIMIT ${limit} OFFSET ${offset}`;
  const result = await DATABASE.prepare(query).all();
  return result.results.map(row => ({ fileId: row.fileId, url: row.url }));
}

// ==================== 上传文件 ====================

async function handleUploadRequest(request, config) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) return jsonResponse({ error: '缺少文件' }, 400);

    if (file.size > config.maxSize) {
      return jsonResponse({ error: `文件大小超过 ${config.maxSize / (1024 * 1024)}MB 限制` }, 413);
    }

    const uploadFormData = new FormData();
    uploadFormData.append('chat_id', config.tgChatId);

    if (file.type === 'image/gif') {
      const newFile = new File([file], file.name.replace(/\.gif$/i, '.jpeg'), { type: 'image/jpeg' });
      uploadFormData.append('document', newFile);
    } else {
      uploadFormData.append('document', file);
    }

    const tgRes = await fetchWithRetry(
      `https://api.telegram.org/bot${config.tgBotToken}/sendDocument`,
      { method: 'POST', body: uploadFormData }
    );

    const tgData = await tgRes.json();
    const fileId = extractFileId(tgData.result);
    if (!fileId) throw new Error('Telegram 返回数据中未包含 file_id');

    const ext = getFileExtension(file.name);
    const timestamp = Date.now();
    const imageURL = `https://${config.domain}/${timestamp}.${ext}`;

    await config.database.prepare(
      'INSERT INTO media (url, fileId, created_at) VALUES (?, ?, ?) ON CONFLICT(url) DO NOTHING'
    ).bind(imageURL, fileId, timestamp).run();

    return jsonResponse({ data: imageURL });
  } catch (error) {
    console.error('上传失败:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// ==================== 图片资源代理 ====================

async function handleImageRequest(request, config) {
  const cache = caches.default;
  const cacheKey = new Request(request.url);

  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const result = await config.database
    .prepare('SELECT fileId FROM media WHERE url = ?')
    .bind(request.url)
    .first();

  if (!result) {
    return new Response('资源不存在', { status: 404 });
  }

  let filePath;
  try {
    filePath = await getTelegramFilePath(config.tgBotToken, result.fileId);
  } catch {
    return new Response('未找到 FilePath', { status: 404 });
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${config.tgBotToken}/${filePath}`);
  if (!fileRes.ok) return new Response('获取文件内容失败', { status: 502 });

  const ext = getFileExtension(request.url);
  const headers = new Headers(fileRes.headers);
  headers.set('Content-Type', getContentType(ext));
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', `public, max-age=${CACHE_CONFIG.IMAGE}`);
  headers.set('CDN-Cache-Control', `public, max-age=${CACHE_CONFIG.IMAGE}`);

  const responseToCache = new Response(fileRes.body, { status: fileRes.status, headers });
  await cache.put(cacheKey, responseToCache.clone());
  return responseToCache;
}

// ==================== Bing 背景图 ====================

async function handleBingImagesRequest(request, config) {
  const cache = caches.default;
  const cacheKey = new Request('https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5');

  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const res = await fetch(cacheKey);
  if (!res.ok) return new Response('请求 Bing API 失败', { status: res.status });

  const bingData = await res.json();
  const images = bingData.images.map(img => ({ url: `https://cn.bing.com${img.url}` }));

  const response = createCachedResponse(
    JSON.stringify({ status: true, message: '操作成功', data: images }),
    'application/json',
    CACHE_CONFIG.API
  );
  await cache.put(cacheKey, response.clone());
  return response;
}

// ==================== 删除媒体 ====================

async function handleDeleteImagesRequest(request, config) {
  let keysToDelete;
  try {
    keysToDelete = await request.json();
  } catch {
    return jsonResponse({ error: '请求体格式错误' }, 400);
  }

  if (!Array.isArray(keysToDelete) || keysToDelete.length === 0) {
    return jsonResponse({ error: '没有要删除的项' }, 400);
  }

  const validKeys = keysToDelete.filter(k => typeof k === 'string' && k.length > 0);
  if (validKeys.length === 0) return jsonResponse({ error: '无效的删除列表' }, 400);

  const placeholders = validKeys.map(() => '?').join(',');

  const dbResult = await config.database
    .prepare(`DELETE FROM media WHERE url IN (${placeholders})`)
    .bind(...validKeys)
    .run();

  if (dbResult.changes === 0) {
    return jsonResponse({ message: '未找到要删除的项' }, 404);
  }

  const cache = caches.default;
  Promise.allSettled(validKeys.map(url => cache.delete(new Request(url))));

  return jsonResponse({ message: '删除成功', deleted: dbResult.changes });
}

// ==================== Snapshot API ====================

async function handleSnapshotUpload(request, config) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '请求体必须为合法 JSON' }, 400);
  }

  const { prompt_hash, image_url, image_base64 } = body;
  if (!prompt_hash) return jsonResponse({ error: '缺少 prompt_hash 参数' }, 400);

  let imageBuffer;
  let contentType = 'image/png';

  if (image_url) {
    let fetchRes;
    try {
      fetchRes = await fetchWithRetry(image_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ImageWorker/1.0)' }
      });
    } catch (e) {
      return jsonResponse({ error: `下载图片失败: ${e.message}` }, 502);
    }

    const contentLength = fetchRes.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 100 * 1024 * 1024) {
      return jsonResponse({ error: '图片源文件超过 100MB，请压缩后再试' }, 413);
    }

    imageBuffer = await fetchRes.arrayBuffer();
    contentType = fetchRes.headers.get('content-type')?.split(';')[0] || 'image/png';

  } else if (image_base64) {
    const matches = image_base64.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return jsonResponse({ error: '无效的 Base64 格式' }, 400);
    contentType = matches[1];
    try {
      const binary = atob(matches[2]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      imageBuffer = bytes.buffer;
    } catch {
      return jsonResponse({ error: 'Base64 解码失败' }, 400);
    }
  } else {
    return jsonResponse({ error: '必须提供 image_url 或 image_base64' }, 400);
  }

  if (imageBuffer.byteLength > TG_MAX_FILE_SIZE) {
    return jsonResponse({
      error: `图片大小 ${(imageBuffer.byteLength / 1024 / 1024).toFixed(1)}MB 超过 Telegram 45MB 限制，请在客户端压缩后再上传`
    }, 413);
  }

  const timestamp = Date.now();
  const fileName = `${timestamp}.png`;
  const blob = new Blob([imageBuffer], { type: contentType });

  const formData = new FormData();
  formData.append('chat_id', config.tgChatId);
  formData.append('document', blob, fileName);

  let tgRes;
  try {
    tgRes = await fetchWithRetry(
      `https://api.telegram.org/bot${config.tgBotToken}/sendDocument`,
      { method: 'POST', body: formData }
    );
  } catch (e) {
    return jsonResponse({ error: `Telegram 上传失败: ${e.message}` }, 502);
  }

  const tgData = await tgRes.json();
  const fileId = extractFileId(tgData.result);
  if (!fileId) return jsonResponse({ error: '未获取到 Telegram file_id' }, 500);

  const imageUrl = `https://${config.domain}/${timestamp}.png`;

  await config.database.prepare(
    `INSERT INTO media (url, fileId, prompt_hash, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET prompt_hash = excluded.prompt_hash`
  ).bind(imageUrl, fileId, prompt_hash, timestamp).run();

  return jsonResponse({ url: imageUrl });
}

async function handleSnapshotGet(request, config) {
  const url = new URL(request.url);
  const promptHash = url.searchParams.get('prompt_hash');
  if (!promptHash) return jsonResponse({ error: '缺少 prompt_hash 参数' }, 400);

  const result = await config.database
    .prepare('SELECT url FROM media WHERE prompt_hash = ? ORDER BY created_at DESC LIMIT 1')
    .bind(promptHash)
    .first();

  if (!result) return jsonResponse({ found: false }, 404);
  return jsonResponse({ found: true, url: result.url });
}

async function handleSnapshotRecent(request, config) {
  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get('limit') || '5', 10)),
    MAX_SNAPSHOT_LIMIT
  );

  const results = await config.database
    .prepare('SELECT url, prompt_hash, created_at FROM media ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all();

  return jsonResponse({
    snapshots: results.results.map(r => ({
      url: r.url,
      prompt_hash: r.prompt_hash,
      created_at: r.created_at
    }))
  });
}

async function handleSnapshotDelete(request, config) {
  let urlToDelete;
  if (request.method === 'DELETE') {
    urlToDelete = new URL(request.url).searchParams.get('url');
  } else if (request.method === 'POST') {
    try {
      const body = await request.json();
      urlToDelete = body.url;
    } catch {
      return jsonResponse({ error: '请求体格式错误' }, 400);
    }
  } else {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!urlToDelete || typeof urlToDelete !== 'string') {
    return jsonResponse({ error: '缺少或无效的 url 参数' }, 400);
  }

  const result = await config.database
    .prepare('DELETE FROM media WHERE url = ?')
    .bind(urlToDelete)
    .run();

  caches.default.delete(new Request(urlToDelete));

  if (result.changes === 0) return jsonResponse({ message: '未找到记录' }, 404);
  return jsonResponse({ message: '删除成功' });
}

// ==================== HTML 模板（完整内容） ====================

function getUploadPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="Telegraph图床-基于Workers的图床服务">
<meta name="keywords" content="Telegraph图床,Workers图床, Cloudflare, Workers,telegra.ph, 图床">
<title>Telegraph图床-基于Workers的图床服务</title>
<link rel="icon" href="https://p1.meituan.net/csc/c195ee91001e783f39f41ffffbbcbd484286.ico" type="image/x-icon">
<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
<link rel="dns-prefetch" href="https://cdnjs.cloudflare.com">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/4.6.1/css/bootstrap.min.css" integrity="sha512-T584yQ/tdRR5QwOpfvDfVQUidzfgc2339Lc8uBDtcp/wYu80d7jwBgAxbyMh0a9YM9F8N3tdErpFI8iaGx6x5g==" crossorigin="anonymous" referrerpolicy="no-referrer" />
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-fileinput/5.2.7/css/fileinput.min.css" integrity="sha512-qPjB0hQKYTx1Za9Xip5h0PXcxaR1cRbHuZHo9z+gb5IgM6ZOTtIH4QLITCxcCp/8RMXtw2Z85MIZLv6LfGTLiw==" crossorigin="anonymous" referrerpolicy="no-referrer" />
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/toastr.js/2.1.4/toastr.min.css" integrity="sha512-6S2HWzVFxruDlZxI3sXOZZ4/eJ8AcxkQH1+JjSe/ONCEqR9L4Ysq5JdT5ipqtzU7WHalNwzwBv+iE51gNHJNqQ==" crossorigin="anonymous" referrerpolicy="no-referrer" />
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.4/css/all.min.css" integrity="sha512-1ycn6IcaQQ40/MKBW2W4Rhis/DbILU74C1vSrLJxCq57o941Ym01SwNsOMqvEBFlcgUa6xLiPY/NS5R+E6ztJQ==" crossorigin="anonymous" referrerpolicy="no-referrer" />
<style>
    body {
        margin: 0;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        position: relative;
    }
    .background {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-size: cover;
        z-index: -1;
        transition: opacity 1s ease-in-out;
        opacity: 1;
    }
    .card {
        background-color: rgba(255, 255, 255, 0.9);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border: none;
        border-radius: 16px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        padding: 30px;
        width: 90%;
        max-width: 480px;
        text-align: center;
        margin: 0 auto;
        position: relative;
    }
    .title {
        font-size: 28px;
        font-weight: 700;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        margin-bottom: 20px;
        letter-spacing: 0.5px;
    }
    .uniform-height {
        margin-top: 20px;
    }
    #viewCacheBtn {
        position: absolute;
        top: 15px;
        right: 15px;
        background: none;
        border: none;
        color: rgba(102, 126, 234, 0.5);
        cursor: pointer;
        font-size: 22px;
        transition: all 0.3s ease;
    }
    #viewCacheBtn:hover {
        color: #667eea;
        transform: scale(1.1);
    }
    #compressionToggleBtn {
        position: absolute;
        top: 15px;
        right: 55px;
        background: none;
        border: none;
        color: rgba(102, 126, 234, 0.5);
        cursor: pointer;
        font-size: 22px;
        transition: all 0.3s ease;
    }
    #compressionToggleBtn:hover {
        color: #667eea;
        transform: scale(1.1);
    }
    #cacheContent {
        margin-top: 20px;
        max-height: 250px;
        border-radius: 8px;
        overflow-y: auto;
    }
    .cache-title {
        text-align: left;
        margin-bottom: 10px;
    }
    .cache-item {
        display: block;
        cursor: pointer;
        border-radius: 8px;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
        transition: all 0.3s ease;
        text-align: left;
        padding: 12px 15px;
        margin-bottom: 8px;
        background: white;
        border: 1px solid rgba(102, 126, 234, 0.1);
    }
    .cache-item:hover {
        background-color: rgba(102, 126, 234, 0.05);
        border-color: rgba(102, 126, 234, 0.3);
        transform: translateX(5px);
    }
    .upload-hint {
        color: #999;
        font-size: 14px;
        margin-top: 15px;
        line-height: 1.6;
    }
    .upload-hint i {
        color: #667eea;
        margin-right: 5px;
    }
    .project-link {
        font-size: 14px;
        text-align: center;
        margin-top: 15px;
        margin-bottom: 0;
        color: #999;
        line-height: 1.6;
    }
    .project-link a {
        color: #667eea;
        text-decoration: none;
        transition: color 0.3s ease;
    }
    .project-link a:hover {
        color: #764ba2;
        text-decoration: underline;
    }
    textarea.form-control {
        max-height: 200px;
        overflow-y: hidden;
        resize: none;
    }
    .upload-progress {
        display: none;
        margin-top: 15px;
        text-align: center;
    }
    .progress-text {
        font-size: 14px;
        font-weight: 500;
        color: #667eea;
        letter-spacing: 0.5px;
    }
    .thumbnail-container {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 15px;
        justify-content: center;
    }
    .thumbnail-item {
        position: relative;
        width: 80px;
        height: 80px;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        transition: transform 0.2s ease;
    }
    .thumbnail-item:hover {
        transform: scale(1.05);
    }
    .thumbnail-item img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .thumbnail-item video {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .thumbnail-item .file-icon {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        font-size: 24px;
    }
    .thumbnail-item .remove-btn {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.6);
        color: white;
        border: none;
        cursor: pointer;
        font-size: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.2s ease;
    }
    .thumbnail-item:hover .remove-btn {
        opacity: 1;
    }
    .btn-primary {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
        border: none !important;
        color: white !important;
        border-radius: 8px !important;
        font-weight: 500 !important;
        transition: all 0.3s ease !important;
        box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3) !important;
    }
    .btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4) !important;
    }
    .btn-primary:active, .btn-primary:focus {
        transform: translateY(0);
        box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3) !important;
    }
    .file-drop-zone {
        border: 2px dashed #667eea !important;
        border-radius: 12px !important;
        background: rgba(102, 126, 234, 0.05) !important;
        transition: all 0.3s ease !important;
    }
    .file-drop-zone:hover {
        border-color: #764ba2 !important;
        background: rgba(102, 126, 234, 0.1) !important;
    }
    .file-drop-zone-title {
        color: #667eea !important;
        font-weight: 500 !important;
    }
    .btn-danger, .fileinput-remove {
        border-radius: 8px !important;
        font-weight: 500 !important;
        transition: all 0.3s ease !important;
    }
    .btn-danger:hover, .fileinput-remove:hover {
        transform: translateY(-2px);
    }
    .btn-danger:active, .fileinput-remove:active {
        transform: translateY(0);
    }
    .btn-light {
        border-radius: 8px !important;
        font-weight: 500 !important;
        transition: all 0.3s ease !important;
    }
    .btn-light:hover {
        transform: translateY(-2px);
    }
    .btn-light:active {
        transform: translateY(0);
    }
    @media (max-width: 768px) {
        .card {
            width: 95%;
            max-width: 100%;
            padding: 20px;
            border-radius: 12px;
        }
        .title {
            font-size: 24px;
        }
        #viewCacheBtn, #compressionToggleBtn {
            font-size: 20px;
        }
        .btn-primary, .btn-danger, .btn-light {
            min-height: 44px;
            min-width: 44px;
        }
        .cache-item {
            padding: 15px;
        }
    }
</style>
</head>
<body>
<div class="background" id="background"></div>
<div class="card">
    <div class="title">Telegraph图床</div>
    <button type="button" class="btn" id="viewCacheBtn" title="查看历史记录"><i class="fas fa-clock"></i></button>
    <button type="button" class="btn" id="compressionToggleBtn"><i class="fas fa-compress"></i></button>
    <div class="card-body">
        <form id="uploadForm" action="/upload" method="post" enctype="multipart/form-data">
            <div class="file-input-container">
                <input id="fileInput" name="file" type="file" class="form-control-file" data-browse-on-zone-click="true" multiple>
            </div>
            <div class="upload-hint">
                <i class="fas fa-info-circle"></i>支持拖拽上传 · 多文件上传 · Ctrl+V 粘贴上传
            </div>
            <div class="form-group mb-3 uniform-height" style="display: none;">
                <button type="button" class="btn btn-light mr-2" id="urlBtn">URL</button>
                <button type="button" class="btn btn-light mr-2" id="bbcodeBtn">BBCode</button>
                <button type="button" class="btn btn-light" id="markdownBtn">Markdown</button>
            </div>
            <div class="form-group mb-3 uniform-height" style="display: none;">
                <textarea class="form-control" id="fileLink" readonly></textarea>
            </div>
            <div class="upload-progress" id="uploadProgress">
                <div class="progress-text" id="progressText">上传中... 0%</div>
            </div>
            <div class="thumbnail-container" id="thumbnailContainer"></div>
            <div id="cacheContent" style="display: none;"></div>
        </form>
    </div>
    <p class="project-link">项目开源于 GitHub - <a href="https://github.com/0-RTT/telegraph" target="_blank" rel="noopener noreferrer">0-RTT/telegraph</a></p>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js" integrity="sha512-894YE6QWD5I59HgZOGReFYm4dnWc1Qt5NtvYSaNcOP+u1T9qYdvdihz0PPSiiqn/+/3e7Jo4EaG7TubfWGUrMQ==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-fileinput/5.2.7/js/fileinput.min.js" integrity="sha512-CCLv901EuJXf3k0OrE5qix8s2HaCDpjeBERR2wVHUwzEIc7jfiK9wqJFssyMOc1lJ/KvYKsDenzxbDTAQ4nh1w==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-fileinput/5.2.7/js/locales/zh.min.js" integrity="sha512-IizKWmZY3aznnbFx/Gj8ybkRyKk7wm+d7MKmEgOMRQDN1D1wmnDRupfXn6X04pwIyKFWsmFVgrcl0j6W3Z5FDQ==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/toastr.js/2.1.4/toastr.min.js" integrity="sha512-lbwH47l/tPXJYG9AcFNoJaTMhGvYWhVM9YI43CT+uteTRRaiLCui8snIgyAN8XWgNjNhCqlAUdzZptso6OCoFQ==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
    <script>
    function formatLinks(urls, format) {
      switch (format) {
        case 'url': return urls.join('\\n\\n');
        case 'bbcode': return urls.map(url => '[img]' + url + '[/img]').join('\\n\\n');
        case 'markdown': return urls.map(url => '![image](' + url + ')').join('\\n\\n');
        default: return urls.join('\\n');
      }
    }

    async function fetchBingImages() {
      try {
        const response = await fetch('/bing-images');
        if (!response.ok) throw new Error('获取背景图片失败');
        const data = await response.json();
        return data.data?.map(image => image.url) || [];
      } catch (error) {
        console.error('获取Bing背景图片失败:', error);
        return [];
      }
    }

    async function setBackgroundImages() {
      const images = await fetchBingImages();
      if (images.length === 0) return;
      const bg1 = document.getElementById('background');
      const bg2 = document.createElement('div');
      bg2.className = 'background';
      bg2.style.opacity = 0;
      document.body.insertBefore(bg2, bg1.nextSibling);
      let index = 0;
      let currentBg = bg1;
      let nextBg = bg2;
      bg1.style.backgroundImage = 'url(' + images[0] + ')';
      setInterval(() => {
        index = (index + 1) % images.length;
        nextBg.style.backgroundImage = 'url(' + images[index] + ')';
        nextBg.style.opacity = 0;
        setTimeout(() => { nextBg.style.opacity = 1; currentBg.style.opacity = 0; }, 50);
        setTimeout(() => { [currentBg, nextBg] = [nextBg, currentBg]; }, 1000);
      }, 5000);
    }
  
    $(document).ready(function() {
      let originalImageURLs = [];
      let thumbnailData = [];
      let isCacheVisible = false;
      let enableCompression = true;
      initFileInput();
      setBackgroundImages();
  
      $('#compressionToggleBtn').attr('title', '关闭压缩').on('click', function() {
          enableCompression = !enableCompression;
          $(this).find('i').toggleClass('fa-compress fa-expand');
          $(this).attr('title', enableCompression ? '关闭压缩' : '开启压缩');
      });
  
      function initFileInput() {
        $("#fileInput").fileinput({
          theme: 'fa',
          language: 'zh',
          browseClass: "btn btn-primary",
          removeClass: "btn btn-danger",
          showUpload: false,
          showPreview: false,
        }).on('filebatchselected', handleFileSelection)
          .on('fileclear', handleFileClear);
      }
  
      async function handleFileSelection() {
        const files = $('#fileInput')[0].files;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fileHash = await calculateFileHash(file);
          const cachedData = getCachedData(fileHash);
          if (cachedData) {
              handleCachedFile(cachedData);
          } else {
              await uploadFile(file, fileHash);
          }
        }
      }
  
      function getCachedData(fileHash) {
          return (JSON.parse(localStorage.getItem('uploadCache')) || []).find(item => item.hash === fileHash);
      }
  
      function handleCachedFile(cachedData) {
          if (!originalImageURLs.includes(cachedData.url)) {
              originalImageURLs.push(cachedData.url);
              updateFileLinkDisplay();
              toastr.info('已从缓存中读取数据');
          }
      }
  
      function updateFileLinkDisplay() {
          $('#fileLink').val(originalImageURLs.join('\\n\\n'));
          $('.form-group').show();
          adjustTextareaHeight($('#fileLink')[0]);
      }

      function addThumbnail(file, url) {
          const container = $('#thumbnailContainer');
          const index = thumbnailData.length;
          const previewUrl = URL.createObjectURL(file);
          thumbnailData.push({ previewUrl, url, file });
          let thumbnailContent = '';
          if (file.type.startsWith('image/')) {
              thumbnailContent = '<img src="' + previewUrl + '" alt="thumbnail">';
          } else if (file.type.startsWith('video/')) {
              thumbnailContent = '<video src="' + previewUrl + '" muted></video>';
          } else {
              thumbnailContent = '<div class="file-icon">' + file.name.split('.').pop().toUpperCase() + '</div>';
          }
          container.append('<div class="thumbnail-item" data-index="' + index + '">' + thumbnailContent + '<button class="remove-btn" title="移除">&times;</button></div>');
      }

      $(document).on('click', '.thumbnail-item .remove-btn', function(e) {
          e.stopPropagation();
          const index = $(this).parent().data('index');
          const item = thumbnailData[index];
          if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
          if (item?.url) {
              originalImageURLs = originalImageURLs.filter(u => u !== item.url);
              updateFileLinkDisplay();
              if (originalImageURLs.length === 0) hideButtonsAndTextarea();
          }
          $(this).parent().remove();
      });

      async function calculateFileHash(file) {
        const chunk = file.size > 1024*1024 ? file.slice(0, 1024*1024) : file;
        const hashBuffer = await crypto.subtle.digest('SHA-256', await chunk.arrayBuffer());
        const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2,'0')).join('');
        return hash + '-' + file.size + '-' + file.lastModified;
      }
  
      async function uploadFile(file, fileHash) {
        const originalFile = file;
        try {
          if (enableCompression && file.type.startsWith('image/') && file.type !== 'image/gif') {
            toastr.info('正在压缩...');
            file = await compressImage(file);
            toastr.clear();
          }
          const formData = new FormData();
          formData.append('file', file, file.name);
          $('#uploadProgress').show();
          const xhr = new XMLHttpRequest();
          xhr.upload.addEventListener('progress', e => {
            if (e.lengthComputable) $('#progressText').text('上传中... ' + Math.round(e.loaded/e.total*100) + '%');
          });
          const responseData = await new Promise((resolve, reject) => {
            xhr.onload = () => xhr.status === 200 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error('上传失败'));
            xhr.onerror = () => reject(new Error('网络错误'));
            xhr.open('POST', '/upload');
            xhr.send(formData);
          });
          $('#uploadProgress').hide();
          originalImageURLs.push(responseData.data);
          addThumbnail(originalFile, responseData.data);
          updateFileLinkDisplay();
          toastr.success('上传成功');
          saveToLocalCache(responseData.data, file.name, fileHash);
        } catch (e) {
          $('#uploadProgress').hide();
          toastr.error(e.message);
        }
      }

      $(document).on('paste', async function(event) {
        const items = event.originalEvent.clipboardData?.items;
        if (!items) return;
        for (let item of items) {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            const dt = new DataTransfer();
            for (let f of $('#fileInput')[0].files) dt.items.add(f);
            dt.items.add(file);
            $('#fileInput')[0].files = dt.files;
            $('#fileInput').trigger('change');
            break;
          }
        }
      });

      const $card = $('.card');
      $card.on('dragover', e => { e.preventDefault(); $card.css('background-color', 'rgba(255,255,255,0.95)'); });
      $card.on('dragleave', e => { e.preventDefault(); $card.css('background-color', 'rgba(255,255,255,0.8)'); });
      $card.on('drop', e => {
        e.preventDefault();
        $card.css('background-color', 'rgba(255,255,255,0.8)');
        const files = e.originalEvent.dataTransfer.files;
        if (files.length) {
          const dt = new DataTransfer();
          for (let f of files) dt.items.add(f);
          $('#fileInput')[0].files = dt.files;
          $('#fileInput').trigger('change');
        }
      });
  
      function compressImage(file, quality = 0.75) {
        return new Promise(resolve => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            canvas.toBlob(blob => resolve(new File([blob], file.name, {type:'image/jpeg'})), 'image/jpeg', quality);
          };
          const reader = new FileReader();
          reader.onload = e => img.src = e.target.result;
          reader.readAsDataURL(file);
        });
      }
  
      $('#urlBtn, #bbcodeBtn, #markdownBtn').on('click', function() {
        const urls = originalImageURLs.filter(url => url.trim());
        if (!urls.length) return;
        const format = {urlBtn:'url', bbcodeBtn:'bbcode', markdownBtn:'markdown'}[this.id];
        const formatted = formatLinks(urls, format);
        $('#fileLink').val(formatted);
        adjustTextareaHeight($('#fileLink')[0]);
        navigator.clipboard?.writeText(formatted).then(() => toastr.success('已复制')).catch(() => toastr.error('复制失败'));
      });
  
      function handleFileClear() {
        $('#fileLink').val('');
        hideButtonsAndTextarea();
        originalImageURLs = [];
        thumbnailData.forEach(i => i?.previewUrl && URL.revokeObjectURL(i.previewUrl));
        thumbnailData = [];
        $('#thumbnailContainer').empty();
      }
  
      function adjustTextareaHeight(textarea) {
        textarea.style.height = '1px';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
        textarea.style.overflowY = textarea.scrollHeight > 200 ? 'auto' : 'hidden';
      }
  
      function hideButtonsAndTextarea() {
        $('#urlBtn, #bbcodeBtn, #markdownBtn, #fileLink').parent('.form-group').hide();
      }
  
      function saveToLocalCache(url, fileName, fileHash) {
        const cache = JSON.parse(localStorage.getItem('uploadCache')) || [];
        cache.push({ url, fileName, hash: fileHash, timestamp: new Date().toLocaleString('zh-CN', { hour12: false }) });
        localStorage.setItem('uploadCache', JSON.stringify(cache));
      }
  
      $('#viewCacheBtn').on('click', function() {
        const cacheData = JSON.parse(localStorage.getItem('uploadCache')) || [];
        const $cache = $('#cacheContent').empty();
        if (isCacheVisible) {
          $cache.hide();
          $('#fileLink').val('').parent('.form-group').hide();
          isCacheVisible = false;
        } else {
          if (cacheData.length) {
            $cache.html(cacheData.reverse().map(i => '<div class="cache-item" data-url="'+i.url+'">'+i.timestamp+' - '+i.fileName+'</div>').join('')).show();
          } else {
            $cache.html('<div>还没有记录哦！</div>').show();
          }
          isCacheVisible = true;
        }
      });
  
      $(document).on('click', '.cache-item', function() {
        const url = $(this).data('url');
        originalImageURLs = [url];
        $('#fileLink').val(url).parent('.form-group').show();
        adjustTextareaHeight($('#fileLink')[0]);
      });
    });
    </script>
</body>
</html>`;
}

function getAdminPageHtml({ totalCount, page, totalPages, mediaHtml, hasMedia }) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>图库管理</title>
  <link rel="icon" href="https://p1.meituan.net/csc/c195ee91001e783f39f41ffffbbcbd484286.ico" type="image/x-icon">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #f5f7fa 0%, #e4e8f0 100%); min-height: 100vh; margin: 0; padding: 20px; }
    .page-title { font-size: 32px; font-weight: 700; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; text-align: center; margin-bottom: 20px; }
    .header { position: sticky; top: 10px; background: rgba(255,255,255,0.85); backdrop-filter: blur(12px); z-index: 1000; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding: 15px 20px; box-shadow: 0 4px 20px rgba(102,126,234,0.15); border-radius: 16px; border: 1px solid rgba(255,255,255,0.6); flex-wrap: wrap; }
    .header-left { flex: 1; display: flex; gap: 15px; align-items: center; color: #555; font-weight: 500; }
    .header-right { display: flex; gap: 10px; justify-content: flex-end; flex: 1; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
    .media-container { position: relative; overflow: hidden; border-radius: 16px; background: rgba(255,255,255,0.9); backdrop-filter: blur(8px); box-shadow: 0 4px 15px rgba(0,0,0,0.08); border: 1px solid rgba(255,255,255,0.6); aspect-ratio: 1 / 1; transition: all 0.3s ease; cursor: pointer; }
    .media-container:hover { transform: translateY(-4px); box-shadow: 0 8px 25px rgba(102,126,234,0.2); }
    .media-container.selected { border: 2px solid #667eea; background: rgba(102,126,234,0.1); }
    .media-type { position: absolute; top: 10px; left: 10px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 4px 10px; border-radius: 20px; font-size: 12px; z-index: 10; text-transform: uppercase; }
    .upload-time { position: absolute; bottom: 10px; left: 10px; right: 10px; background: rgba(255,255,255,0.9); padding: 8px; border-radius: 8px; color: #555; font-size: 12px; z-index: 10; display: none; }
    .gallery-image, .gallery-video { width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 0.4s; }
    .gallery-image.loaded, .gallery-video.loaded { opacity: 1; }
    .skeleton { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 16px; }
    .skeleton.hidden { display: none; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .footer { margin-top: 30px; text-align: center; color: #999; padding: 20px; background: rgba(255,255,255,0.6); border-radius: 12px; }
    .delete-button, .copy-button { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 10px; padding: 10px 20px; cursor: pointer; transition: all 0.3s; font-weight: 500; }
    .delete-button:hover, .copy-button:hover { transform: translateY(-2px); }
    .hidden { display: none; }
    .dropdown { position: relative; display: inline-block; }
    .dropdown-content { display: none; position: absolute; background: rgba(255,255,255,0.95); min-width: 140px; box-shadow: 0 8px 25px rgba(0,0,0,0.15); z-index: 1001; border-radius: 12px; right: 0; }
    .dropdown-content button { color: #333; padding: 12px 16px; text-decoration: none; display: block; background: none; border: none; width: 100%; text-align: left; cursor: pointer; }
    .dropdown-content button:hover { background: rgba(102,126,234,0.1); }
    .dropdown:hover .dropdown-content { display: block; }
    .pagination { display: flex; justify-content: center; gap: 12px; margin: 25px 0; padding: 15px; background: rgba(255,255,255,0.6); border-radius: 16px; }
    .pagination button { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 10px; padding: 10px 24px; cursor: pointer; }
    .pagination button:disabled { background: #ccc; cursor: not-allowed; }
    .empty-state { text-align: center; padding: 80px 20px; color: #999; background: rgba(255,255,255,0.6); border-radius: 16px; }
  </style>
  <script>
    let selectedCount = 0;
    const selectedKeys = new Set();
    let isAllSelected = false;
  
    function toggleImageSelection(container) {
      const key = container.getAttribute('data-key');
      container.classList.toggle('selected');
      const uploadTime = container.querySelector('.upload-time');
      if (container.classList.contains('selected')) {
        selectedKeys.add(key);
        selectedCount++;
        uploadTime.style.display = 'block';
      } else {
        selectedKeys.delete(key);
        selectedCount--;
        uploadTime.style.display = 'none';
      }
      updateDeleteButton();
    }
  
    function updateDeleteButton() {
      document.getElementById('selected-count').textContent = selectedCount;
      document.querySelector('.header-right').classList.toggle('hidden', selectedCount === 0);
    }
  
    async function deleteSelectedImages() {
      if (selectedKeys.size === 0) return;
      if (!confirm('确定删除选中的媒体文件吗？')) return;
      const keysToDelete = Array.from(selectedKeys);
      const response = await fetch('/delete-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keysToDelete)
      });
      if (response.ok) {
        document.querySelectorAll('.media-container').forEach(c => {
          if (selectedKeys.has(c.getAttribute('data-key'))) {
            c.style.opacity = '0';
            setTimeout(() => c.remove(), 300);
          }
        });
        setTimeout(() => location.reload(), 500);
      } else {
        alert('删除失败');
      }
    }
  
    function copyFormattedLinks(format) {
      const urls = Array.from(selectedKeys);
      let formatted;
      if (format === 'url') formatted = urls.join('\\n\\n');
      else if (format === 'bbcode') formatted = urls.map(u => '[img]' + u + '[/img]').join('\\n\\n');
      else formatted = urls.map(u => '![image](' + u + ')').join('\\n\\n');
      navigator.clipboard?.writeText(formatted).then(() => alert('复制成功')).catch(() => alert('复制失败'));
    }
  
    function selectAllImages() {
      const containers = Array.from(document.querySelectorAll('.media-container'));
      containers.forEach(c => {
        if (isAllSelected) {
          c.classList.remove('selected');
          c.querySelector('.upload-time').style.display = 'none';
        } else {
          c.classList.add('selected');
          c.querySelector('.upload-time').style.display = 'block';
        }
      });
      if (isAllSelected) {
        selectedKeys.clear();
        selectedCount = 0;
      } else {
        containers.forEach(c => selectedKeys.add(c.getAttribute('data-key')));
        selectedCount = containers.length;
      }
      isAllSelected = !isAllSelected;
      updateDeleteButton();
    }
  
    document.addEventListener('DOMContentLoaded', () => {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const container = entry.target;
          const skeleton = container.querySelector('.skeleton');
          const video = container.querySelector('video');
          if (video) {
            const source = video.querySelector('source');
            if (source?.dataset.src) {
              video.src = source.dataset.src;
              video.load();
              video.onloadeddata = () => { video.classList.add('loaded'); skeleton.classList.add('hidden'); };
            }
          } else {
            const img = container.querySelector('img');
            if (img?.dataset.src && !img.src) {
              img.src = img.dataset.src;
              img.onload = () => { img.classList.add('loaded'); skeleton.classList.add('hidden'); };
            }
          }
          observer.unobserve(container);
        });
      }, { rootMargin: '100px' });
      document.querySelectorAll('.media-container[data-key]').forEach(c => observer.observe(c));
    });
  </script>
</head>
<body>
  <h1 class="page-title">图库管理</h1>
  <div class="header">
    <div class="header-left">
      <span>媒体文件 ${totalCount} 个</span>
      <span>已选中: <span id="selected-count">0</span>个</span>
    </div>
    <div class="header-right hidden">
      <div class="dropdown">
        <button class="copy-button">复制</button>
        <div class="dropdown-content">
          <button onclick="copyFormattedLinks('url')">URL</button>
          <button onclick="copyFormattedLinks('bbcode')">BBCode</button>
          <button onclick="copyFormattedLinks('markdown')">Markdown</button>
        </div>
      </div>
      <button class="delete-button" onclick="selectAllImages()">全选</button>
      <button class="delete-button" onclick="deleteSelectedImages()">删除</button>
    </div>
  </div>
  <div class="gallery">
    ${hasMedia ? mediaHtml : '<div class="empty-state"><div>📁</div><div>暂无媒体文件</div></div>'}
  </div>
  ${hasMedia ? `
  <div class="pagination">
    <button onclick="location.href='?page=${page-1}'" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="page-info">第 ${page} / ${totalPages} 页 (共 ${totalCount} 个)</span>
    <button onclick="location.href='?page=${page+1}'" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
  </div>
  ` : ''}
  <div class="footer">到底啦</div>
</body>
</html>`;
}