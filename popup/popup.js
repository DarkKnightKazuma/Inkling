'use strict';

const COLORS = {
  yellow: 'rgba(255, 235, 59, 0.7)',
  green: 'rgba(129, 199, 132, 0.7)',
  blue: 'rgba(100, 181, 246, 0.7)',
  pink: 'rgba(240, 98, 146, 0.7)',
  purple: 'rgba(186, 104, 200, 0.7)',
};

let allHighlights = [];
let collections = [];
let currentCollectionId = 'all'; // 'all' 表示查看所有
let selectedIds = new Set();
let selectMode = false;

// 筛选状态
let searchQuery = '';
let filterColor = 'all';
let filterDatePreset = 'all';
let filterDateFrom = null; // Date object or null
let filterDateTo = null;
let filterSite = 'all';
let sortOrder = 'desc'; // 'desc' = 新→旧, 'asc' = 旧→新

// ── 通信 ──

function sendMsg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, r => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(r);
    });
  });
}

// ── 初始化 ──

document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  setupSearch();
  setupFilters();
  setupExport();
  setupSelectMode();
  setupBatchActions();
  setupAddCollection();
  setupSort();
  setupClickCopy();
  setupContextMenu();
  renderAll();
});

async function loadData() {
  const [hlRes, colRes] = await Promise.all([
    sendMsg({ type: 'GET_HIGHLIGHTS' }),
    sendMsg({ type: 'GET_COLLECTIONS' }),
  ]);
  allHighlights = (hlRes?.highlights || []).sort((a, b) => b.createdAt - a.createdAt);
  collections = colRes?.collections || [{ id: 'default', name: '全部收藏', isDefault: true }];
  populateSiteFilter();
  renderCollections();
}

// ── 搜索 ──

function setupSearch() {
  const input = document.getElementById('search-input');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { searchQuery = input.value.trim().toLowerCase(); renderAll(); }, 200);
  });
}

// ── 筛选 ──

function setupFilters() {
  const colorEl = document.getElementById('filter-color');
  const siteEl = document.getElementById('filter-site');

  colorEl.addEventListener('change', () => {
    filterColor = colorEl.value;
    colorEl.classList.toggle('has-filter', filterColor !== 'all');
    renderAll();
  });
  siteEl.addEventListener('change', () => {
    filterSite = siteEl.value;
    siteEl.classList.toggle('has-filter', filterSite !== 'all');
    renderAll();
  });

  setupDateFilter();
}

function setupDateFilter() {
  const trigger = document.getElementById('date-trigger');
  const panel = document.getElementById('date-panel');
  const rangeRow = document.getElementById('date-range-row');
  const dateFrom = document.getElementById('date-from');
  const dateTo = document.getElementById('date-to');
  const label = document.getElementById('date-label');

  // 设置日期输入框默认最大值为今天
  const todayStr = toDateStr(new Date());
  dateTo.max = todayStr;
  dateFrom.max = todayStr;

  // 展开/收起面板
  trigger.addEventListener('click', () => {
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
  });

  // 预设按钮
  panel.querySelectorAll('.date-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.date-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const preset = btn.dataset.preset;
      filterDatePreset = preset;

      if (preset === 'custom') {
        rangeRow.style.display = 'flex';
        applyCustomDateRange();
      } else {
        rangeRow.style.display = 'none';
        filterDateFrom = null;
        filterDateTo = null;
        dateFrom.value = '';
        dateTo.value = '';
      }

      updateDateLabel();
      renderAll();
    });
  });

  // 自定义日期范围变化
  dateFrom.addEventListener('change', () => { applyCustomDateRange(); renderAll(); });
  dateTo.addEventListener('change', () => { applyCustomDateRange(); renderAll(); });
}

function applyCustomDateRange() {
  const fromVal = document.getElementById('date-from').value;
  const toVal = document.getElementById('date-to').value;
  filterDateFrom = fromVal ? new Date(fromVal + 'T00:00:00') : null;
  filterDateTo = toVal ? new Date(toVal + 'T23:59:59') : null;
  updateDateLabel();
}

