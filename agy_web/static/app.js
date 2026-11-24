const chatEl = document.getElementById('chat');
const inputEl = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const nowBtn = document.getElementById('nowBtn');
const newChatBtn = document.getElementById('newChatBtn');
const nodeSelect = document.getElementById('nodeSelect');
const galleryBtn = document.getElementById('galleryBtn');
const statusDot = document.getElementById('statusDot');
const subInfo = document.getElementById('subInfo');
const consolePane = document.getElementById('consolePane');
const toggleConsoleBtn = document.getElementById('toggleConsoleBtn');
const sessionPickerBtn = document.getElementById('sessionPickerBtn');
const sessionPickerLabel = document.getElementById('sessionPickerLabel');
const filesBtn = document.getElementById('filesBtn');
const renameBtn = document.getElementById('renameBtn');
const modelSelect = document.getElementById('modelSelect');
const modeSelect = document.getElementById('modeSelect');
const sessionStats = document.getElementById('sessionStats');
const imgModal = document.getElementById('imgModal');
const modalTitle = document.getElementById('modalTitle');
const modalFabBar = document.getElementById('modalFabBar');
const modalOrigBtn = document.getElementById('modalOrigBtn');
const modal1to1Btn = document.getElementById('modal1to1Btn');
const modalSaveBtn = document.getElementById('modalSaveBtn');
const modalRawLink = document.getElementById('modalRawLink');
const modalBody = document.getElementById('modalBody');
const modalClose = document.getElementById('modalClose');
const uploadImgBtn = document.getElementById('uploadImgBtn');
const imageUploadInput = document.getElementById('imageUploadInput');
const attachedImgs = document.getElementById('attachedImgs');

let state = { busy: false, conversation_id: null, cwd: '', mode: 'auto', model: '', messages: [], total_messages: 0 };
let _fullMsgsCache = null;
let _switchingSession = false;
let _currentNode = localStorage.getItem('agy_node') || 'local';
let _sse = null;
let _sseTimer = null;
let _currentDisplayUrl = '';
let _currentFullUrl = '';
let _currentLabel = '';
let _currentBlob = null;
let _currentBlobUrl = null;
let _currentXhr = null;
let _currentFileSize = 0;
let _pendingUploads = [];
let _nodeOffline = false;
let _nodeErrorMsg = '';
let _reconnectTimer = null;
let _reconnectAttempts = 0;
let _isReconnecting = false;

function scheduleAutoReconnect() {
  if (_reconnectTimer) return;
  _reconnectAttempts++;
  const delay = Math.min(1800 + _reconnectAttempts * 400, 5000);
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    await triggerReconnectNow();
  }, delay);
}

async function triggerReconnectNow() {
  if (_isReconnecting) return;
  _isReconnecting = true;
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  try {
    statusDot.className = 'dot connecting';
    subInfo.textContent = 'Connecting...';
    const ok = await fetchState();
    if (ok) {
      _reconnectAttempts = 0;
      connectSSE();
      loadConversations(true);
      loadModels();
    } else {
      scheduleAutoReconnect();
    }
  } catch (e) {
    scheduleAutoReconnect();
  } finally {
    _isReconnecting = false;
  }
}

let _toastEl = null;
let _toastTimer = null;
function showToast(text, duration = 2500) {
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.className = 'toast-tip';
    document.body.appendChild(_toastEl);
  }
  _toastEl.textContent = text;
  _toastEl.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    _toastEl.classList.remove('show');
  }, duration);
}

const BASE_PATH = (window.location.pathname.match(/^(\/proxy\/[^\/]+)/) || ['',''])[1];

function withNode(url) {
  let u = url;
  if (_currentNode && _currentNode !== 'local') {
    if (u.startsWith('/api/') && !u.startsWith('/api/nodes') && !u.startsWith('/api/login')) {
      if (!/[?&]node=/.test(u)) {
        u = u + (u.includes('?') ? '&' : '?') + 'node=' + encodeURIComponent(_currentNode);
      }
    }
  }
  if (BASE_PATH && typeof u === 'string' && u.startsWith('/') && !u.startsWith(BASE_PATH + '/')) {
    u = BASE_PATH + u;
  }
  return u;
}

const _origFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  if (typeof input === 'string') return _origFetch(withNode(input), init);
  return _origFetch(input, init);
};

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderInlineMd(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codes.length;
    codes.push(`<code>${code}</code>`);
    return `\x00C${idx}\x00`;
  });
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|file:\/\/[^\s)]+|\/[^\s)]+)\)/g, (_, label, url) => {
    let p = url;
    let full = url;
    let thumb = url;
    if (url.startsWith('file://')) {
      p = url.slice(7).split('#')[0].split('?')[0];
      full = withNode(`/api/file?path=${encodeURIComponent(p)}`);
      thumb = withNode(`/api/file?path=${encodeURIComponent(p)}&thumb=1`);
    } else if (url.startsWith('/')) {
      p = url.split('#')[0].split('?')[0];
      full = withNode(`/api/file?path=${encodeURIComponent(p)}`);
      thumb = withNode(`/api/file?path=${encodeURIComponent(p)}&thumb=1`);
    }
    const name = label || (p.split('/').pop() || 'image');
    return `<div class="inline-img-preview" data-url="${esc(full)}" data-name="${esc(name)}">
      <img src="${esc(thumb)}" loading="lazy" alt="${esc(name)}" onerror="this.onerror=null;this.closest('.inline-img-preview').classList.add('img-error');" />
      <div class="inline-img-cap">🖼️ ${esc(name)}</div>
    </div>`;
  });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|file:\/\/[^\s)]+|\/[^\s)]+)\)/g, (_, label, url) => {
    let p = url;
    if (url.startsWith('file://')) {
      p = url.slice(7).split('#')[0].split('?')[0];
    } else if (url.startsWith('/')) {
      p = url.split('#')[0].split('?')[0];
    }
    if ((url.startsWith('file://') || url.startsWith('/')) && /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(p)) {
      const full = withNode(`/api/file?path=${encodeURIComponent(p)}`);
      const thumb = withNode(`/api/file?path=${encodeURIComponent(p)}&thumb=1`);
      return `<div class="inline-img-preview" data-url="${esc(full)}" data-name="${esc(label)}">
        <img src="${esc(thumb)}" loading="lazy" alt="${esc(label)}" onerror="this.onerror=null;this.closest('.inline-img-preview').classList.add('img-error');" />
        <div class="inline-img-cap">🖼️ ${esc(label)}</div>
      </div>`;
    }
    if (url.startsWith('file://') || url.startsWith('/')) {
      return `<span>${label}</span>`;
    }
    if (/\.(png|jpg|jpeg|webp|gif|svg)(\?.*)?$/i.test(url)) {
      return `<div class="inline-img-preview" data-url="${esc(url)}" data-name="${esc(label)}">
        <img src="${esc(url)}" loading="lazy" alt="${esc(label)}" onerror="this.onerror=null;this.closest('.inline-img-preview').classList.add('img-error');" />
        <div class="inline-img-cap">🖼️ ${esc(label)}</div>
      </div>`;
    }
    return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\x00C(\d+)\x00/g, (_, i) => codes[Number(i)]);
  return s;
}

