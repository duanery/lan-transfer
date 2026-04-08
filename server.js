const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');


const app = express();
const PORT = 3000;

// Support custom upload directory via command line argument
const UPLOAD_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(express.json());

// Sanitize path to prevent directory traversal
function safePath(relativePath) {
  const cleaned = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
  const resolved = path.resolve(UPLOAD_DIR, cleaned);
  if (!resolved.startsWith(UPLOAD_DIR)) return null;
  return resolved;
}

// Multer config - upload to temp dir first, then move based on paths
const TEMP_DIR = path.join(__dirname, '.tmp_uploads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2))
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }
});

function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function getDirSize(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) size += getDirSize(fullPath);
      else size += fs.statSync(fullPath).size;
    }
  } catch (e) {}
  return size;
}

function getDirFileCount(dirPath) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) count += getDirFileCount(fullPath);
      else count++;
    }
  } catch (e) {}
  return count;
}

// API: list files in a directory
app.get('/api/files', (req, res) => {
  try {
    const relDir = req.query.dir || '';
    const targetDir = relDir ? safePath(relDir) : UPLOAD_DIR;
    if (!targetDir || !fs.existsSync(targetDir)) return res.json({ entries: [], currentDir: relDir });

    const entries = fs.readdirSync(targetDir, { withFileTypes: true }).map(entry => {
      const fullPath = path.join(targetDir, entry.name);
      const stat = fs.statSync(fullPath);
      const isDir = entry.isDirectory();
      const size = isDir ? getDirSize(fullPath) : stat.size;
      return {
        name: entry.name,
        isDir,
        size,
        sizeStr: formatSize(size),
        fileCount: isDir ? getDirFileCount(fullPath) : 0,
        time: stat.mtimeMs,
        timeStr: new Date(stat.mtime).toLocaleString('zh-CN')
      };
    });
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return b.time - a.time;
    });
    res.json({ entries, currentDir: relDir });
  } catch (e) {
    res.json({ entries: [], currentDir: '' });
  }
});