function updateDateLabel() {
  const label = document.getElementById('date-label');
  const trigger = document.getElementById('date-trigger');

  const labels = {
    all: '全部时间',
    today: '今天',
    week: '近7天',
    month: '近30天',
  };

  if (filterDatePreset === 'custom') {
    const from = document.getElementById('date-from').value;
    const to = document.getElementById('date-to').value;
    if (from && to) label.textContent = `${from} ~ ${to}`;
    else if (from) label.textContent = `${from} 起`;
    else if (to) label.textContent = `至 ${to}`;
    else label.textContent = '选择日期';
  } else {
    label.textContent = labels[filterDatePreset] || '全部时间';
  }

  trigger.classList.toggle('has-filter', filterDatePreset !== 'all');
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function populateSiteFilter() {
  const sites = [...new Set(allHighlights.map(h => extractDomain(h.url)))].sort();
  const el = document.getElementById('filter-site');
  el.innerHTML = '<option value="all">全部网站</option>' +
    sites.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
}

function getFilteredHighlights() {
  let list = allHighlights;

  // 收藏夹筛选
  if (currentCollectionId !== 'all') {
    list = list.filter(h => (h.collectionId || 'default') === currentCollectionId);
  }

  // 颜色
  if (filterColor !== 'all') list = list.filter(h => h.color === filterColor);

  // 日期
  if (filterDatePreset !== 'all') {
    if (filterDatePreset === 'custom') {
      if (filterDateFrom) list = list.filter(h => h.createdAt >= filterDateFrom.getTime());
      if (filterDateTo) list = list.filter(h => h.createdAt <= filterDateTo.getTime());
    } else {
      const now = Date.now();
      const cutoff = { today: now - 86400000, week: now - 7 * 86400000, month: now - 30 * 86400000 }[filterDatePreset];
      if (cutoff) list = list.filter(h => h.createdAt >= cutoff);
    }
  }

  // 网站
  if (filterSite !== 'all') {
    list = list.filter(h => extractDomain(h.url) === filterSite);
  }

  // 搜索
  if (searchQuery) {
    list = list.filter(h =>
      h.text.toLowerCase().includes(searchQuery) ||
      (h.title || '').toLowerCase().includes(searchQuery) ||
      (h.note || '').toLowerCase().includes(searchQuery) ||
      (h.tags || []).some(t => t.toLowerCase().includes(searchQuery))
    );
  }

  // 排序
  list = [...list].sort((a, b) =>
    sortOrder === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt
  );

  return list;
}

// ── 排序 ──

function setupSort() {
  document.getElementById('btn-sort').addEventListener('click', () => {
    sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
    document.getElementById('sort-label').textContent = sortOrder === 'desc' ? '新→旧' : '旧→新';
    document.getElementById('btn-sort').classList.toggle('active', sortOrder === 'asc');
    renderAll();
  });
}

// ── 点击高亮复制开关 ──

function setupClickCopy() {
  const btn = document.getElementById('btn-click-copy');

  chrome.storage.local.get(['clickToCopy'], (res) => {
    const enabled = !!res.clickToCopy;
    btn.classList.toggle('active', enabled);
  });

  btn.addEventListener('click', async () => {
    const res = await chrome.storage.local.get(['clickToCopy']);
    const newVal = !res.clickToCopy;
    await chrome.storage.local.set({ clickToCopy: newVal });
    btn.classList.toggle('active', newVal);
    showToast(newVal ? '点击复制已开启' : '点击复制已关闭');
  });
}

// ── 浮动工具栏开关 ──

function setupContextMenu() {
  const btn = document.getElementById('btn-toolbar');

  chrome.storage.local.get(['toolbarEnabled'], (res) => {
    const enabled = res.toolbarEnabled !== false; // 默认开启
    btn.classList.toggle('active', enabled);
  });

  btn.addEventListener('click', async () => {
    const res = await chrome.storage.local.get(['toolbarEnabled']);
    const newVal = res.toolbarEnabled === false; // 切换
    await chrome.storage.local.set({ toolbarEnabled: newVal });
    btn.classList.toggle('active', newVal);
    showToast(newVal ? '浮动工具栏已开启' : '浮动工具栏已关闭');
  });
}

// ── 多选模式 ──

function setupSelectMode() {
  document.getElementById('btn-select-mode').addEventListener('click', () => {
    selectMode = !selectMode;
    selectedIds.clear();
    document.getElementById('btn-select-mode').classList.toggle('active', selectMode);
    document.getElementById('select-all-area').style.display = selectMode ? 'flex' : 'none';
    updateBatchBar();
    renderAll();
  });

  document.getElementById('cb-select-all').addEventListener('change', (e) => {
    const filtered = getFilteredHighlights();
    if (e.target.checked) {
      filtered.forEach(h => selectedIds.add(h.id));
    } else {
      selectedIds.clear();
    }
    updateBatchBar();
    renderAll();
  });
}

function updateBatchBar() {
  const bar = document.getElementById('batch-bar');
  if (selectMode && selectedIds.size > 0) {
    bar.style.display = 'flex';
    document.getElementById('batch-count').textContent = `已选 ${selectedIds.size} 条`;
  } else {
    bar.style.display = 'none';
  }
}

// ── 批量操作 ──

function setupBatchActions() {
  document.getElementById('batch-copy').addEventListener('click', () => {
    const selected = getFilteredHighlights().filter(h => selectedIds.has(h.id));
    const texts = selected.map(h => h.text);
    navigator.clipboard.writeText(texts.join('\n\n')).then(() => showToast(`已复制 ${texts.length} 条金句`));
  });

  document.getElementById('batch-move').addEventListener('click', () => {
    if (collections.length <= 1) {
      showToast('请先创建收藏夹');
      return;
    }
    showMoveMenu();
  });

  document.getElementById('batch-export').addEventListener('click', () => {
    const selected = getFilteredHighlights().filter(h => selectedIds.has(h.id));
    if (selected.length === 0) return;

    const md = generateMarkdown(selected);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `灵犀摘_${fmtDate(Date.now())}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${selected.length} 条金句`);
  });

  document.getElementById('batch-delete').addEventListener('click', async () => {
    const ok = await showModal({ title: '批量删除', message: `确定删除选中的 ${selectedIds.size} 条金句？此操作不可撤销。`, danger: true });
    if (!ok) return;
    const ids = [...selectedIds];
    await sendMsg({ type: 'DELETE_HIGHLIGHTS_BATCH', ids });
    notifyTab({ type: 'REMOVE_HIGHLIGHTS_BATCH', ids });
    allHighlights = allHighlights.filter(h => !selectedIds.has(h.id));
    selectedIds.clear();
    updateBatchBar();
    renderAll();
    showToast('已删除');
  });
}

