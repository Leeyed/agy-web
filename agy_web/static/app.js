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
let _pendingUploads = [];

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

function withNode(url) {
  if (!_currentNode || _currentNode === 'local') return url;
  if (!url.startsWith('/api/') || url.startsWith('/api/nodes') || url.startsWith('/api/login')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'node=' + encodeURIComponent(_currentNode);
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
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|file:\/\/[^\s)]+)\)/g, (_, label, url) => {
    let p = url;
    let full = url;
    let thumb = url;
    if (url.startsWith('file://')) {
      p = url.slice(7).split('#')[0];
      full = withNode(`/api/file?path=${encodeURIComponent(p)}`);
      thumb = withNode(`/api/file?path=${encodeURIComponent(p)}&thumb=1`);
    }
    const name = label || (p.split('/').pop() || 'image');
    return `<div class="inline-img-preview" data-url="${esc(full)}" data-name="${esc(name)}">
      <img src="${esc(thumb)}" loading="lazy" alt="${esc(name)}" />
      <div class="inline-img-cap">🖼️ ${esc(name)}</div>
    </div>`;
  });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|file:\/\/[^\s)]+)\)/g, (_, label, url) => {
    if (url.startsWith('file://')) {
      const p = url.slice(7).split('#')[0];
      if (/\.(png|jpg|jpeg|webp|gif|svg)$/i.test(p)) {
        const full = withNode(`/api/file?path=${encodeURIComponent(p)}`);
        const thumb = withNode(`/api/file?path=${encodeURIComponent(p)}&thumb=1`);
        return `<div class="inline-img-preview" data-url="${esc(full)}" data-name="${esc(label)}">
          <img src="${esc(thumb)}" loading="lazy" alt="${esc(label)}" />
          <div class="inline-img-cap">🖼️ ${esc(label)}</div>
        </div>`;
      }
      return `<span>${label}</span>`;
    }
    if (/\.(png|jpg|jpeg|webp|gif|svg)(\?.*)?$/i.test(url)) {
      return `<div class="inline-img-preview" data-url="${esc(url)}" data-name="${esc(label)}">
        <img src="${esc(url)}" loading="lazy" alt="${esc(label)}" />
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

function applyZoomTransform(img) {
  img.style.transform = `translate(${zoomState.tx}px, ${zoomState.ty}px) scale(${zoomState.scale})`;
}

function closeModal() {
  _modalView = null;
  if (modalFabBar) modalFabBar.style.display = 'none';
  imgModal.classList.remove('open');
  modalBody.classList.remove('gallery-mode');
  zoomState = { scale: 1, tx: 0, ty: 0 };
  _currentBlob = null;
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
      zoomState.scale = Math.min(6, Math.max(1, startScale * (d / startDist)));
      if (zoomState.scale === 1) { zoomState.tx = 0; zoomState.ty = 0; }
      applyZoomTransform(img);
    } else if (mode === 'pan' && e.touches.length === 1) {
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.hypot(dx, dy) > 8) moved = true;
      if (zoomState.scale > 1) {
        e.preventDefault();
        zoomState.tx = startTx + dx;
        zoomState.ty = startTy + dy;
        applyZoomTransform(img);
      }
    }
  };

  modalBody.ontouchend = (e) => {
    if (e.target.closest('#modalFabBar')) return;
    if (e.touches.length === 0 && !moved) {
      const now = Date.now();
      if (now - lastTap < 260) {
        clearTimeout(tapTimer);
        lastTap = 0;
        if (zoomState.scale > 1.1) {
          zoomState = { scale: 1, tx: 0, ty: 0 };
        } else {
          zoomState = { scale: 2.5, tx: 0, ty: 0 };
        }
        applyZoomTransform(img);
      } else {
        lastTap = now;
        tapTimer = setTimeout(() => { closeModal(); }, 270);
      }
    }
    if (e.touches.length === 0) mode = null;
  };

  // Desktop mouse wheel zoom & click-to-close
  modalBody.onwheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    zoomState.scale = Math.min(6, Math.max(1, zoomState.scale * factor));
    if (zoomState.scale === 1) { zoomState.tx = 0; zoomState.ty = 0; }
    applyZoomTransform(img);
  };
  modalBody.onclick = (e) => {
    if (e.target.closest('#modalFabBar')) return;
    if ('ontouchstart' in window && navigator.maxTouchPoints > 0) return;
    closeModal();
  };
}

async function openImage(url, label) {
  const baseUrl = url.replace(/[&?](thumb|preview)=1/g, '');
  const fullUrl = withNode(baseUrl);
  _currentFullUrl = fullUrl;
  _currentLabel = label || 'Image';
  _currentBlob = null;

  modalTitle.textContent = label || 'Image Preview';
  modalRawLink.style.display = 'inline-block';
  modalRawLink.href = fullUrl;
  modalBody.classList.remove('gallery-mode');
  if (modalFabBar) modalFabBar.style.display = 'flex';

  modalOrigBtn.disabled = false;
  modalOrigBtn.style.display = 'flex';
  modalOrigBtn.textContent = '原图';
  modalSaveBtn.disabled = false;
  modalSaveBtn.textContent = '保存到相册';
  zoomState = { scale: 1, tx: 0, ty: 0 };

  let displayUrl = fullUrl;
  const pm = baseUrl.match(/[?&]path=([^&]+)/);
  if (pm) {
    try {
      const infoRes = await fetch('/api/file-info?path=' + pm[1]);
      if (infoRes.ok) {
        const info = await infoRes.json();
        if (info && info.size) {
          modalOrigBtn.textContent = `原图 (${fmtSize(info.size)})`;
          if (info.size > 3 * 1024 * 1024) {
            displayUrl = withNode(baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'preview=1');
          }
        }
      }
    } catch (e) {}
  }
  _currentDisplayUrl = displayUrl;

  modalBody.innerHTML = `<img id="zoomImg" src="${displayUrl}" alt="${esc(label)}" />`;
  const img = document.getElementById('zoomImg');
  attachImageZoomAndTapClose(img);
  imgModal.classList.add('open');

  // 原图进度下载并原地刷新
  modalOrigBtn.onclick = (e) => {
    e.stopPropagation();
    if (modalOrigBtn.disabled) return;
    modalOrigBtn.disabled = true;
    modalOrigBtn.textContent = '0%';
    const xhr = new XMLHttpRequest();
    xhr.open('GET', fullUrl, true);
    xhr.responseType = 'blob';
    xhr.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        modalOrigBtn.textContent = `${pct}%`;
      } else {
        modalOrigBtn.textContent = '下载中...';
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        modalOrigBtn.textContent = '100%';
        const blob = xhr.response;
        _currentBlob = blob;
        const blobUrl = URL.createObjectURL(blob);
        const zImg = document.getElementById('zoomImg');
        if (zImg) {
          zImg.src = blobUrl;
        }
        setTimeout(() => {
          modalOrigBtn.textContent = '已是原图';
        }, 200);
      } else {
        modalOrigBtn.disabled = false;
        modalOrigBtn.textContent = '重试原图';
        showToast('原图加载失败');
      }
    };
    xhr.onerror = () => {
      modalOrigBtn.disabled = false;
      modalOrigBtn.textContent = '重试原图';
      showToast('网络异常，原图加载失败');
    };
    xhr.send();
  };

  // 保存到相册
  modalSaveBtn.onclick = async (e) => {
    e.stopPropagation();
    try {
      modalSaveBtn.disabled = true;
      modalSaveBtn.textContent = '处理中...';
      let blob = _currentBlob;
      if (!blob) {
        const r = await fetch(_currentDisplayUrl);
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
        const fullUrl = `/api/file?path=${encodeURIComponent(img.path)}`;
        const thumbUrl = withNode(`${fullUrl}&thumb=1`);
        html += `<div class="img-card" data-url="${esc(fullUrl)}" data-name="${esc(img.name)}">
          <img src="${esc(thumbUrl)}" loading="lazy" alt="${esc(img.name)}" />
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
  const res = await fetch('/api/state');
  if (res.status === 401) {
    location.replace('/login');
    return;
  }
  state = await res.json();
  render();
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
      const fullUrl = `/api/file?path=${encodeURIComponent(img.path)}&v=${Math.floor(img.mtime || 0)}`;
      const thumbUrl = withNode(`${fullUrl}&thumb=1`);
      return `<div class="img-card" data-url="${esc(fullUrl)}" data-name="${esc(img.name)}">
        <img src="${esc(thumbUrl)}" loading="lazy" alt="${esc(img.name)}" />
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
        state = payload.state;
        render();
      }
    } catch (e) {}
  };
  es.onerror = () => {
    es.close();
    if (_sse === es) {
      _sse = null;
      _sseTimer = setTimeout(connectSSE, 2000);
    }
  };
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) fetchState();
});

loadNodes().then(() => {
  fetchState().then(() => {
    connectSSE();
    loadConversations(true);
    loadModels();
  });
});
