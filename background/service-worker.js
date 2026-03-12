'use strict';

const CONTEXT_MENU_ID = 'lxz-save-selection';

function createContextMenu() {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: '收藏到灵犀摘',
    contexts: ['selection'],
  });
}

function removeContextMenu() {
  chrome.contextMenus.remove(CONTEXT_MENU_ID).catch(() => {});
}

async function syncContextMenu() {
  const res = await chrome.storage.local.get(['contextMenuEnabled']);
  const enabled = res.contextMenuEnabled !== false; // 默认开启
  if (enabled) {
    chrome.contextMenus.removeAll(() => createContextMenu());
  } else {
    removeContextMenu();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // 初始化默认收藏夹
  chrome.storage.local.get('collections', (result) => {
    if (!result.collections) {
      chrome.storage.local.set({
        collections: [{ id: 'default', name: '全部收藏', createdAt: Date.now(), isDefault: true }],
      });
    }
  });

  // 初始化右键菜单
  syncContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  syncContextMenu();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.contextMenuEnabled) {
    syncContextMenu();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'CONTEXT_MENU_SAVE' }).catch(() => {});
  }
});

// ── 存储操作 ──

async function getAllHighlights() {
  const result = await chrome.storage.local.get('highlights');
  return result.highlights || [];
}

async function saveHighlight(data) {
  const highlights = await getAllHighlights();
  if (!data.collectionId) data.collectionId = 'default';
  highlights.push(data);
  await chrome.storage.local.set({ highlights });
  return true;
}

async function deleteHighlight(id) {
  const highlights = await getAllHighlights();
  await chrome.storage.local.set({ highlights: highlights.filter(h => h.id !== id) });
  return true;
}

async function deleteHighlightsBatch(ids) {
  const idSet = new Set(ids);
  const highlights = await getAllHighlights();
  await chrome.storage.local.set({ highlights: highlights.filter(h => !idSet.has(h.id)) });
  return true;
}

async function updateHighlight(id, updates) {
  const highlights = await getAllHighlights();
  const index = highlights.findIndex(h => h.id === id);
  if (index === -1) return false;
  highlights[index] = { ...highlights[index], ...updates };
  await chrome.storage.local.set({ highlights });
  return true;
}

async function updateHighlightsBatch(ids, updates) {
  const idSet = new Set(ids);
  const highlights = await getAllHighlights();
  for (const h of highlights) {
    if (idSet.has(h.id)) Object.assign(h, updates);
  }
  await chrome.storage.local.set({ highlights });
  return true;
}

async function getHighlightsByUrl(url) {
  const highlights = await getAllHighlights();
  return highlights.filter(h => h.url === url);
}

// ── 收藏夹操作 ──

async function getCollections() {
  const result = await chrome.storage.local.get('collections');
  if (result.collections && result.collections.length > 0) return result.collections;
  const defaultCol = [{ id: 'default', name: '全部收藏', createdAt: Date.now(), isDefault: true }];
  await chrome.storage.local.set({ collections: defaultCol });
  return defaultCol;
}

async function createCollection(name) {
  const collections = await getCollections();
  const newCol = { id: `col_${Date.now()}`, name, createdAt: Date.now() };
  collections.push(newCol);
  await chrome.storage.local.set({ collections });
  return newCol;
}

async function renameCollection(id, name) {
  const collections = await getCollections();
  const col = collections.find(c => c.id === id);
  if (!col || col.isDefault) return false;
  col.name = name;
  await chrome.storage.local.set({ collections });
  return true;
}

async function deleteCollection(id) {
  const collections = await getCollections();
  const col = collections.find(c => c.id === id);
  if (!col || col.isDefault) return false;

  // 将该收藏夹里的高亮移回默认收藏夹
  const highlights = await getAllHighlights();
  for (const h of highlights) {
    if (h.collectionId === id) h.collectionId = 'default';
  }
  await chrome.storage.local.set({
    collections: collections.filter(c => c.id !== id),
    highlights,
  });
  return true;
}

// ── 消息处理 ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    async SAVE_HIGHLIGHT() {
      return { success: await saveHighlight(message.data) };
    },
    async DELETE_HIGHLIGHT() {
      return { success: await deleteHighlight(message.id) };
    },
    async DELETE_HIGHLIGHTS_BATCH() {
      return { success: await deleteHighlightsBatch(message.ids) };
    },
    async UPDATE_HIGHLIGHT() {
      return { success: await updateHighlight(message.id, message.updates) };
    },
    async UPDATE_HIGHLIGHTS_BATCH() {
      return { success: await updateHighlightsBatch(message.ids, message.updates) };
    },
    async GET_HIGHLIGHTS() {
      const highlights = message.url
        ? await getHighlightsByUrl(message.url)
        : await getAllHighlights();
      return { highlights };
    },
    async GET_COLLECTIONS() {
      return { collections: await getCollections() };
    },
    async CREATE_COLLECTION() {
      return { collection: await createCollection(message.name) };
    },
    async RENAME_COLLECTION() {
      return { success: await renameCollection(message.id, message.name) };
    },
    async DELETE_COLLECTION() {
      return { success: await deleteCollection(message.id) };
    },
    async EXPORT_HIGHLIGHTS() {
      const highlights = await getAllHighlights();
      return { json: JSON.stringify(highlights, null, 2) };
    },
  };

  const handler = handlers[message.type];
  if (handler) {
    handler().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
});