function showMoveMenu() {
  removeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctx-menu';

  collections.forEach(col => {
    const btn = document.createElement('button');
    btn.className = 'ctx-item';
    btn.textContent = col.name;
    btn.addEventListener('click', async () => {
      const ids = [...selectedIds];
      await sendMsg({ type: 'UPDATE_HIGHLIGHTS_BATCH', ids, updates: { collectionId: col.id } });
      allHighlights.forEach(h => { if (selectedIds.has(h.id)) h.collectionId = col.id; });
      selectedIds.clear();
      updateBatchBar();
      renderAll();
      removeCtxMenu();
      showToast(`已移动到「${col.name}」`);
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);

  const moveBtn = document.getElementById('batch-move');
  const rect = moveBtn.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.bottom = `${document.body.clientHeight - rect.top + 4}px`;
  menu.style.top = 'auto';

  setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 10);
}

function removeCtxMenu() {
  document.getElementById('ctx-menu')?.remove();
}

// ── 收藏夹 ──

function setupAddCollection() {
  document.getElementById('btn-add-collection').addEventListener('click', async () => {
    const name = await showModal({ title: '新建收藏夹', input: true, placeholder: '输入收藏夹名称' });
    if (!name?.trim()) return;
    await sendMsg({ type: 'CREATE_COLLECTION', name: name.trim() });
    await reloadCollections();
    showToast(`收藏夹「${name.trim()}」已创建`);
  });
}

async function reloadCollections() {
  const res = await sendMsg({ type: 'GET_COLLECTIONS' });
  collections = res?.collections || [{ id: 'default', name: '全部收藏', isDefault: true }];
  renderCollections();
}

function renderCollections() {
  const container = document.getElementById('collections-tabs');

  // "全部" 虚拟标签
  let html = `<div class="col-tab${currentCollectionId === 'all' ? ' active' : ''}" data-col-id="all">
    <span>全部</span><span class="col-count">${allHighlights.length}</span>
  </div>`;

  collections.forEach(col => {
    const count = allHighlights.filter(h => (h.collectionId || 'default') === col.id).length;
    html += `<div class="col-tab${currentCollectionId === col.id ? ' active' : ''}" data-col-id="${col.id}">
      <span>${esc(col.name)}</span><span class="col-count">${count}</span>
      ${!col.isDefault ? '<span class="col-menu-btn" data-col-menu="' + col.id + '" title="管理">⋯</span>' : ''}
    </div>`;
  });

  container.innerHTML = html;

  container.querySelectorAll('.col-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.col-menu-btn')) return;
      currentCollectionId = tab.dataset.colId;
      selectedIds.clear();
      updateBatchBar();
      renderCollections();
      renderAll();
    });
  });

  container.querySelectorAll('.col-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showColMenu(btn.dataset.colMenu, btn);
    });
  });
}