function renderMarkdown(src) {
  if (!src) return '';
  const blocks = [];
  let text = String(src).replace(/\r\n/g, '\n');
  text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\n\x00B${idx}\x00\n`;
  });

  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const bm = line.match(/^\x00B(\d+)\x00$/);
    if (bm) { out.push(blocks[Number(bm[1])]); i++; continue; }
    if (!line.trim()) { i++; continue; }
    if (/^\s*---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    const hm = line.match(/^(#{1,4})\s+(.+)$/);
    if (hm) {
      const lvl = hm[1].length;
      out.push(`<h${lvl}>${renderInlineMd(hm[2])}</h${lvl}>`);
      i++; continue;
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const parseRow = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const headers = parseRow(line);
      i += 2;
      let tbl = '<div class="table-wrap"><table><thead><tr>' + headers.map(h => `<th>${renderInlineMd(h)}</th>`).join('') + '</tr></thead><tbody>';
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cols = parseRow(lines[i]);
        tbl += '<tr>' + headers.map((_, ci) => `<td>${renderInlineMd(cols[ci] || '')}</td>`).join('') + '</tr>';
        i++;
      }
      tbl += '</tbody></table></div>';
      out.push(tbl);
      continue;
    }

    if (line.trim().startsWith('>')) {
      const qLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        qLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${qLines.map(renderInlineMd).join('<br>')}</blockquote>`);
      continue;
    }

    if (/^\s*[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(`<li>${renderInlineMd(lines[i].replace(/^\s*[-*•]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInlineMd(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    const pLines = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^\x00B\d+\x00$/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('>') &&
      !/^\s*---+\s*$/.test(lines[i])
    ) {
      pLines.push(lines[i]);
      i++;
    }
    out.push(`<p>${pLines.map(renderInlineMd).join('<br>')}</p>`);
  }
  return out.join('');
}

// Disable browser-level pinch/double-tap zoom outside image lightbox
document.addEventListener('gesturestart', (e) => {
  if (!imgModal.classList.contains('open')) e.preventDefault();
}, { passive: false });

let zoomState = { scale: 1, tx: 0, ty: 0 };
let committedScale = 1;

function update1to1Btn(isZoomed) {
  if (!modal1to1Btn) return;
  if (isZoomed) {
    modal1to1Btn.textContent = '适合屏幕';
    modal1to1Btn.title = '还原为适合屏幕大小';
  } else {
    modal1to1Btn.textContent = '1:1 原图';
    modal1to1Btn.title = '放大至 1:1 原始像素';
  }
}

function getBaseDimensions(img) {
  const containerW = modalBody.clientWidth || window.innerWidth || 390;
  const containerH = modalBody.clientHeight || (window.innerHeight - 80) || 600;
  const nw = (img && img.naturalWidth) || containerW;
  const nh = (img && img.naturalHeight) || containerH;
  const fitRatio = Math.min(containerW / nw, containerH / nh, 1);
  const baseW = Math.max(10, Math.round(nw * fitRatio));
  const baseH = Math.max(10, Math.round(nh * fitRatio));
  return { baseW, baseH, nw, nh, containerW, containerH };
}

function commitZoomLayout(img) {
  const el = img || document.getElementById('zoomImg');
  if (!el) return;

  if (zoomState.scale <= 1.02) {
    zoomState.scale = 1;
    zoomState.tx = 0;
    zoomState.ty = 0;
    committedScale = 1;
    el.style.maxWidth = '100%';
    el.style.maxHeight = '100%';
    el.style.width = '';
    el.style.height = '';
    el.style.transform = 'translate3d(0px, 0px, 0px)';
    update1to1Btn(false);
    return;
  }

  const { baseW, baseH, nw, containerW, containerH } = getBaseDimensions(el);
  const targetW = Math.round(baseW * zoomState.scale);
  const maxW = Math.min(Math.max(nw, 4096), 6144);
  const effectiveW = Math.min(targetW, maxW);
  const layoutScale = effectiveW / baseW;
  const residualScale = zoomState.scale / layoutScale;

  // Clamp translation so image stays in view
  const maxTx = Math.max(0, (targetW - containerW) / 2) + 60;
  const maxTy = Math.max(0, (targetW * (baseH / baseW) - containerH) / 2) + 60;
  zoomState.tx = Math.max(-maxTx, Math.min(maxTx, zoomState.tx));
  zoomState.ty = Math.max(-maxTy, Math.min(maxTy, zoomState.ty));

  el.style.maxWidth = 'none';
  el.style.maxHeight = 'none';
  el.style.width = effectiveW + 'px';
  el.style.height = Math.round(baseH * layoutScale) + 'px';

  if (Math.abs(residualScale - 1) < 0.005) {
    el.style.transform = `translate3d(${zoomState.tx}px, ${zoomState.ty}px, 0px)`;
  } else {
    el.style.transform = `translate3d(${zoomState.tx}px, ${zoomState.ty}px, 0px) scale(${residualScale.toFixed(4)})`;
  }

  committedScale = zoomState.scale;
  update1to1Btn(true);
}

function applyZoomTransform(img) {
  const el = img || document.getElementById('zoomImg');
  if (!el) return;
  const pinchRatio = zoomState.scale / (committedScale || 1);
  if (Math.abs(pinchRatio - 1) < 0.005) {
    el.style.transform = `translate3d(${zoomState.tx}px, ${zoomState.ty}px, 0px)`;
  } else {
    el.style.transform = `translate3d(${zoomState.tx}px, ${zoomState.ty}px, 0px) scale(${pinchRatio.toFixed(4)})`;
  }
}

function closeModal() {
  _modalView = null;
  if (_currentXhr) {
    try { _currentXhr.abort(); } catch (e) {}
    _currentXhr = null;
  }
  if (_currentBlobUrl) {
    try { URL.revokeObjectURL(_currentBlobUrl); } catch (e) {}
    _currentBlobUrl = null;
  }
  clearModalHandlers();
  if (modalFabBar) modalFabBar.style.display = 'none';
  imgModal.classList.remove('open');
  modalBody.classList.remove('gallery-mode');
  modalBody.innerHTML = '';
  zoomState = { scale: 1, tx: 0, ty: 0 };
  committedScale = 1;
  update1to1Btn(false);
  _currentBlob = null;
  _currentFileSize = 0;
}

function attachImageZoomAndTapClose(img) {
  let mode = null; // 'pan' | 'pinch'
  let startX = 0, startY = 0, startTx = 0, startTy = 0;
  let startDist = 0, startScale = 1;
  let moved = false;
  let lastTap = 0;
  let tapTimer = null;

  const dist = (t1, t2) => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

  modalBody.ontouchstart = (e) => {
    if (e.target.closest('#modalFabBar')) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      mode = 'pinch';
      moved = true;
      startDist = dist(e.touches[0], e.touches[1]);
      startScale = zoomState.scale;
    } else if (e.touches.length === 1) {
      mode = 'pan';
      moved = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTx = zoomState.tx;
      startTy = zoomState.ty;
    }
  };

  modalBody.ontouchmove = (e) => {
    if (e.target.closest('#modalFabBar')) return;
    if (mode === 'pinch' && e.touches.length === 2) {
      e.preventDefault();
      const d = dist(e.touches[0], e.touches[1]);
      zoomState.scale = Math.min(12, Math.max(1, startScale * (d / startDist)));
      if (zoomState.scale <= 1.02) { zoomState.scale = 1; zoomState.tx = 0; zoomState.ty = 0; }
      applyZoomTransform(img);
    } else if (mode === 'pan' && e.touches.length === 1) {
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.hypot(dx, dy) > 8) moved = true;
      if (zoomState.scale > 1.02) {
        e.preventDefault();
        zoomState.tx = startTx + dx;
        zoomState.ty = startTy + dy;
        applyZoomTransform(img);
      }
    }
  };

  modalBody.ontouchend = (e) => {
    if (e.target.closest('#modalFabBar')) return;
    if (e.touches.length === 0) {
      if (mode === 'pinch' || (mode === 'pan' && moved)) {
        // Active gesture finished: commit layout to trigger WebKit high-res re-rasterization
        commitZoomLayout(img);
      }
      if (!moved) {
        const now = Date.now();
        if (now - lastTap < 280) {
          clearTimeout(tapTimer);
          lastTap = 0;
          const { baseW, nw } = getBaseDimensions(img);
          if (zoomState.scale > 1.1) {
            zoomState = { scale: 1, tx: 0, ty: 0 };
            commitZoomLayout(img);
          } else {
            const targetScale = Math.max(2.5, Math.min(nw / baseW, 6));
            zoomState = { scale: targetScale, tx: 0, ty: 0 };
            commitZoomLayout(img);
          }
        } else {
          lastTap = now;
          tapTimer = setTimeout(() => {
            // Only close modal on single tap if not zoomed in
            if (zoomState.scale <= 1.05) {
              closeModal();
            }
          }, 290);
        }
      }
      mode = null;
    }
  };

  // Desktop mouse wheel zoom & click-to-close
  modalBody.onwheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.18 : 0.85;
    zoomState.scale = Math.min(12, Math.max(1, zoomState.scale * factor));
    if (zoomState.scale <= 1.02) { zoomState.scale = 1; zoomState.tx = 0; zoomState.ty = 0; }
    commitZoomLayout(img);
  };
  modalBody.onclick = (e) => {
    if (e.target.closest('#modalFabBar')) return;
    if ('ontouchstart' in window && navigator.maxTouchPoints > 0) return;
    if (zoomState.scale <= 1.05) closeModal();
  };
}

async function openImage(url, label) {
  if (_currentXhr) {
    try { _currentXhr.abort(); } catch (e) {}
    _currentXhr = null;
  }
  if (_currentBlobUrl) {
    try { URL.revokeObjectURL(_currentBlobUrl); } catch (e) {}
    _currentBlobUrl = null;
  }

  const baseUrl = url.replace(/[&?](thumb|preview)=1/g, '');
  const fullUrl = withNode(baseUrl);
  _currentFullUrl = fullUrl;
  _currentLabel = label || 'Image';
  _currentBlob = null;
  _currentFileSize = 0;

  modalTitle.textContent = label || 'Image Preview';
  modalRawLink.style.display = 'inline-block';
  modalRawLink.href = fullUrl;
  modalRawLink.textContent = '新标签 ↗';
  modalBody.classList.remove('gallery-mode');
  if (modalFabBar) modalFabBar.style.display = 'flex';

  zoomState = { scale: 1, tx: 0, ty: 0 };
  committedScale = 1;
  update1to1Btn(false);

  modalOrigBtn.style.display = 'flex';
  modalSaveBtn.disabled = false;
  modalSaveBtn.textContent = '保存到相册';

  let isLargeImage = false;
  let displayUrl = fullUrl;

  const pm = baseUrl.match(/[?&]path=([^&]+)/);
  if (pm) {
    try {
      const infoRes = await fetch('/api/file-info?path=' + pm[1]);
      if (infoRes.ok) {
        const info = await infoRes.json();
        if (info && info.size) {
          _currentFileSize = info.size;
          if (info.size > 3 * 1024 * 1024) {
            isLargeImage = true;
            displayUrl = withNode(baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'preview=1');
          }
        }
      }
    } catch (e) {}
  }

  _currentDisplayUrl = displayUrl;

  if (isLargeImage) {
    modalOrigBtn.disabled = false;
    modalOrigBtn.textContent = `加载原图 (${fmtSize(_currentFileSize)})`;
    modalOrigBtn.title = '当前为快速预览图，点击下载高分辨率原图';
  } else {
    modalOrigBtn.disabled = true;
    modalOrigBtn.textContent = _currentFileSize ? `加载中 (${fmtSize(_currentFileSize)})...` : '加载中...';
  }

  modalBody.innerHTML = `<img id="zoomImg" src="${displayUrl}" alt="${esc(label)}" />`;
  const img = document.getElementById('zoomImg');
  attachImageZoomAndTapClose(img);
  imgModal.classList.add('open');

  img.onload = () => {
    if (!isLargeImage) {
      modalOrigBtn.disabled = false;
      modalOrigBtn.textContent = _currentFileSize ? `原图 (${fmtSize(_currentFileSize)}) ↺` : '原图 ↺';
      modalOrigBtn.title = '当前为原图，点击可强制重新加载';
    }
  };

  img.onerror = () => {
    modalOrigBtn.disabled = false;
    modalOrigBtn.textContent = '重试原图';
  };

  // 1:1 / 适合屏幕 按钮切换
  if (modal1to1Btn) {
    modal1to1Btn.onclick = (e) => {
      e.stopPropagation();
      const el = document.getElementById('zoomImg');
      if (!el) return;
      const { baseW, nw } = getBaseDimensions(el);
      if (zoomState.scale > 1.1) {
        zoomState = { scale: 1, tx: 0, ty: 0 };
        commitZoomLayout(el);
        showToast('已还原为适合屏幕');
      } else {
        const targetScale = Math.max(2.0, (nw / baseW));
        zoomState = { scale: targetScale, tx: 0, ty: 0 };
        commitZoomLayout(el);
        showToast(`已切换至 1:1 原始像素 (${nw}px)`);
      }
    };
  }

  // 原图进度下载并原地无缝刷新
  const loadOriginalWithProgress = (forceReload = false) => {
    if (_currentXhr) return;
    modalOrigBtn.disabled = true;
    modalOrigBtn.textContent = '0%';

    const targetUrl = forceReload
      ? fullUrl + (fullUrl.includes('?') ? '&' : '?') + '_t=' + Date.now()
      : fullUrl;

    const xhr = new XMLHttpRequest();
    _currentXhr = xhr;
    xhr.open('GET', targetUrl, true);
    xhr.responseType = 'blob';

    xhr.onprogress = (ev) => {
      const total = (ev.lengthComputable && ev.total > 0) ? ev.total : _currentFileSize;
      if (total > 0) {
        const pct = Math.min(99, Math.round((ev.loaded / total) * 100));
        modalOrigBtn.textContent = `${pct}%`;
      } else {
        modalOrigBtn.textContent = `下载中 (${fmtSize(ev.loaded)})`;
      }
    };

    xhr.onload = () => {
      _currentXhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        modalOrigBtn.textContent = '刷新中...';
        const blob = xhr.response;
        _currentBlob = blob;
        _currentDisplayUrl = fullUrl;
        const blobUrl = URL.createObjectURL(blob);

        const newImg = new Image();
        newImg.id = 'zoomImg';
        newImg.alt = esc(_currentLabel);

        newImg.onload = () => {
          const oldImg = document.getElementById('zoomImg');
          newImg.style.opacity = '0.5';
          if (oldImg && oldImg.parentNode) {
            oldImg.parentNode.replaceChild(newImg, oldImg);
          } else {
            modalBody.innerHTML = '';
            modalBody.appendChild(newImg);
          }

          requestAnimationFrame(() => {
            newImg.style.transition = 'opacity 0.25s ease';
            newImg.style.opacity = '1';
            setTimeout(() => { if (newImg) newImg.style.transition = ''; }, 260);
          });

          if (_currentBlobUrl) {
            try { URL.revokeObjectURL(_currentBlobUrl); } catch (e) {}
          }
          _currentBlobUrl = blobUrl;

          isLargeImage = false;
          modalOrigBtn.disabled = false;
          modalOrigBtn.textContent = `原图 (${fmtSize(blob.size)}) ↺`;
          modalOrigBtn.title = '当前为原图，点击可强制重新加载';

          attachImageZoomAndTapClose(newImg);
          commitZoomLayout(newImg);
          showToast(forceReload ? '已强制刷新原图' : '已加载高清原图！双击或点 [1:1 原图] 查看细节');
        };

        newImg.onerror = () => {
          modalOrigBtn.disabled = false;
          modalOrigBtn.textContent = '重试原图';
          showToast('原图解码失败');
        };

        newImg.src = blobUrl;
      } else {
        modalOrigBtn.disabled = false;
        modalOrigBtn.textContent = '重试原图';
        showToast('原图加载失败');
      }
    };

    xhr.onerror = () => {
      _currentXhr = null;
      modalOrigBtn.disabled = false;
      modalOrigBtn.textContent = '重试原图';
      showToast('网络异常，原图加载失败');
    };

    xhr.send();
  };

  modalOrigBtn.onclick = (e) => {
    e.stopPropagation();
    if (modalOrigBtn.disabled) return;
    loadOriginalWithProgress(!isLargeImage);
  };

  // 保存到相册
  modalSaveBtn.onclick = async (e) => {
    e.stopPropagation();
    try {
      modalSaveBtn.disabled = true;
      modalSaveBtn.textContent = '处理中...';
      let blob = _currentBlob;
      if (!blob) {
        const r = await fetch(_currentFullUrl || _currentDisplayUrl);
        blob = await r.blob();
      }
      const ext = (_currentLabel.split('.').pop() || 'png').toLowerCase();
      const mime = blob.type || (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png');
      const safeName = _currentLabel.includes('.') ? _currentLabel : `${_currentLabel}.${ext}`;
      const file = new File([blob], safeName, { type: mime });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: safeName,
        });
        modalSaveBtn.textContent = '已保存';
        setTimeout(() => { modalSaveBtn.textContent = '保存到相册'; modalSaveBtn.disabled = false; }, 2000);
        return;
      }

      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      modalSaveBtn.textContent = '已下载';
      showToast('已保存图片 (长按图片亦可存入相册)');
      setTimeout(() => { modalSaveBtn.textContent = '保存到相册'; modalSaveBtn.disabled = false; }, 2500);
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        showToast('提示: 可直接长按图片选择“存储图像”');
      }
      modalSaveBtn.textContent = '保存到相册';
      modalSaveBtn.disabled = false;
    }
  };
}

modalClose.onclick = closeModal;

toggleConsoleBtn.onclick = () => {
  const collapsed = consolePane.classList.toggle('collapsed');
  toggleConsoleBtn.textContent = collapsed ? 'Console' : 'Hide';
};

function render() {
  if (_nodeOffline) {
    statusDot.className = 'dot offline';
    sendBtn.disabled = true;
    sendBtn.textContent = 'Offline';
    nowBtn.style.display = 'none';
    sessionPickerLabel.textContent = '-- Offline --';
    subInfo.textContent = `Offline · ${_nodeErrorMsg || '无法连接'}`;
    sessionStats.innerHTML = `<span style="color:#f87171;font-weight:500;">⚠️ 节点断联: ${esc(_nodeErrorMsg || '目标服务器连接失败')}</span> <span style="font-size:11px;color:#94a3b8;margin-left:6px;">(正在自动重试...)</span>`;
    chatEl.innerHTML = `<div style="padding:40px 16px;text-align:center;color:#94a3b8;">
      <div style="font-size:36px;margin-bottom:10px;">🔌</div>
      <div style="font-size:16px;font-weight:600;color:#f87171;margin-bottom:6px;">节点断联 (正在自动尝试重连)</div>
      <div style="font-size:13px;color:#64748b;max-width:340px;margin:0 auto 16px;">${esc(_nodeErrorMsg || '目标服务器连接断开，正在后台持续自动尝试重连，服务恢复后将自动刷新进入')}</div>
      <button class="chip" type="button" onclick="triggerReconnectNow();">立即重连</button>
    </div>`;
    return;
  }

  statusDot.className = 'dot' + (state.busy ? ' busy' : '');
  sendBtn.disabled = false;
  sendBtn.textContent = state.busy ? 'Queue' : 'Send';
  nowBtn.style.display = state.busy ? 'inline-block' : 'none';
  modeSelect.value = state.mode || 'auto';
  if (state.model && ![...modelSelect.options].some(o => o.value === state.model)) {
    const opt = document.createElement('option');
    opt.value = state.model;
    opt.textContent = shortModelName(state.model, state.model);
    modelSelect.appendChild(opt);
  }
  modelSelect.value = state.model || '';
  updateSessionPickerLabel();

  const st = state.stats || {};
  const fmtTokens = (n) => {
    if (!n || n <= 0) return '-';
    if (n >= 999950) return Number((n / 1e6).toPrecision(4)) + 'M';
    if (n >= 1000) return Number((n / 1e3).toPrecision(4)) + 'k';
    return String(Math.round(n));
  };
  const tokText = st.total_tokens ? `${fmtTokens(st.total_tokens)} (${Number(st.cache_pct || 0).toFixed(1)}%)` : '-';
  sessionStats.innerHTML =
    `<span>TPS: <b>${esc(st.tps || '-')}</b></span>` +
    `<span>5h: <b>${esc(st.h5 || '-')}</b></span>` +
    `<span>Weekly: <b>${esc(st.weekly || '-')}</b> <a href="#" id="refreshQuotaBtn" title="刷新额度" style="color:#38bdf8;text-decoration:none;margin-left:2px;">↻</a></span>` +
    `<span>Token: <b>${esc(tokText)}</b></span>`;
  const rqBtn = document.getElementById('refreshQuotaBtn');
  if (rqBtn) {
    rqBtn.onclick = async (e) => {
      e.preventDefault();
      rqBtn.textContent = '…';
      await fetch('/api/refresh-quota', { method: 'POST' }).catch(() => {});
    };
  }

  const sLabel = state.session_name ? ` · ${state.session_name}` : (state.conversation_id ? '' : ' · New');
  const qInfo = state.queued_count ? ` (Q:${state.queued_count})` : '';
  const bgInfo = state.bg_running ? ` · Bg:${state.bg_running}` : '';
  subInfo.textContent = `${state.busy ? 'Running' : 'Idle'}${qInfo}${sLabel}${bgInfo}`;

  const atBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
  chatEl.innerHTML = '';
  const rawMsgs = state.messages || [];
  const totalMsgs = state.total_messages || rawMsgs.length;
  let allMsgs = rawMsgs;
  if (window._showAllMsgs && _fullMsgsCache && _fullMsgsCache.cid === state.conversation_id && totalMsgs > rawMsgs.length) {
    const prefixCount = Math.max(0, totalMsgs - rawMsgs.length);
    allMsgs = _fullMsgsCache.messages.slice(0, prefixCount).concat(rawMsgs);
  }
  const visibleMsgs = (!window._showAllMsgs && allMsgs.length > 60) ? allMsgs.slice(-60) : allMsgs;
  if (totalMsgs > visibleMsgs.length) {
    const olderBtn = document.createElement('button');
    olderBtn.type = 'button';
    olderBtn.textContent = `Show all ${totalMsgs} messages (showing latest ${visibleMsgs.length})`;
    olderBtn.style.alignSelf = 'center';
    olderBtn.onclick = async () => {
      olderBtn.disabled = true;
      olderBtn.textContent = 'Loading all messages...';
      try {
        const res = await fetch('/api/state?all=1');
        if (res.ok) {
          const fullState = await res.json();
          _fullMsgsCache = { cid: fullState.conversation_id, messages: fullState.messages || [] };
          state = fullState;
          window._showAllMsgs = true;
        }
      } finally {
        render();
      }
    };
    chatEl.appendChild(olderBtn);
  }
  for (let i = 0; i < visibleMsgs.length; i++) {
    const m = visibleMsgs[i];
    const isLastAssistant = (m.role === 'assistant' && i === visibleMsgs.length - 1);
    const div = document.createElement('div');
    div.className = 'msg ' + m.role;
    let actionHtml = '';
    if (m.role === 'assistant') {
      const btns = [];
      if (isLastAssistant && state.busy) {
        btns.push('<button type="button" class="msg-act-btn cancel" title="取消">✕</button>');
      }
      if (m.cancelled) {
        btns.push('<button type="button" class="msg-act-btn reedit" title="重新编辑上一条输入">✎ 重新编辑</button>');
      }
      if (btns.length) actionHtml = `<span class="msg-actions">${btns.join('')}</span>`;
    }
    let html = `<div class="meta"><span>${m.role === 'user' ? 'You' : 'Agent'}${m.time ? ' · ' + esc(m.time) : ''}</span>${actionHtml}</div>`;
    if (m.role === 'assistant' && m.steps && m.steps.length) {
      html += `<div class="step-trace">${m.steps.map(esc).join('\n')}</div>`;
    }
    const bodyText = m.text || (m.role === 'assistant' && state.busy ? 'Working...' : '');
    if (m.role === 'assistant') {
      html += `<div class="md">${renderMarkdown(bodyText)}</div>`;
    } else {
      html += `<div>${esc(bodyText)}</div>`;
    }
    if (m.images && m.images.length) {
      html += '<div class="images-grid">';
      for (const img of m.images) {
        const fullUrl = withNode(`/api/file?path=${encodeURIComponent(img.path)}`);
        const thumbUrl = withNode(`/api/file?path=${encodeURIComponent(img.path)}&thumb=1`);
        html += `<div class="img-card" data-url="${esc(fullUrl)}" data-name="${esc(img.name)}">
          <img src="${esc(thumbUrl)}" loading="lazy" alt="${esc(img.name)}" onerror="this.onerror=null;this.closest('.img-card').classList.add('img-error');" />
          <div class="cap">${esc(img.name)}</div>
        </div>`;
      }
      html += '</div>';
    }
    div.innerHTML = html;
    const cancelBtn = div.querySelector('.msg-act-btn.cancel');
    if (cancelBtn) {
      cancelBtn.onclick = async () => {
        cancelBtn.disabled = true;
        await fetch('/api/stop', { method: 'POST' });
      };
    }
    const reeditBtn = div.querySelector('.msg-act-btn.reedit');
    if (reeditBtn) {
      let prevUserText = '';
      for (let j = i - 1; j >= 0; j--) {
        if (visibleMsgs[j].role === 'user' && visibleMsgs[j].text) {
          prevUserText = visibleMsgs[j].text;
          break;
        }
      }
      reeditBtn.onclick = () => {
        if (!prevUserText) return;
        inputEl.value = prevUserText;
        inputEl.style.height = '42px';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
        inputEl.focus();
      };
    }
    div.querySelectorAll('.img-card, .inline-img-preview').forEach(card => {
      card.onclick = () => openImage(card.dataset.url, card.dataset.name);
    });
    chatEl.appendChild(div);
  }
  if (atBottom) chatEl.scrollTop = chatEl.scrollHeight;
}

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    if (res.status === 401) {
      location.replace('/login');
      return false;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.error)) {
      _nodeOffline = true;
      _nodeErrorMsg = (data && data.error) ? data.error : `HTTP ${res.status}`;
      render();
      scheduleAutoReconnect();
      return false;
    }
    const wasOffline = _nodeOffline;
    _nodeOffline = false;
    _nodeErrorMsg = '';
    _reconnectAttempts = 0;
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    state = data;
    render();
    if (wasOffline) {
      connectSSE();
      loadConversations(true);
      loadModels();
      showToast('已恢复连接');
    }
    return true;
  } catch (err) {
    _nodeOffline = true;
    _nodeErrorMsg = err.message || '网络连接异常';
    render();
    scheduleAutoReconnect();
    return false;
  }
}

let _lastConvSync = 0;
let _conversations = [];

function updateSessionPickerLabel() {
  if (!state.conversation_id) {
    sessionPickerLabel.textContent = '-- Session --';
    return;
  }
  const found = _conversations.find(c => c.id === state.conversation_id);
  if (found) {
    sessionPickerLabel.textContent = `${found.updated} · ${found.preview}`;
  } else {
    sessionPickerLabel.textContent = state.session_name || state.conversation_id.slice(0, 8);
  }
}

async function loadConversations(force) {
  const now = Date.now();
  if (!force && now - _lastConvSync < 1500) return;
  _lastConvSync = now;
  const res = await fetch('/api/conversations');
  const data = await res.json();
  _conversations = data.conversations || [];
  updateSessionPickerLabel();
  if (_modalView === 'sessions' && imgModal.classList.contains('open')) {
    renderSessionPickerList();
  }
}

async function deleteConversationById(cid, label) {
  if (!cid) return;
  const desc = label ? ` (${label})` : '';
  if (!confirm(`确认删除会话 ${cid.slice(0, 8)}${desc}？此操作不可撤销。`)) return;
  const res = await fetch('/api/delete-conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: cid })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    alert(data.error || 'Failed to delete session');
    return;
  }
  await loadConversations(true);
}

function renderSessionPickerList() {
  modalTitle.textContent = `Sessions (${_conversations.length})`;
  if (!_conversations.length) {
    modalBody.innerHTML = '<div style="color:#9ca3af">No sessions found</div>';
    return;
  }
  const rows = _conversations.map(c => {
    const activeCls = (state.conversation_id === c.id) ? ' session-active' : '';
    const title = `${c.updated} · ${c.id.slice(0, 8)} · ${c.preview}`;
    return `<div class="file-row${activeCls}" data-cid="${esc(c.id)}">
      <div class="fname">${esc(title)}</div>
      <button type="button" class="danger session-del-btn" data-del-cid="${esc(c.id)}" data-del-label="${esc(c.preview || '')}">删除</button>
    </div>`;
  }).join('');
  modalBody.innerHTML = `<div class="file-list">${rows}</div>`;
  modalBody.querySelectorAll('[data-cid]').forEach(row => {
    row.onclick = async () => {
      const cid = row.dataset.cid;
      if (!cid || _switchingSession) return;
      _switchingSession = true;
      modalTitle.textContent = 'Switching session...';
      row.style.opacity = '0.6';
      window._showAllMsgs = false;
      _fullMsgsCache = null;
      try {
        const res = await fetch('/api/load-conversation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: cid })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(data.error || 'Failed to load session');
          return;
        }
        closeModal();
      } finally {
        _switchingSession = false;
      }
    };
  });
  modalBody.querySelectorAll('[data-del-cid]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      await deleteConversationById(btn.dataset.delCid, btn.dataset.delLabel);
    };
  });
}

async function openSessionPicker(silent) {
  _modalView = 'sessions';
  if (modalFabBar) modalFabBar.style.display = 'none';
  const prevScroll = silent ? modalBody.scrollTop : 0;
  clearModalHandlers();
  modalBody.classList.add('gallery-mode');
  modalRawLink.style.display = 'none';
  if (!silent) {
    modalTitle.textContent = 'Sessions';
    modalBody.innerHTML = '<div style="color:#9ca3af">Loading...</div>';
    imgModal.classList.add('open');
  }
  await loadConversations(true);
  if (_modalView !== 'sessions') return;
  renderSessionPickerList();
  imgModal.classList.add('open');
  if (silent) modalBody.scrollTop = prevScroll;
}

sessionPickerBtn.onclick = () => openSessionPicker(false);

function shortModelName(label, id) {
  const s = (label || id || '').trim();
  const tierMap = { low: 'L', medium: 'M', high: 'H', xhigh: 'XH', max: 'X' };
  let tier = '';
  const tm = s.match(/\((Low|Medium|High|XHigh|Max)\)/i);
  if (tm) tier = '-' + (tierMap[tm[1].toLowerCase()] || tm[1][0].toUpperCase());
  const base = s.replace(/\s*\([^)]*\)\s*/g, '').trim();
  if (/^Gemini\s+(\S+)\s+Flash$/i.test(base)) return RegExp.$1.toLowerCase() + 'flash' + tier;
  if (/^Gemini\s+(\S+)\s+Pro$/i.test(base)) return RegExp.$1.toLowerCase() + 'pro' + tier;
  if (/^Gemini\s+\S+\s+([A-Za-z]+)$/i.test(base)) return RegExp.$1.toLowerCase() + tier;
  if (/^Claude\s+(Opus|Sonnet)\s+(\S+)$/i.test(base)) return RegExp.$1.toLowerCase() + ' ' + RegExp.$2 + tier;
  if (/^Orchestrator$/i.test(base)) return 'orchestrator';
  return (base.toLowerCase() + tier).slice(0, 16);
}

async function loadModels(forceRefresh = false) {
  try {
    const res = await fetch(forceRefresh ? '/api/models?refresh=1' : '/api/models');
    const data = await res.json();
    if (!data.models) return;
    const cur = state.model || modelSelect.value || '';
    const filtered = data.models.filter(m => /^gemini-(4|5|3\.8)/i.test(m.id));
    let defText = 'Default';
    if (data.default) {
      const defMatch = data.models.find(m => m.id === data.default || (m.label && m.label.toLowerCase() === data.default.toLowerCase()));
      const defLabel = defMatch ? defMatch.label : data.default;
      const defShort = shortModelName(defLabel, defMatch ? defMatch.id : data.default);
      defText = `Def (${defShort})`;
    }
    modelSelect.innerHTML = `<option value="">${esc(defText)}</option>`;
    for (const m of filtered) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = shortModelName(m.label, m.id);
      modelSelect.appendChild(opt);
    }
    if (cur && ![...modelSelect.options].some(o => o.value === cur)) {
      const found = data.models.find(m => m.id === cur);
      const opt = document.createElement('option');
      opt.value = cur;
      opt.textContent = shortModelName(found ? found.label : cur, cur);
      modelSelect.appendChild(opt);
    }
    const refOpt = document.createElement('option');
    refOpt.value = '__refresh__';
    refOpt.textContent = '↻ Refresh models';
    modelSelect.appendChild(refOpt);
    modelSelect.value = cur;
  } catch (e) {}
}

renameBtn.onclick = async () => {
  const cid = state.conversation_id;
  if (!cid) {
    alert('Select or start a session first.');
    return;
  }
  const cur = state.session_name || '';
  const name = prompt('Rename session (leave blank to clear):', cur);
  if (name === null) return;
  const res = await fetch('/api/rename-conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: cid, name: name.trim() })
  });
  if (res.ok) {
    await loadConversations(true);
  }
};

modelSelect.onchange = async () => {
  if (modelSelect.value === '__refresh__') {
    modelSelect.value = state.model || '';
    await loadModels(true);
    return;
  }
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelSelect.value })
  });
};

modeSelect.onchange = async () => {
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: modeSelect.value })
  });
};

if (uploadImgBtn && imageUploadInput) {
  uploadImgBtn.onclick = () => {
    imageUploadInput.value = '';
    imageUploadInput.click();
  };

  imageUploadInput.onchange = async () => {
    const file = imageUploadInput.files && imageUploadInput.files[0];
    if (!file) return;

    showToast('正在上传图片...');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = reader.result;
        const res = await fetch(withNode('/api/upload'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: file.name,
            data: dataUrl,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showToast('上传失败: ' + (data.error || '未知错误'));
          return;
        }
        _pendingUploads.push({
          path: data.path,
          rel: data.rel,
          name: data.name,
          thumbUrl: withNode(`/api/file?path=${encodeURIComponent(data.path)}&thumb=1`),
        });
        renderPendingUploads();
        showToast('图片上传成功');
      } catch (e) {
        showToast('上传失败: ' + e.message);
      }
    };
    reader.readAsDataURL(file);
  };
}

function renderPendingUploads() {
  if (!attachedImgs) return;
  if (!_pendingUploads.length) {
    attachedImgs.style.display = 'none';
    attachedImgs.innerHTML = '';
    return;
  }
  attachedImgs.style.display = 'flex';
  attachedImgs.innerHTML = _pendingUploads.map((up, idx) => `
    <div class="attached-card" title="${esc(up.name)}">
      <img src="${esc(up.thumbUrl)}" alt="${esc(up.name)}" />
      <button type="button" class="del-btn" onclick="removePendingUpload(${idx})">✕</button>
    </div>
  `).join('');
}

window.removePendingUpload = (idx) => {
  _pendingUploads.splice(idx, 1);
  renderPendingUploads();
};

async function sendMessage(immediate = false) {
  let text = inputEl.value.trim();
  if (!text && !_pendingUploads.length) return;
  if (_pendingUploads.length) {
    const imgHints = _pendingUploads.map(up => `[附带图片: ${up.path}]`).join('\n');
    text = text ? `${imgHints}\n\n${text}` : `${imgHints}\n请查看并分析上述图片。`;
    _pendingUploads = [];
    renderPendingUploads();
  }
  inputEl.value = '';
  inputEl.style.height = '42px';
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: text, immediate: !!immediate })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Send failed' }));
    alert(err.error || 'Send failed');
  }
}

sendBtn.onclick = () => sendMessage(false);
nowBtn.onclick = () => sendMessage(true);
inputEl.addEventListener('input', () => {
  inputEl.style.height = '42px';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
});

async function startNewSessionInDir(cwdPath) {
  const res = await fetch('/api/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: cwdPath || '' })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    alert(data.error || 'Failed to switch workspace');
    return;
  }
  closeModal();
}

async function openWorkspacePicker(dirPath) {
  _modalView = 'workspace';
  clearModalHandlers();
  modalBody.classList.add('gallery-mode');
  modalRawLink.style.display = 'none';
  modalTitle.textContent = 'New Session · Workspace';
  const targetDir = dirPath !== undefined ? dirPath : (state.cwd || '');
  const q = targetDir ? ('?dir=' + encodeURIComponent(targetDir)) : '';
  const res = await fetch('/api/browse' + q);
  const data = await res.json().catch(() => ({}));
  if (_modalView !== 'workspace') return;
  const curDir = res.ok && data.current_dir ? data.current_dir : targetDir;
  let html = `<div style="display:flex; gap:6px; margin-bottom:10px;">
    <input id="wsPathInput" type="text" value="${esc(curDir)}" placeholder="/path/to/workspace"
      style="flex:1; min-width:0; background:#0b1120; color:var(--text); border:1px solid var(--border); border-radius:7px; padding:6px 8px; font-size:12px;" />
    <button id="wsStartBtn" type="button" class="primary">确定</button>
  </div>`;
  if (!res.ok) {
    html += `<div style="color:#f87171; font-size:12px;">${esc(data.error || 'Failed to browse')}</div>`;
    modalBody.innerHTML = html;
    imgModal.classList.add('open');
  } else {
    html += '<div class="file-list">';
    if (data.parent_dir) {
      html += `<div class="file-row" data-ws-nav="${esc(data.parent_dir)}">
        <span class="fname">⬆️ .. (Parent Folder)</span><span class="fmeta">DIR</span>
      </div>`;
    }
    for (const e of (data.entries || [])) {
      if (!e.is_dir) continue;
      html += `<div class="file-row" data-ws-nav="${esc(e.path)}">
        <span class="fname">📁 ${esc(e.name)}</span>
        <button type="button" class="chip" data-ws-use="${esc(e.path)}" style="padding:3px 8px;">选择</button>
      </div>`;
    }
    html += '</div>';
    modalBody.innerHTML = html;
    imgModal.classList.add('open');
    modalBody.querySelectorAll('[data-ws-nav]').forEach(el => {
      el.onclick = () => openWorkspacePicker(el.dataset.wsNav);
    });
    modalBody.querySelectorAll('[data-ws-use]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        startNewSessionInDir(btn.dataset.wsUse);
      };
    });
  }
  const wsInput = document.getElementById('wsPathInput');
  const wsStartBtn = document.getElementById('wsStartBtn');
  if (wsStartBtn && wsInput) {
    wsStartBtn.onclick = () => startNewSessionInDir(wsInput.value.trim());
  }
}

newChatBtn.onclick = () => openWorkspacePicker(state.cwd || '');

let _modalView = null; // null | 'gallery' | 'files'
let _browseDir = '';

async function openGallery(silent) {
  _modalView = 'gallery';
  if (modalFabBar) modalFabBar.style.display = 'none';
  const prevScroll = silent ? modalBody.scrollTop : 0;
  clearModalHandlers();
  modalBody.classList.add('gallery-mode');
  modalRawLink.style.display = 'none';
  if (!silent) {
    modalTitle.innerHTML = 'Images <span style="font-size:12px;opacity:0.7;cursor:pointer;margin-left:6px;" onclick="openGallery(true)">🔄</span>';
    modalBody.innerHTML = '<div style="color:#9ca3af">Loading...</div>';
    imgModal.classList.add('open');
  }
  const res = await fetch(withNode('/api/recent-images?t=' + Date.now()));
  const data = await res.json().catch(() => ({}));
  if (_modalView !== 'gallery') return;
  if (!res.ok || !Array.isArray(data.images)) {
    modalTitle.innerHTML = 'Recent Images <span style="font-size:12px;opacity:0.7;cursor:pointer;margin-left:6px;" onclick="openGallery(true)">🔄</span>';
    modalBody.innerHTML = `<div style="color:#f87171">${esc(data.error || 'Failed to load images')}</div>`;
    imgModal.classList.add('open');
    return;
  }
  modalTitle.innerHTML = `Recent Images (${data.images.length}) <span title="刷新" style="font-size:12px;opacity:0.8;cursor:pointer;margin-left:8px;" onclick="openGallery(true)">🔄</span>`;
  if (!data.images.length) {
    modalBody.innerHTML = '<div style="color:#9ca3af">No images found in recent conversations</div>';
  } else {
    const cards = data.images.map(img => {
      const fullUrl = withNode(`/api/file?path=${encodeURIComponent(img.path)}&v=${Math.floor(img.mtime || 0)}`);
      const thumbUrl = withNode(`/api/file?path=${encodeURIComponent(img.path)}&v=${Math.floor(img.mtime || 0)}&thumb=1`);
      return `<div class="img-card" data-url="${esc(fullUrl)}" data-name="${esc(img.name)}">
        <img src="${esc(thumbUrl)}" loading="lazy" alt="${esc(img.name)}" onerror="this.onerror=null;this.closest('.img-card').classList.add('img-error');" />
        <div class="cap" title="${esc(img.rel)}">${esc(img.rel)}</div>
      </div>`;
    }).join('');
    modalBody.innerHTML = `<div class="gallery-list">${cards}</div>`;
    modalBody.querySelectorAll('.img-card').forEach(card => {
      card.onclick = () => {
        _modalView = null;
        openImage(card.dataset.url, card.dataset.name);
      };
    });
  }
  imgModal.classList.add('open');
  if (silent) modalBody.scrollTop = prevScroll;
}

galleryBtn.onclick = () => openGallery(false);

function clearModalHandlers() {
  modalBody.ontouchstart = null;
  modalBody.ontouchmove = null;
  modalBody.ontouchend = null;
  modalBody.onwheel = null;
  modalBody.onclick = null;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

async function openTextFile(filePath, fileName, parentDir) {
  _modalView = null;
  clearModalHandlers();
  modalBody.classList.add('gallery-mode');
  modalRawLink.style.display = 'none';
  modalTitle.textContent = fileName;
  modalBody.innerHTML = '<div style="color:#9ca3af">Loading...</div>';
  const res = await fetch('/api/read-text?path=' + encodeURIComponent(filePath));
  const data = await res.json();
  if (!res.ok) {
    modalBody.innerHTML = `<div style="color:#f87171">${esc(data.error || 'Cannot preview file')}</div>`;
    return;
  }
  const bar = `<div style="display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap;">
    <button type="button" id="fileBackBtn">Back</button>
    <button type="button" class="primary" id="usePathBtn">Use Path in Chat</button>
  </div>`;
  modalBody.innerHTML = `<div style="width:100%; max-width:900px;">${bar}<div class="file-viewer">${esc(data.content)}</div></div>`;
  document.getElementById('fileBackBtn').onclick = () => openFileBrowser(parentDir);
  document.getElementById('usePathBtn').onclick = () => {
    const cur = inputEl.value.trim();
    inputEl.value = cur ? (cur + ' ' + filePath) : filePath;
    inputEl.style.height = '42px';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
    closeModal();
    inputEl.focus();
  };
}

async function openFileBrowser(dirPath, silent) {
  _modalView = 'files';
  if (modalFabBar) modalFabBar.style.display = 'none';
  if (dirPath !== undefined) _browseDir = dirPath;
  const prevScroll = silent ? modalBody.scrollTop : 0;
  clearModalHandlers();
  modalBody.classList.add('gallery-mode');
  modalRawLink.style.display = 'none';
  const targetDir = dirPath !== undefined ? dirPath : _browseDir;
  const q = targetDir ? ('?dir=' + encodeURIComponent(targetDir)) : '';
  const res = await fetch('/api/browse' + q);
  const data = await res.json();
  if (_modalView !== 'files') return;
  if (!res.ok) {
    modalTitle.textContent = 'Files';
    modalBody.innerHTML = `<div style="color:#f87171">${esc(data.error || 'Failed to browse')}</div>`;
    imgModal.classList.add('open');
    return;
  }
  _browseDir = data.current_dir;
  modalTitle.textContent = data.current_dir;
  let html = '<div class="file-list">';
  if (data.parent_dir) {
    html += `<div class="file-row" data-dir="${esc(data.parent_dir)}">
      <span class="fname">⬆️ .. (Parent Folder)</span><span class="fmeta">DIR</span>
    </div>`;
  }
  for (const e of data.entries) {
    if (e.is_dir) {
      html += `<div class="file-row" data-dir="${esc(e.path)}">
        <span class="fname">📁 ${esc(e.name)}</span><span class="fmeta">DIR</span>
      </div>`;
    } else {
      const icon = e.is_image ? '🖼️' : '📄';
      html += `<div class="file-row" data-file="${esc(e.path)}" data-name="${esc(e.name)}" data-img="${e.is_image ? '1' : '0'}">
        <span class="fname">${icon} ${esc(e.name)}</span><span class="fmeta">${fmtSize(e.size)}</span>
      </div>`;
    }
  }
  html += '</div>';
  modalBody.innerHTML = html;
  modalBody.querySelectorAll('[data-dir]').forEach(el => {
    el.onclick = () => openFileBrowser(el.dataset.dir, false);
  });
  modalBody.querySelectorAll('[data-file]').forEach(el => {
    el.onclick = () => {
      _modalView = null;
      if (el.dataset.img === '1') {
        openImage('/api/file?path=' + encodeURIComponent(el.dataset.file), el.dataset.name);
      } else {
        openTextFile(el.dataset.file, el.dataset.name, data.current_dir);
      }
    };
  });
  imgModal.classList.add('open');
  if (silent) modalBody.scrollTop = prevScroll;
}

filesBtn.onclick = () => openFileBrowser('', false);

setInterval(() => {
  if (!imgModal.classList.contains('open')) return;
  if (_modalView === 'gallery') openGallery(true);
  else if (_modalView === 'files') openFileBrowser(undefined, true);
  else if (_modalView === 'sessions') openSessionPicker(true);
}, 4000);

async function loadNodes() {
  try {
    const res = await fetch('/api/nodes');
    if (!res.ok) return;
    const data = await res.json();
    const nodes = data.nodes || [];
    if (nodes.length <= 1) {
      nodeSelect.style.display = 'none';
      _currentNode = nodes.length ? nodes[0].id : 'local';
      return;
    }
    nodeSelect.innerHTML = '';
    for (const n of nodes) {
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = n.name;
      nodeSelect.appendChild(opt);
    }
    if (!nodes.some(n => n.id === _currentNode)) {
      _currentNode = nodes[0].id;
    }
    nodeSelect.value = _currentNode;
    nodeSelect.style.display = 'inline-block';
  } catch (e) {}
}

nodeSelect.onchange = () => {
  _currentNode = nodeSelect.value || 'local';
  localStorage.setItem('agy_node', _currentNode);
  window._showAllMsgs = false;
  _fullMsgsCache = null;
  _conversations = [];
  _nodeOffline = false;
  _nodeErrorMsg = '';
  _reconnectAttempts = 0;
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  statusDot.className = 'dot connecting';
  subInfo.textContent = 'Connecting...';
  connectSSE();
  fetchState();
  loadConversations(true);
  loadModels();
};

function connectSSE() {
  if (_sseTimer) {
    clearTimeout(_sseTimer);
    _sseTimer = null;
  }
  if (_sse) {
    try { _sse.close(); } catch (e) {}
    _sse = null;
  }
  const es = new EventSource(withNode('/api/events'));
  _sse = es;
  es.onmessage = (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (payload.type === 'state') {
        const wasOffline = _nodeOffline;
        _nodeOffline = false;
        _nodeErrorMsg = '';
        _reconnectAttempts = 0;
        if (_reconnectTimer) {
          clearTimeout(_reconnectTimer);
          _reconnectTimer = null;
        }
        state = payload.state;
        render();
        if (wasOffline) {
          loadConversations(true);
          loadModels();
          showToast('已恢复连接');
        }
      }
    } catch (e) {}
  };
  es.onerror = () => {
    es.close();
    if (_sse === es) {
      _sse = null;
      statusDot.className = 'dot connecting';
      subInfo.textContent = 'Connecting...';
      scheduleAutoReconnect();
    }
  };
}

window.addEventListener('online', () => {
  showToast('网络已恢复，正在连接...');
  triggerReconnectNow();
});

window.addEventListener('focus', () => {
  if (_nodeOffline || !_sse) {
    triggerReconnectNow();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (_nodeOffline || !_sse) {
      triggerReconnectNow();
    } else {
      fetchState();
    }
  }
});

loadNodes().then(() => {
  fetchState().then(() => {
    connectSSE();
    loadConversations(true);
    loadModels();
  });
});
