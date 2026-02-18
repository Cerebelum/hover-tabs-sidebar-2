const faviconCache = new Map();
const tabPreviewCache = new Map();
const sidebarOrderByWindow = new Map();

const CONTEXT_MENU_SHOW_SIDEBAR = "show-sidebar";
const CONTEXT_MENU_TOGGLE_EXTENSION = "toggle-extension";
const EXTENSION_ENABLED_KEY = "extensionEnabled";
const DEFAULT_EXTENSION_ENABLED = true;

let extensionEnabled = DEFAULT_EXTENSION_ENABLED;

const buildExtensionFaviconUrl = (tabUrl) => {
  if (!tabUrl || typeof tabUrl !== "string") return "";
  return `${chrome.runtime.getURL("/_favicon/")}?pageUrl=${encodeURIComponent(tabUrl)}&size=32`;
};

const reply = (sendResponse, data = {}, error) => {
  sendResponse(error ? { success: false, error } : { success: true, ...data });
};

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Не удалось прочитать favicon."));
    reader.readAsDataURL(blob);
  });

const captureTabPreview = (windowId, tabId) => {
  if (!windowId || !tabId) return;

  chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 55 }, (dataUrl) => {
    if (chrome.runtime.lastError?.message || !dataUrl) return;
    tabPreviewCache.set(tabId, dataUrl);
  });
};

const getOrderedTabIds = (tabs, windowId) => {
  const presentIds = tabs.map((tab) => tab.id);
  const presentSet = new Set(presentIds);
  const stored = sidebarOrderByWindow.get(windowId) || [];
  const filtered = stored.filter((tabId) => presentSet.has(tabId));
  presentIds.forEach((tabId) => {
    if (!filtered.includes(tabId)) filtered.push(tabId);
  });
  sidebarOrderByWindow.set(windowId, filtered);
  return filtered;
};

const orderTabsForSidebar = (tabs, windowId) => {
  const orderIds = getOrderedTabIds(tabs, windowId);
  const tabMap = new Map(tabs.map((tab) => [tab.id, tab]));
  return orderIds.map((id) => tabMap.get(id)).filter(Boolean);
};

const broadcastToWindowTabs = async (windowId, message) => {
  const tabs = await chrome.tabs.query({ windowId });
  tabs.forEach((tab) => {
    if (!tab.id) return;
    chrome.tabs.sendMessage(tab.id, message, () => {
      void chrome.runtime.lastError;
    });
  });
};

const updateToggleContextTitle = () => {
  chrome.contextMenus.update(CONTEXT_MENU_TOGGLE_EXTENSION, {
    title: extensionEnabled ? "Отключить" : "Включить",
  });
};

const setExtensionEnabled = async (nextEnabled) => {
  extensionEnabled = Boolean(nextEnabled);
  await chrome.storage.local.set({ [EXTENSION_ENABLED_KEY]: extensionEnabled });
  updateToggleContextTitle();

  const tabs = await chrome.tabs.query({});
  tabs.forEach((tab) => {
    if (!tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "extensionStateChanged", enabled: extensionEnabled }, () => {
      void chrome.runtime.lastError;
    });
  });
};

const createContextMenus = () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_SHOW_SIDEBAR,
      title: "Показать боковую панель вкладок",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_TOGGLE_EXTENSION,
      title: extensionEnabled ? "Отключить" : "Включить",
      contexts: ["action"],
    });
  });
};

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
});

chrome.storage.local.get({ [EXTENSION_ENABLED_KEY]: DEFAULT_EXTENSION_ENABLED }, (result) => {
  extensionEnabled = Boolean(result[EXTENSION_ENABLED_KEY]);
  createContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_SHOW_SIDEBAR && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "manualOpenSidebar" }, () => {
      void chrome.runtime.lastError;
    });
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_TOGGLE_EXTENSION) {
    await setExtensionEnabled(!extensionEnabled);
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  captureTabPreview(windowId, tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    captureTabPreview(tab.windowId, tabId);
  }

  if (changeInfo.status === "complete" && tab.windowId) {
    await broadcastToWindowTabs(tab.windowId, { type: "sidebarOrderChanged" });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  tabPreviewCache.delete(tabId);
  const currentOrder = sidebarOrderByWindow.get(removeInfo.windowId) || [];
  sidebarOrderByWindow.set(
    removeInfo.windowId,
    currentOrder.filter((id) => id !== tabId),
  );
  await broadcastToWindowTabs(removeInfo.windowId, { type: "sidebarOrderChanged" });
});

chrome.tabs.onMoved.addListener(async (_tabId, moveInfo) => {
  await broadcastToWindowTabs(moveInfo.windowId, { type: "sidebarOrderChanged" });
});

chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => {
  if (!tabId || !newZoomFactor) return;
  chrome.tabs.sendMessage(tabId, { type: "zoomChanged", zoomFactor: newZoomFactor }, () => {
    void chrome.runtime.lastError;
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, tabId, url } = message;

  if (type === "getExtensionState") {
    reply(sendResponse, { enabled: extensionEnabled });
    return false;
  }

  if (type === "setExtensionEnabled") {
    setExtensionEnabled(message.enabled)
      .then(() => reply(sendResponse, { enabled: extensionEnabled }))
      .catch((error) => reply(sendResponse, {}, error?.message || "Не удалось обновить состояние расширения."));
    return true;
  }

  if (type === "getTabs") {
    const queryInfo = sender?.tab?.windowId ? { windowId: sender.tab.windowId } : { currentWindow: true };

    chrome.tabs.query(queryInfo, (tabs) => {
      const err = chrome.runtime.lastError?.message;
      if (err) {
        reply(sendResponse, {}, err);
        return;
      }

      const orderedTabs = orderTabsForSidebar(tabs, tabs[0]?.windowId || sender?.tab?.windowId || 0);
      const payload = orderedTabs.map(({ id, title, url: tabUrl, favIconUrl, active, pinned, lastAccessed }) => ({
        id,
        title,
        url: tabUrl,
        favIconUrl,
        extensionFavIconUrl: buildExtensionFaviconUrl(tabUrl),
        active,
        pinned,
        lastAccessed: Number(lastAccessed) || 0,
        preview: tabPreviewCache.get(id) || "",
      }));

      const resolveTabs = (zoomFactor = 1) => {
        reply(sendResponse, { tabs: payload, zoomFactor });
      };

      if (sender?.tab?.id) {
        chrome.tabs.getZoom(sender.tab.id, (zoomFactor) => {
          if (chrome.runtime.lastError?.message) {
            resolveTabs(1);
            return;
          }
          resolveTabs(zoomFactor || 1);
        });
        return;
      }

      resolveTabs(1);
    });

    return true;
  }

  if (type === "updateSidebarOrder" && Array.isArray(message.tabIds)) {
    const windowId = sender?.tab?.windowId;
    if (!windowId) {
      reply(sendResponse, {}, "Не удалось определить окно.");
      return false;
    }

    chrome.tabs.query({ windowId }, async (tabs) => {
      const err = chrome.runtime.lastError?.message;
      if (err) {
        reply(sendResponse, {}, err);
        return;
      }

      const presentIds = tabs.map((tab) => tab.id);
      const presentSet = new Set(presentIds);
      const ordered = message.tabIds.filter((id) => presentSet.has(id));
      presentIds.forEach((id) => {
        if (!ordered.includes(id)) ordered.push(id);
      });
      sidebarOrderByWindow.set(windowId, ordered);

      await broadcastToWindowTabs(windowId, { type: "sidebarOrderChanged" });
      reply(sendResponse, {});
    });

    return true;
  }

  if (type === "getZoom") {
    if (!sender?.tab?.id) {
      reply(sendResponse, { zoomFactor: 1 });
      return false;
    }

    chrome.tabs.getZoom(sender.tab.id, (zoomFactor) => {
      reply(sendResponse, { zoomFactor: chrome.runtime.lastError?.message ? 1 : zoomFactor || 1 });
    });
    return true;
  }

  if (type === "activateTab" && tabId) {
    chrome.tabs.update(tabId, { active: true }, () => {
      reply(sendResponse, {}, chrome.runtime.lastError?.message);
    });
    return true;
  }

  if (type === "reloadTab" && tabId) {
    chrome.tabs.reload(tabId, { bypassCache: Boolean(message.bypassCache) }, () => {
      reply(sendResponse, {}, chrome.runtime.lastError?.message);
    });
    return true;
  }

  if (type === "removeTab" && tabId) {
    chrome.tabs.remove(tabId, () => {
      reply(sendResponse, {}, chrome.runtime.lastError?.message);
    });
    return true;
  }

  if (type === "reorderTabs" && Array.isArray(message.tabIds)) {
    const queryInfo = sender?.tab?.windowId ? { windowId: sender.tab.windowId } : { currentWindow: true };

    chrome.tabs.query(queryInfo, (tabs) => {
      const err = chrome.runtime.lastError?.message;
      if (err) {
        reply(sendResponse, {}, err);
        return;
      }

      const tabMap = new Map(tabs.map((tab) => [tab.id, tab]));
      const orderedTabs = message.tabIds.map((id) => tabMap.get(id)).filter(Boolean);

      if (!orderedTabs.length) {
        reply(sendResponse, {}, "Нет вкладок для сортировки.");
        return;
      }

      let nextIndex = Math.min(...orderedTabs.map((tab) => tab.index));

      const moveNext = (i) => {
        if (i >= orderedTabs.length) {
          const windowId = tabs[0]?.windowId || sender?.tab?.windowId;
          if (windowId) {
            sidebarOrderByWindow.set(windowId, orderedTabs.map((tab) => tab.id));
            broadcastToWindowTabs(windowId, { type: "sidebarOrderChanged" });
          }
          reply(sendResponse, {});
          return;
        }
        const tab = orderedTabs[i];
        chrome.tabs.move(tab.id, { index: nextIndex }, () => {
          const moveError = chrome.runtime.lastError?.message;
          if (moveError) {
            reply(sendResponse, {}, moveError);
            return;
          }
          nextIndex += 1;
          moveNext(i + 1);
        });
      };

      moveNext(0);
    });

    return true;
  }

  if (type === "resolveFavicon" && url) {
    if (faviconCache.has(url)) {
      reply(sendResponse, { dataUrl: faviconCache.get(url) });
      return true;
    }

    fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.blob();
      })
      .then(blobToDataUrl)
      .then((dataUrl) => {
        faviconCache.set(url, dataUrl);
        reply(sendResponse, { dataUrl });
      })
      .catch((error) => {
        reply(sendResponse, {}, error?.message || "Не удалось загрузить favicon.");
      });

    return true;
  }

  return false;
});