function showColMenu(colId, anchor) {
  removeCtxMenu();
  const col = collections.find(c => c.id === colId);
  if (!col) return;

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctx-menu';

  const renameBtn = document.createElement('button');
  renameBtn.className = 'ctx-item';
  renameBtn.textContent = '重命名';
  renameBtn.addEventListener('click', async () => {
    removeCtxMenu();
    const name = await showModal({ title: '重命名收藏夹', input: true, placeholder: '新名称', defaultValue: col.name });
    if (!name?.trim() || name.trim() === col.name) return;
    await sendMsg({ type: 'RENAME_COLLECTION', id: colId, name: name.trim() });
    await reloadCollections();
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'ctx-item danger';
  deleteBtn.textContent = '删除收藏夹';
  deleteBtn.addEventListener('click', async () => {
    removeCtxMenu();
    const ok = await showModal({ title: '删除收藏夹', message: `确定删除「${col.name}」？其中的金句会移回默认收藏夹。`, danger: true });
    if (!ok) return;
    await sendMsg({ type: 'DELETE_COLLECTION', id: colId });
    if (currentCollectionId === colId) currentCollectionId = 'all';
    await loadData();
    renderAll();
    showToast('收藏夹已删除');
  });

  menu.appendChild(renameBtn);
  menu.appendChild(deleteBtn);
  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, 300)}px`;
  menu.style.top = `${rect.bottom + 4}px`;

  setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 10);
}

// ── 导出 ──

function setupExport() {
  document.getElementById('btn-export').addEventListener('click', () => {
    const filtered = getFilteredHighlights();
    if (filtered.length === 0) { showToast('没有可导出的数据'); return; }

    const md = generateMarkdown(filtered);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `灵犀摘_${fmtDate(Date.now())}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${filtered.length} 条金句`);
  });
}

function generateMarkdown(highlights) {
  const grouped = groupByPage(highlights);
  let md = `# 灵犀摘 - 金句收藏\n\n> 导出时间：${new Date().toLocaleString('zh-CN')}\n\n`;

  for (const [url, items] of Object.entries(grouped)) {
    md += `## ${items[0].title || url}\n\n来源：${url}\n\n`;
    for (const item of items) {
      md += `> ${item.text}\n\n`;
      if (item.note) md += `📝 ${item.note}\n\n`;
      if (item.tags?.length) md += `🏷️ ${item.tags.join(', ')}\n\n`;
      md += `— *${new Date(item.createdAt).toLocaleString('zh-CN')}*\n\n---\n\n`;
    }
  }
  return md;
}

// ── 渲染 ──