// API: upload - move files from temp to correct paths
app.post('/api/upload', upload.array('files', 500), (req, res) => {
  try {
    // paths[] contains the relative path for each file (sent from frontend)
    let paths = req.body.paths;
    if (!paths) paths = [];
    if (typeof paths === 'string') paths = [paths];

    const currentDir = req.query.dir || '';
    const destBase = currentDir ? safePath(currentDir) : UPLOAD_DIR;
    if (!destBase) return res.status(400).json({ error: 'Invalid path' });

    for (let i = 0; i < req.files.length; i++) {
      const tempPath = req.files[i].path;
      const relativePath = paths[i] || req.files[i].originalname;
      const destPath = path.join(destBase, relativePath);

      // Security check
      if (!destPath.startsWith(UPLOAD_DIR)) {
        fs.unlinkSync(tempPath);
        continue;
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.renameSync(tempPath, destPath);
    }
    res.json({ success: true, count: req.files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: download file
app.get('/api/download/*', (req, res) => {
  const relPath = req.params[0];
  const filePath = safePath(relPath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    return res.status(400).json({ error: 'Cannot download a directory' });
  }
  res.download(filePath, path.basename(filePath));
});

// API: delete file or directory
app.delete('/api/files/*', (req, res) => {
  const relPath = req.params[0];
  const filePath = safePath(relPath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    fs.rmSync(filePath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(filePath);
  }
  res.json({ success: true });
});

// API: create directory
app.post('/api/mkdir', (req, res) => {
  const { dir, name } = req.body;
  const parentDir = dir ? safePath(dir) : UPLOAD_DIR;
  if (!parentDir) return res.status(400).json({ error: 'Invalid path' });
  const newDir = path.join(parentDir, name);
  if (!newDir.startsWith(UPLOAD_DIR)) return res.status(400).json({ error: 'Invalid path' });
  fs.mkdirSync(newDir, { recursive: true });
  res.json({ success: true });
});

// API: QR code
app.get('/api/qrcode', async (req, res) => {
  const url = `http://${getLanIP()}:${PORT}`;
  const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1 });
  res.json({ url, qr: dataUrl });
});

// Main page
app.get('/', (req, res) => {
  res.send(getHTML());
});

function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LAN File Transfer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f0f2f5; color: #333; min-height: 100vh;
  }
  .container { max-width: 860px; margin: 0 auto; padding: 20px; }
  header { text-align: center; padding: 24px 0 16px; }
  header h1 { font-size: 26px; color: #1a1a2e; margin-bottom: 6px; }
  header p { color: #666; font-size: 14px; }

  .info-bar {
    display: flex; align-items: center; justify-content: center; gap: 20px;
    background: #fff; border-radius: 12px; padding: 14px 24px; margin-bottom: 16px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  }
  .info-bar .url { font-size: 15px; font-weight: 600; color: #4361ee; font-family: monospace; }
  .qr-toggle { cursor: pointer; color: #4361ee; font-size: 13px; text-decoration: underline; }
  .qr-img { display: none; margin-top: 10px; }
  .qr-img.show { display: block; }

  .upload-zone {
    border: 2px dashed #c5cae9; border-radius: 14px; padding: 32px 20px;
    text-align: center; background: #fff; margin-bottom: 16px;
    transition: all 0.2s; box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  }
  .upload-zone:hover, .upload-zone.dragover { border-color: #4361ee; background: #f0f4ff; }
  .upload-zone svg { width: 40px; height: 40px; margin-bottom: 10px; color: #4361ee; }
  .upload-zone h3 { font-size: 16px; color: #333; margin-bottom: 4px; }
  .upload-zone p { color: #888; font-size: 13px; }
  .upload-zone input { display: none; }
  .upload-btns { margin-top: 14px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .upload-btn {
    padding: 8px 18px; border-radius: 8px; border: 1px solid #c5cae9;
    background: #f8f9ff; color: #4361ee; font-size: 13px; font-weight: 500;
    cursor: pointer; transition: all 0.15s;
  }
  .upload-btn:hover { background: #4361ee; color: #fff; border-color: #4361ee; }

  .progress-bar { display: none; height: 6px; background: #e0e0e0; border-radius: 3px; margin: 12px 0; overflow: hidden; }
  .progress-bar.show { display: block; }
  .progress-bar .fill { height: 100%; background: linear-gradient(90deg, #4361ee, #7209b7); border-radius: 3px; transition: width 0.15s; width: 0%; }
  .progress-text { display: none; text-align: center; font-size: 13px; color: #666; margin-bottom: 8px; }
  .progress-text.show { display: block; }

  .file-list { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); overflow: hidden; }
  .file-list-header {
    padding: 14px 20px; font-size: 15px; font-weight: 600;
    border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;
  }
  .file-list-header span { color: #888; font-size: 13px; font-weight: 400; }

  .breadcrumb {
    padding: 10px 20px; background: #fafbff; border-bottom: 1px solid #eee;
    font-size: 13px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  }
  .breadcrumb a {
    color: #4361ee; text-decoration: none; cursor: pointer; padding: 2px 4px; border-radius: 4px;
  }
  .breadcrumb a:hover { background: #eef0ff; }
  .breadcrumb .sep { color: #ccc; }
  .breadcrumb .current { color: #333; font-weight: 500; }

  .empty-msg { padding: 40px 20px; text-align: center; color: #aaa; font-size: 14px; }
  .file-item {
    display: flex; align-items: center; padding: 12px 20px;
    border-bottom: 1px solid #f5f5f5; transition: background 0.15s;
  }
  .file-item:hover { background: #fafbff; }
  .file-item:last-child { border-bottom: none; }
  .file-icon {
    width: 38px; height: 38px; border-radius: 10px; background: #eef0ff;
    display: flex; align-items: center; justify-content: center;
    margin-right: 12px; flex-shrink: 0; font-size: 17px;
  }
  .file-icon.dir { background: #fff3e0; cursor: pointer; }
  .file-info { flex: 1; min-width: 0; }
  .file-name {
    font-size: 14px; font-weight: 500; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .file-name.dir-link { color: #4361ee; cursor: pointer; }
  .file-name.dir-link:hover { text-decoration: underline; }
  .file-meta { font-size: 12px; color: #999; margin-top: 2px; }
  .file-actions { display: flex; gap: 6px; flex-shrink: 0; margin-left: 10px; }
  .btn {
    border: none; border-radius: 8px; padding: 7px 12px; font-size: 12px;
    cursor: pointer; transition: all 0.15s; font-weight: 500;
  }
  .btn-dl { background: #4361ee; color: #fff; }
  .btn-dl:hover { background: #3a56d4; }
  .btn-del { background: #fee2e2; color: #ef4444; }
  .btn-del:hover { background: #fecaca; }

  .toast {
    position: fixed; top: 20px; left: 50%;
    transform: translateX(-50%) translateY(-100px);
    background: #333; color: #fff; padding: 10px 22px; border-radius: 8px;
    font-size: 14px; transition: transform 0.3s; z-index: 1000;
  }
  .toast.show { transform: translateX(-50%) translateY(0); }

  @media (max-width: 600px) {
    .container { padding: 12px; }
    header h1 { font-size: 20px; }
    .upload-zone { padding: 24px 14px; }
    .file-actions { flex-direction: column; gap: 3px; }
    .btn { padding: 5px 8px; font-size: 11px; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>LAN File Transfer</h1>
    <p>在局域网内的设备之间快速传输文件和文件夹</p>
  </header>

  <div class="info-bar">
    <div>
      <span style="color:#888;font-size:13px;">访问地址：</span>
      <span class="url" id="serverUrl">loading...</span>
      <br>
      <span class="qr-toggle" onclick="toggleQR()">显示二维码</span>
      <div class="qr-img" id="qrBox"><img id="qrImg" src="" alt="QR"></div>
    </div>
  </div>

  <div class="upload-zone" id="dropZone">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
    <h3>拖拽文件或文件夹到此处上传</h3>
    <p>上传到当前浏览的目录</p>
    <div class="upload-btns">
      <button class="upload-btn" onclick="document.getElementById('fileInput').click()">选择文件</button>
      <button class="upload-btn" onclick="document.getElementById('dirInput').click()">选择文件夹</button>
    </div>
    <input type="file" id="fileInput" multiple>
    <input type="file" id="dirInput" webkitdirectory mozdirectory directory multiple>
  </div>

  <div class="progress-bar" id="progressBar"><div class="fill" id="progressFill"></div></div>
  <div class="progress-text" id="progressText"></div>

  <div class="file-list">
    <div class="file-list-header">
      文件列表
      <span id="fileCount">0 项</span>
    </div>
    <div class="breadcrumb" id="breadcrumb"></div>
    <div id="fileListBody">
      <div class="empty-msg">暂无文件</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let currentDir = '';

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function getIcon(name, isDir) {
  if (isDir) return '📂';
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📎',pptx:'📎',
    jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',svg:'🖼️',webp:'🖼️',
    mp4:'🎬',avi:'🎬',mov:'🎬',mkv:'🎬',
    mp3:'🎵',wav:'🎵',flac:'🎵',
    zip:'📦',rar:'📦','7z':'📦',tar:'📦',gz:'📦',
    js:'💻',ts:'💻',py:'💻',java:'💻',c:'💻',cpp:'💻',
    txt:'📃',md:'📃',json:'📃',csv:'📃',
  };
  return map[ext] || '📄';
}

function renderBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  const parts = currentDir ? currentDir.split('/').filter(Boolean) : [];
  let html = '<a onclick="navigateTo(\\'\\')">根目录</a>';
  let accumulated = '';
  for (let i = 0; i < parts.length; i++) {
    accumulated += (accumulated ? '/' : '') + parts[i];
    const p = accumulated;
    html += '<span class="sep">/</span>';
    if (i === parts.length - 1) {
      html += '<span class="current">' + parts[i] + '</span>';
    } else {
      html += '<a onclick="navigateTo(\\'' + p.replace(/'/g, "\\\\'") + '\\')">' + parts[i] + '</a>';
    }
  }
  bc.innerHTML = html;
}

function navigateTo(dir) {
  currentDir = dir;
  renderBreadcrumb();
  loadFiles();
}

async function loadFiles() {
  const url = '/api/files' + (currentDir ? '?dir=' + encodeURIComponent(currentDir) : '');
  const res = await fetch(url);
  const data = await res.json();
  const files = data.entries;
  const body = document.getElementById('fileListBody');
  document.getElementById('fileCount').textContent = files.length + ' 项';

  if (files.length === 0) {
    body.innerHTML = '<div class="empty-msg">此目录为空</div>';
    return;
  }

  body.innerHTML = files.map(f => {
    const relPath = currentDir ? currentDir + '/' + f.name : f.name;
    const encodedPath = encodeURIComponent(relPath);
    const escapedRelPath = relPath.replace(/'/g, "\\\\'");
    return \`
    <div class="file-item">
      <div class="file-icon \${f.isDir ? 'dir' : ''}" \${f.isDir ? 'onclick="navigateTo(\\'' + escapedRelPath + '\\')"' : ''}>
        \${getIcon(f.name, f.isDir)}
      </div>
      <div class="file-info">
        <div class="file-name \${f.isDir ? 'dir-link' : ''}" \${f.isDir ? 'onclick="navigateTo(\\'' + escapedRelPath + '\\')"' : ''}>
          \${f.name}
        </div>
        <div class="file-meta">
          \${f.isDir ? f.fileCount + ' 个文件 · ' : ''}\${f.sizeStr} · \${f.timeStr}
        </div>
      </div>
      <div class="file-actions">
        \${f.isDir ? '' : '<button class="btn btn-dl" onclick="downloadItem(\\'' + encodedPath + '\\')">下载</button>'}
        <button class="btn btn-del" onclick="deleteItem('\${encodedPath}', \${f.isDir})">删除</button>
      </div>
    </div>\`;
  }).join('');
}

function fileListToEntries(fileList) {
  const entries = [];
  for (const file of fileList) {
    const relativePath = file.webkitRelativePath || file.name;
    entries.push({ file, relativePath });
  }
  return entries;
}

async function getDropEntries(dataTransfer) {
  const entries = [];
  async function readEntry(entry, basePath) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      entries.push({ file, relativePath: basePath + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of batch) {
          await readEntry(child, basePath + entry.name + '/');
        }
      } while (batch.length > 0);
    }
  }
  const items = dataTransfer.items;
  const topEntries = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
    if (entry) topEntries.push(entry);
  }
  for (const entry of topEntries) {
    await readEntry(entry, '');
  }
  return entries;
}

function uploadFiles(fileEntries) {
  const formData = new FormData();
  for (const entry of fileEntries) {
    formData.append('files', entry.file);
    formData.append('paths', entry.relativePath);
  }

  const xhr = new XMLHttpRequest();
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');

  progressBar.classList.add('show');
  progressText.classList.add('show');
  progressFill.style.width = '0%';

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round(e.loaded / e.total * 100);
      progressFill.style.width = pct + '%';
      progressText.textContent = \`上传中... \${pct}% (\${fileEntries.length} 个文件)\`;
    }
  };

  xhr.onload = () => {
    progressFill.style.width = '100%';
    progressText.textContent = '上传完成!';
    setTimeout(() => { progressBar.classList.remove('show'); progressText.classList.remove('show'); }, 1500);
    showToast('上传成功!');
    loadFiles();
  };

  xhr.onerror = () => {
    progressBar.classList.remove('show');
    progressText.classList.remove('show');
    showToast('上传失败');
  };

  const dirParam = currentDir ? '?dir=' + encodeURIComponent(currentDir) : '';
  xhr.open('POST', '/api/upload' + dirParam);
  xhr.send(formData);
}

function downloadItem(encodedPath) {
  window.open('/api/download/' + encodedPath, '_blank');
}

async function deleteItem(encodedPath, isDir) {
  const msg = isDir ? '确认删除此文件夹及其所有内容?' : '确认删除此文件?';
  if (!confirm(msg)) return;
  await fetch('/api/files/' + encodedPath, { method: 'DELETE' });
  showToast('已删除');
  loadFiles();
}

// Drag & Drop
const dropZone = document.getElementById('dropZone');
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.items && e.dataTransfer.items[0] && e.dataTransfer.items[0].webkitGetAsEntry) {
    const entries = await getDropEntries(e.dataTransfer);
    if (entries.length > 0) uploadFiles(entries);
  } else if (e.dataTransfer.files.length) {
    uploadFiles(fileListToEntries(e.dataTransfer.files));
  }
});

document.getElementById('fileInput').addEventListener('change', function() {
  if (this.files.length) uploadFiles(fileListToEntries(this.files));
  this.value = '';
});
document.getElementById('dirInput').addEventListener('change', function() {
  if (this.files.length) uploadFiles(fileListToEntries(this.files));
  this.value = '';
});

function toggleQR() { document.getElementById('qrBox').classList.toggle('show'); }

async function init() {
  const res = await fetch('/api/qrcode');
  const data = await res.json();
  document.getElementById('serverUrl').textContent = data.url;
  document.getElementById('qrImg').src = data.qr;
  renderBreadcrumb();
  loadFiles();
}
init();
setInterval(loadFiles, 5000);
</script>
</body>
</html>`;
}

// Start server
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLanIP();
  console.log('\\n========================================');
  console.log('  LAN File Transfer Server');
  console.log('========================================');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  LAN:     http://${ip}:${PORT}`);
  console.log(`  目录:    ${UPLOAD_DIR}`);
  console.log('========================================');
  console.log('  在同一局域网的其他设备上打开上面的 LAN 地址即可传输文件');
  console.log('  Ctrl+C 停止服务器\\n');
});
