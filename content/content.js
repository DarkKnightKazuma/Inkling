(() => {
  'use strict';

  console.log('[灵犀摘] 内容脚本开始加载', window.location.href);

  const HIGHLIGHT_COLORS = {
    yellow: 'rgba(255, 235, 59, 0.4)',
    green: 'rgba(129, 199, 132, 0.4)',
    blue: 'rgba(100, 181, 246, 0.4)',
    pink: 'rgba(240, 98, 146, 0.4)',
    purple: 'rgba(186, 104, 200, 0.4)',
  };

  const DEFAULT_COLOR = 'yellow';
  let currentColor = DEFAULT_COLOR;
  let currentCollectionId = 'default';
  let cachedCollections = [];
  let toolbarHost = null;
  let toolbarRoot = null;
  let toolbarEl = null;
  let collectionSelect = null;

  // ── 安全的消息发送 ──

  function sendMsg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[灵犀摘] sendMsg error:', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(response);
        });
      } catch (e) {
        console.warn('[灵犀摘] sendMsg exception:', e);
        resolve(null);
      }
    });
  }

  // ── XPath 工具 ──

  function getXPath(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentNode;
      if (!parent) return '';
      const siblings = Array.from(parent.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
      const index = siblings.indexOf(node) + 1;
      return getXPath(parent) + `/text()[${index}]`;
    }

    if (node === document.body) return '/html/body';
    if (node === document.documentElement) return '/html';

    const parent = node.parentNode;
    if (!parent) return '';

    const siblings = Array.from(parent.children).filter(n => n.tagName === node.tagName);
    const index = siblings.indexOf(node) + 1;
    const tag = node.tagName.toLowerCase();

    return getXPath(parent) + `/${tag}[${index}]`;
  }

  function getNodeByXPath(xpath) {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    } catch { return null; }
  }

  // ── 文本节点收集 ──

  function getTextNodesInRange(range) {
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
      return [range.startContainer];
    }

    const ancestor = range.commonAncestorContainer;
    const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor;
    const nodes = [];

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.length > 0 && range.intersectsNode(node)) {
        nodes.push(node);
      }
    }

    if (nodes.length === 0 && root.nodeType === Node.TEXT_NODE) {
      nodes.push(root);
    }

    return nodes;
  }

  // ── 高亮引擎 ──

  function createHighlightSpan(color, highlightId) {
    const span = document.createElement('span');
    span.className = 'lxz-highlight';
    span.dataset.highlightId = highlightId;
    span.style.setProperty('background-color', HIGHLIGHT_COLORS[color] || HIGHLIGHT_COLORS.yellow, 'important');
    span.style.setProperty('display', 'inline', 'important');
    span.style.setProperty('visibility', 'visible', 'important');
    span.dataset.color = color;
    return span;
  }

  function highlightRange(range, color, highlightId) {
    console.log('[灵犀摘] highlightRange 开始', {
      color, highlightId,
      startContainer: range.startContainer.nodeName,
      startOffset: range.startOffset,
      endContainer: range.endContainer.nodeName,
      endOffset: range.endOffset,
      text: range.toString().substring(0, 50),
    });

    // 优先尝试 surroundContents（适用于不跨元素边界的简单选区）
    try {
      const span = createHighlightSpan(color, highlightId);
      range.surroundContents(span);
      console.log('[灵犀摘] surroundContents 成功');
      return [span];
    } catch (e) {
      console.log('[灵犀摘] surroundContents 失败，回退到逐节点模式:', e.message);
    }

    const textNodes = getTextNodesInRange(range);
    console.log('[灵犀摘] 找到文本节点数:', textNodes.length);

    if (textNodes.length === 0) {
      console.warn('[灵犀摘] 未找到文本节点，高亮中止');
      return [];
    }

    const spans = [];

    const nodeInfos = textNodes.map((node) => {
      let start = 0;
      let end = node.textContent.length;

      if (node === range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
        start = range.startOffset;
      }
      if (node === range.endContainer && range.endContainer.nodeType === Node.TEXT_NODE) {
        end = range.endOffset;
      }

      return { node, start, end };
    });

    for (let i = nodeInfos.length - 1; i >= 0; i--) {
      const { node, start, end } = nodeInfos[i];
      if (start >= end || !node.parentNode) continue;

      try {
        let targetNode = node;
        if (end < node.textContent.length) {
          node.splitText(end);
        }
        if (start > 0) {
          targetNode = node.splitText(start);
        }

        const span = createHighlightSpan(color, highlightId);
        targetNode.parentNode.insertBefore(span, targetNode);
        span.appendChild(targetNode);
        spans.unshift(span);
      } catch (e) {
        console.warn('[灵犀摘] 包裹文本节点失败:', e.message);
      }
    }

    console.log('[灵犀摘] highlightRange 完成, 创建了', spans.length, '个高亮 span');
    return spans;
  }

  function removeHighlight(highlightId) {
    const spans = document.querySelectorAll(`.lxz-highlight[data-highlight-id="${highlightId}"]`);
    spans.forEach(span => {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    });
  }

  // ── 序列化与反序列化 ──

  function serializeHighlight(range, color, highlightId) {
    const text = range.toString();
    const startXPath = getXPath(range.startContainer);
    const endXPath = getXPath(range.endContainer);

    const contextParent = range.commonAncestorContainer;
    const contextNode = contextParent.nodeType === Node.TEXT_NODE ? contextParent.parentNode : contextParent;
    const context = (contextNode.textContent || '').substring(0, 200);

    return {
      id: highlightId,
      url: window.location.href,
      title: document.title,
      text,
      note: '',
      tags: [],
      color,
      createdAt: Date.now(),
      context,
      ranges: [{
        startXPath,
        startOffset: range.startOffset,
        endXPath,
        endOffset: range.endOffset,
      }],
    };
  }

  function restoreHighlight(data) {
    try {
      for (const r of data.ranges) {
        const startNode = getNodeByXPath(r.startXPath);
        const endNode = getNodeByXPath(r.endXPath);

        if (!startNode || !endNode) {
          return restoreByTextSearch(data);
        }

        const range = document.createRange();
        range.setStart(startNode, Math.min(r.startOffset, startNode.textContent?.length || 0));
        range.setEnd(endNode, Math.min(r.endOffset, endNode.textContent?.length || 0));

        if (range.toString() !== data.text) {
          return restoreByTextSearch(data);
        }

        highlightRange(range, data.color, data.id);
      }
      return true;
    } catch {
      return restoreByTextSearch(data);
    }
  }

  function restoreByTextSearch(data) {
    if (!data.text || data.text.length < 4) return false;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    const searchText = data.text;

    while ((node = walker.nextNode())) {
      const idx = node.textContent.indexOf(searchText);
      if (idx === -1) continue;

      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + searchText.length);
      highlightRange(range, data.color, data.id);
      return true;
    }

    const allElements = document.body.querySelectorAll('*');
    for (const el of allElements) {
      if (el.children.length > 20) continue;
      const text = el.textContent;
      if (!text.includes(searchText)) continue;

      const range = document.createRange();
      range.selectNodeContents(el);
      const fullText = range.toString();
      const matchIdx = fullText.indexOf(searchText);
      if (matchIdx === -1) continue;

      const textNodes = [];
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) textNodes.push(n);

      let charCount = 0;
      let startNode = null, endNode = null, startOff = 0, endOff = 0;

      for (const tn of textNodes) {
        const len = tn.textContent.length;
        if (!startNode && charCount + len > matchIdx) {
          startNode = tn;
          startOff = matchIdx - charCount;
        }
        if (charCount + len >= matchIdx + searchText.length) {
          endNode = tn;
          endOff = matchIdx + searchText.length - charCount;
          break;
        }
        charCount += len;
      }

      if (startNode && endNode) {
        const r = document.createRange();
        r.setStart(startNode, startOff);
        r.setEnd(endNode, endOff);
        highlightRange(r, data.color, data.id);
        return true;
      }
    }

    return false;
  }

  // ── 浮动工具栏（直接创建，用 inline style 强制覆盖）──

  function ensureToolbar() {
    if (toolbarHost) return toolbarEl;

    console.log('[灵犀摘] 创建工具栏');

    toolbarHost = document.createElement('div');
    toolbarHost.id = 'lxz-toolbar-host';
    Object.assign(toolbarHost.style, {
      all: 'initial',
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      overflow: 'visible',
      zIndex: '2147483647',
      pointerEvents: 'none',
    });

    toolbarEl = document.createElement('div');
    toolbarEl.id = 'lxz-toolbar';
    Object.assign(toolbarEl.style, {
      position: 'fixed',
      zIndex: '2147483647',
      opacity: '0',
      transform: 'translateY(6px) scale(0.95)',
      pointerEvents: 'none',
      transition: 'opacity 0.18s ease, transform 0.18s ease',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '14px',
      lineHeight: '1.4',
      color: '#333',
      boxSizing: 'border-box',
    });

    const inner = document.createElement('div');
    Object.assign(inner.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 10px',
      background: '#fff',
      borderRadius: '10px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.06)',
      boxSizing: 'border-box',
    });

    // 颜色按钮
    const colorGroup = document.createElement('div');
    Object.assign(colorGroup.style, { display: 'flex', gap: '4px' });

    Object.keys(HIGHLIGHT_COLORS).forEach(c => {
      const btn = document.createElement('button');
      Object.assign(btn.style, {
        width: '22px',
        height: '22px',
        border: c === currentColor ? '2px solid rgba(0,0,0,0.35)' : '2px solid transparent',
        borderRadius: '50%',
        background: 'none',
        cursor: 'pointer',
        padding: '0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'border-color 0.15s ease, transform 0.15s ease',
        boxSizing: 'border-box',
      });
      btn.dataset.color = c;

      const dot = document.createElement('span');
      Object.assign(dot.style, {
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        display: 'block',
        background: HIGHLIGHT_COLORS[c].replace('0.4', '0.8'),
      });
      btn.appendChild(dot);

      btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.15)'; });
      btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1)'; });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentColor = c;
        colorGroup.querySelectorAll('button').forEach(b => {
          b.style.borderColor = b.dataset.color === c ? 'rgba(0,0,0,0.35)' : 'transparent';
        });
      });

      colorGroup.appendChild(btn);
    });

    // 收藏夹选择器
    collectionSelect = document.createElement('select');
    Object.assign(collectionSelect.style, {
      padding: '3px 4px',
      border: '1px solid #e0e0e0',
      borderRadius: '5px',
      fontSize: '11px',
      color: '#555',
      background: '#fafafa',
      cursor: 'pointer',
      outline: 'none',
      maxWidth: '80px',
      boxSizing: 'border-box',
      fontFamily: 'inherit',
      lineHeight: '1.2',
    });
    collectionSelect.title = '选择收藏夹';
    collectionSelect.innerHTML = '<option value="default">全部收藏</option>';
    collectionSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      currentCollectionId = collectionSelect.value;
    });
    collectionSelect.addEventListener('mousedown', (e) => e.stopPropagation());

    // 收藏按钮
    const saveBtn = document.createElement('button');
    Object.assign(saveBtn.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '5px',
      padding: '5px 12px',
      border: 'none',
      borderRadius: '7px',
      background: 'linear-gradient(135deg, #ff9f43, #f7971e)',
      color: '#fff',
      fontSize: '13px',
      fontWeight: '600',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      transition: 'background 0.2s ease, transform 0.1s ease, box-shadow 0.2s ease',
      lineHeight: '1',
      boxSizing: 'border-box',
      fontFamily: 'inherit',
    });
    saveBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
      </svg>
      <span>收藏</span>
    `;
    saveBtn.addEventListener('mouseenter', () => {
      saveBtn.style.background = 'linear-gradient(135deg, #f7971e, #f56a00)';
      saveBtn.style.boxShadow = '0 2px 8px rgba(247,151,30,0.35)';
    });
    saveBtn.addEventListener('mouseleave', () => {
      saveBtn.style.background = 'linear-gradient(135deg, #ff9f43, #f7971e)';
      saveBtn.style.boxShadow = 'none';
    });
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveCurrentSelection();
    });

    inner.appendChild(colorGroup);
    inner.appendChild(collectionSelect);
    inner.appendChild(saveBtn);
    toolbarEl.appendChild(inner);

    toolbarEl.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });

    toolbarHost.appendChild(toolbarEl);
    document.documentElement.appendChild(toolbarHost);

    console.log('[灵犀摘] 工具栏已创建并插入 DOM');
    return toolbarEl;
  }

  function showToolbar(rect) {
    const tb = ensureToolbar();
    refreshCollectionSelect();

    const tbWidth = 340;
    const tbHeight = 44;
    const gap = 8;

    let top = rect.top - tbHeight - gap;
    let left = rect.left + (rect.width - tbWidth) / 2;

    if (top < 10) {
      top = rect.bottom + gap;
    }
    left = Math.max(10, Math.min(left, window.innerWidth - tbWidth - 10));

    tb.style.top = `${top}px`;
    tb.style.left = `${left}px`;
    tb.style.opacity = '1';
    tb.style.transform = 'translateY(0) scale(1)';
    tb.style.pointerEvents = 'auto';
  }

  function refreshCollectionSelect() {
    if (!collectionSelect) return;
    sendMsg({ type: 'GET_COLLECTIONS' }).then(res => {
      const cols = res?.collections || [];
      cachedCollections = cols;
      collectionSelect.innerHTML = cols.map(c =>
        `<option value="${c.id}"${c.id === currentCollectionId ? ' selected' : ''}>${c.name}</option>`
      ).join('');
    });
  }

  function hideToolbar() {
    if (toolbarEl) {
      toolbarEl.style.opacity = '0';
      toolbarEl.style.transform = 'translateY(6px) scale(0.95)';
      toolbarEl.style.pointerEvents = 'none';
    }
  }

  // ── 保存逻辑 ──

  function generateId() {
    return `hl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  function saveCurrentSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const text = range.toString().trim();
    if (!text) return;

    console.log('[灵犀摘] saveCurrentSelection 开始', {
      text: text.substring(0, 40),
      startContainer: range.startContainer.nodeName,
      startType: range.startContainer.nodeType,
      endContainer: range.endContainer.nodeName,
      endType: range.endContainer.nodeType,
    });

    const highlightId = generateId();
    const data = serializeHighlight(range, currentColor, highlightId);
    data.collectionId = currentCollectionId;

    try {
      highlightRange(range, currentColor, highlightId);
    } catch (e) {
      console.error('[灵犀摘] highlightRange 异常:', e);
    }

    selection.removeAllRanges();
    hideToolbar();

    const colName = cachedCollections.find(c => c.id === currentCollectionId)?.name || '';
    sendMsg({ type: 'SAVE_HIGHLIGHT', data }).then((response) => {
      const suffix = colName && colName !== '全部收藏' ? ` → ${colName}` : '';
      showToast(response?.success ? `已收藏到灵犀摘${suffix} ✓` : '收藏失败，请重试');
    });
  }

  // ── Toast 提示 ──

  function showToast(message) {
    let toast = document.getElementById('lxz-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'lxz-toast';
      Object.assign(toast.style, {
        position: 'fixed',
        bottom: '30px',
        left: '50%',
        transform: 'translateX(-50%) translateY(20px)',
        padding: '10px 22px',
        background: 'rgba(30, 30, 30, 0.88)',
        color: '#fff',
        fontSize: '14px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        borderRadius: '8px',
        zIndex: '2147483647',
        opacity: '0',
        pointerEvents: 'none',
        transition: 'opacity 0.25s ease, transform 0.25s ease',
        backdropFilter: 'blur(8px)',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
      });
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(20px)';
    }, 2000);
  }

  // ── 高亮恢复 ──

  async function restorePageHighlights() {
    const response = await sendMsg({
      type: 'GET_HIGHLIGHTS',
      url: window.location.href,
    });
    if (!response?.highlights) return;
    for (const data of response.highlights) {
      try { restoreHighlight(data); } catch (e) {
        console.warn('[灵犀摘] 恢复高亮失败:', e);
      }
    }
  }

  // ── 设置状态 ──

  let clickToCopyEnabled = false;
  let toolbarEnabled = true;

  chrome.storage.local.get(['clickToCopy', 'toolbarEnabled'], (res) => {
    clickToCopyEnabled = !!res.clickToCopy;
    toolbarEnabled = res.toolbarEnabled !== false; // 默认开启
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.clickToCopy) {
      clickToCopyEnabled = !!changes.clickToCopy.newValue;
    }
    if (changes.toolbarEnabled) {
      toolbarEnabled = changes.toolbarEnabled.newValue !== false;
      if (!toolbarEnabled) hideToolbar();
    }
  });

  // ── 高亮点击处理：Alt+点击删除 / 普通点击复制（需开启） ──

  function setupHighlightClickHandler() {
    document.addEventListener('click', (e) => {
      const hlSpan = e.target.closest('.lxz-highlight');
      if (!hlSpan) return;

      const highlightId = hlSpan.dataset.highlightId;
      if (!highlightId) return;

      if (e.altKey) {
        removeHighlight(highlightId);
        sendMsg({ type: 'DELETE_HIGHLIGHT', id: highlightId });
        showToast('已移除高亮');
      } else if (clickToCopyEnabled) {
        const allSpans = document.querySelectorAll(`.lxz-highlight[data-highlight-id="${highlightId}"]`);
        const text = Array.from(allSpans).map(s => s.textContent).join('');
        navigator.clipboard.writeText(text).then(() => {
          showToast('已复制');
        }).catch(() => {
          showToast('复制失败');
        });
      }
    }, true);
  }

  // ── 来自 Service Worker 的消息监听 ──

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CONTEXT_MENU_SAVE') {
      saveCurrentSelection();
      sendResponse({ ok: true });
    } else if (message.type === 'REMOVE_HIGHLIGHT') {
      removeHighlight(message.id);
      sendResponse({ ok: true });
    } else if (message.type === 'REMOVE_HIGHLIGHTS_BATCH') {
      (message.ids || []).forEach(id => removeHighlight(id));
      sendResponse({ ok: true });
    }
    return false;
  });

  // ── 选中文字检测 ──

  function onMouseUp(e) {
    console.log('[灵犀摘] mouseup 事件触发');

    if (toolbarHost && (toolbarHost === e.target || toolbarHost.contains(e.target))) return;

    setTimeout(() => {
      if (!toolbarEnabled) return;

      const selection = window.getSelection();
      const text = selection?.toString().trim();
      console.log('[灵犀摘] 选区检测:', { hasSelection: !!selection, isCollapsed: selection?.isCollapsed, textLen: text?.length });

      if (!selection || selection.isCollapsed || !text) {
        hideToolbar();
        return;
      }

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      console.log('[灵犀摘] 选区位置:', { top: rect.top, left: rect.left, width: rect.width, height: rect.height });

      if (rect.width === 0 && rect.height === 0) {
        hideToolbar();
        return;
      }

      showToolbar(rect);
    }, 50);
  }

  function onMouseDown(e) {
    if (toolbarHost && (toolbarHost === e.target || toolbarHost.contains(e.target))) return;
    hideToolbar();
  }

  // ── 初始化 ──

  function init() {
    console.log('[灵犀摘] init() 开始执行');

    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideToolbar();
    }, true);

    setupHighlightClickHandler();
    setTimeout(restorePageHighlights, 1500);

    let lastUrl = window.location.href;
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        setTimeout(restorePageHighlights, 1000);
      }
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    console.log('[灵犀摘] init() 完成, mouseup 监听已注册');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