function renderAll() {
  const filtered = getFilteredHighlights();
  renderStats(filtered);
  renderHighlights(filtered);

  // 全选checkbox同步
  const cbAll = document.getElementById('cb-select-all');
  if (filtered.length > 0 && filtered.every(h => selectedIds.has(h.id))) {
    cbAll.checked = true;
    cbAll.indeterminate = false;
  } else if (filtered.some(h => selectedIds.has(h.id))) {
    cbAll.checked = false;
    cbAll.indeterminate = true;
  } else {
    cbAll.checked = false;
    cbAll.indeterminate = false;
  }
}

function renderStats(highlights) {
  const pages = new Set(highlights.map(h => h.url)).size;
  document.getElementById('stats').innerHTML = `
    <span><span class="stat-num">${highlights.length}</span> 条金句</span>
    <span>来自 <span class="stat-num">${pages}</span> 个页面</span>
  `;
}

function renderHighlights(highlights) {
  const listEl = document.getElementById('highlight-list');
  const emptyEl = document.getElementById('empty-state');

  if (highlights.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'flex';
    return;
  }

  emptyEl.style.display = 'none';
  const grouped = groupByPage(highlights);

  listEl.innerHTML = Object.entries(grouped).map(([url, items]) => `
    <div class="page-group">
      <div class="page-title" data-url="${esc(url)}" title="${esc(url)}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <span class="page-title-text">${esc(items[0].title || extractDomain(url))}</span>
      </div>
      ${items.map(renderCard).join('')}
    </div>
  `).join('');

  // 加上/移除 select-mode class
  listEl.classList.toggle('select-mode', selectMode);
  bindCardEvents();
}

function renderCard(item) {
  const colorHex = COLORS[item.color] || COLORS.yellow;
  const checked = selectedIds.has(item.id) ? 'checked' : '';

  return `
    <div class="hl-card${selectedIds.has(item.id) ? ' selected' : ''}" data-id="${item.id}">
      <div class="hl-checkbox"><input type="checkbox" ${checked} data-cb-id="${item.id}"></div>
      <div class="hl-color-bar" style="background:${colorHex}"></div>
      <div class="hl-card-body">
        <div class="hl-text">${esc(item.text)}</div>
        ${item.note ? `<div class="hl-note-text">📝 ${esc(item.note)}</div>` : ''}
        ${(item.tags?.length) ? `<div class="hl-tags">${item.tags.map(t => `<span class="hl-tag">${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="hl-meta">
          <span class="hl-source" title="${esc(item.url)}">${esc(extractDomain(item.url))}</span>
          <span class="hl-time">${fmtRelative(item.createdAt)}</span>
        </div>
        <div class="hl-actions">
          <button class="hl-action-btn" data-action="copy">复制</button>
          <button class="hl-action-btn" data-action="note">笔记</button>
          <button class="hl-action-btn" data-action="tag">标签</button>
          <button class="hl-action-btn" data-action="open">来源</button>
          <button class="hl-action-btn danger" data-action="delete">删除</button>
        </div>
      </div>
    </div>`;
}

// ── 事件绑定 ──

function bindCardEvents() {
  document.querySelectorAll('.hl-card').forEach(card => {
    const id = card.dataset.id;
    const item = allHighlights.find(h => h.id === id);
    if (!item) return;

    // 单条操作
    card.querySelectorAll('.hl-action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        switch (btn.dataset.action) {
          case 'copy': navigator.clipboard.writeText(item.text).then(() => showToast('已复制')); break;
          case 'note': promptNote(id, item, card); break;
          case 'tag': promptTag(id, item); break;
          case 'open': chrome.tabs.create({ url: item.url }); break;
          case 'delete': deleteItem(id); break;
        }
      });
    });

    card.querySelector('.hl-text')?.addEventListener('click', () => {
      card.querySelector('.hl-text').classList.toggle('expanded');
    });

    // 多选checkbox
    const cb = card.querySelector('input[data-cb-id]');
    if (cb) {
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
        card.classList.toggle('selected', cb.checked);
        updateBatchBar();
        // 同步全选状态
        const filtered = getFilteredHighlights();
        const cbAll = document.getElementById('cb-select-all');
        cbAll.checked = filtered.every(h => selectedIds.has(h.id));
        cbAll.indeterminate = !cbAll.checked && filtered.some(h => selectedIds.has(h.id));
      });
    }
  });

  document.querySelectorAll('.page-title').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.url) chrome.tabs.create({ url: el.dataset.url });
    });
  });
}

// ── 单条操作 ──

function promptNote(id, item, card) {
  let noteArea = card.querySelector('.hl-note-text')?.parentElement;
  if (!noteArea) {
    noteArea = document.createElement('div');
    card.querySelector('.hl-card-body').insertBefore(noteArea, card.querySelector('.hl-meta'));
  }
  noteArea.innerHTML = `<textarea class="hl-note-input" rows="2" placeholder="写下你的想法...">${esc(item.note || '')}</textarea>`;
  const ta = noteArea.querySelector('textarea');
  ta.focus();

  ta.addEventListener('blur', () => {
    const note = ta.value.trim();
    item.note = note;
    sendMsg({ type: 'UPDATE_HIGHLIGHT', id, updates: { note } });
    if (note) noteArea.innerHTML = `<div class="hl-note-text">📝 ${esc(note)}</div>`;
    else noteArea.remove();
  });

  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); } });
}

async function promptTag(id, item) {
  const input = await showModal({
    title: '编辑标签',
    input: true,
    placeholder: '多个标签用逗号分隔',
    defaultValue: (item.tags || []).join(', '),
  });
  if (input === null) return;
  const tags = input.split(/[,，]/).map(t => t.trim()).filter(Boolean);
  item.tags = tags;
  sendMsg({ type: 'UPDATE_HIGHLIGHT', id, updates: { tags } });
  renderAll();
}

async function deleteItem(id) {
  const ok = await showModal({ title: '删除金句', message: '确定删除这条金句？', danger: true });
  if (!ok) return;
  allHighlights = allHighlights.filter(h => h.id !== id);
  selectedIds.delete(id);
  sendMsg({ type: 'DELETE_HIGHLIGHT', id });
  notifyTab({ type: 'REMOVE_HIGHLIGHT', id });
  updateBatchBar();
  renderAll();
  showToast('已删除');
}

function notifyTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
    }
  });
}

// ── 工具函数 ──

function groupByPage(list) {
  const g = {};
  for (const h of list) { (g[h.url] ||= []).push(h); }
  return g;
}

function extractDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function fmtRelative(ts) {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000), h = Math.floor(d / 3600000), day = Math.floor(d / 86400000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  if (h < 24) return `${h}小时前`;
  if (day < 7) return `${day}天前`;
  return fmtDate(ts);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function showToast(msg) {
  let t = document.querySelector('.popup-toast');
  if (!t) { t = document.createElement('div'); t.className = 'popup-toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('visible');
  setTimeout(() => t.classList.remove('visible'), 1800);
}

// ── 模态对话框（替代 prompt / confirm）──

function showModal({ title, input, message, placeholder, defaultValue, danger }) {
  return new Promise(resolve => {
    const overlay = document.getElementById('modal-overlay');
    const titleEl = document.getElementById('modal-title');
    const inputEl = document.getElementById('modal-input');
    const msgEl = document.getElementById('modal-msg');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');

    titleEl.textContent = title || '';

    if (input) {
      inputEl.style.display = 'block';
      inputEl.value = defaultValue || '';
      inputEl.placeholder = placeholder || '';
    } else {
      inputEl.style.display = 'none';
    }

    if (message) {
      msgEl.style.display = 'block';
      msgEl.textContent = message;
    } else {
      msgEl.style.display = 'none';
    }

    confirmBtn.classList.toggle('danger', !!danger);
    overlay.style.display = 'flex';

    if (input) setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);

    function cleanup() {
      overlay.style.display = 'none';
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      inputEl.removeEventListener('keydown', onKey);
      overlay.removeEventListener('click', onOverlay);
    }

    function onConfirm() { cleanup(); resolve(input ? inputEl.value : true); }
    function onCancel() { cleanup(); resolve(input ? null : false); }
    function onKey(e) { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }
    function onOverlay(e) { if (e.target === overlay) onCancel(); }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    inputEl.addEventListener('keydown', onKey);
    overlay.addEventListener('click', onOverlay);
  });
}
