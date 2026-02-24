const faviconCache = new Map();
const tabPreviewCache = new Map();
const MAX_CACHE_SIZE = 100;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open_tab_sidebar",
    title: "Open Tab Sidebar",
    contexts: ["all"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== "open_tab_sidebar") return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTabId = tabs?.[0]?.id;
    if (!activeTabId) return;
    chrome.tabs.sendMessage(activeTabId, { type: "manualOpenSidebar" }, () => {
      void chrome.runtime.lastError;
    });
  });
});

const setWithLimit = (map, key, value) => {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  if (map.size > MAX_CACHE_SIZE) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
};

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
    setWithLimit(tabPreviewCache, tabId, dataUrl);
  });
};

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  captureTabPreview(windowId, tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    captureTabPreview(tab.windowId, tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabPreviewCache.delete(tabId);
});

chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => {
  if (!tabId || !newZoomFactor) return;
  chrome.tabs.sendMessage(tabId, { type: "zoomChanged", zoomFactor: newZoomFactor }, () => {
    void chrome.runtime.lastError;
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, tabId, url } = message;

  if (type === "getTabs") {
    const queryInfo = sender?.tab?.windowId ? { windowId: sender.tab.windowId } : { currentWindow: true };

    chrome.tabs.query(queryInfo, (tabs) => {
      const err = chrome.runtime.lastError?.message;
      if (err) {
        reply(sendResponse, {}, err);
        return;
      }

      const payload = tabs.map(({ id, title, url: tabUrl, favIconUrl, active, pinned, lastAccessed }) => ({
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
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        reply(sendResponse, {}, "Неизвестный запрос либо отсутствуют параметры.");
        return false;
      }
    } catch {
      reply(sendResponse, {}, "Неизвестный запрос либо отсутствуют параметры.");
      return false;
    }

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
        setWithLimit(faviconCache, url, dataUrl);
        reply(sendResponse, { dataUrl });
      })
      .catch((error) => {
        reply(sendResponse, {}, error.message || "Ошибка загрузки favicon.");
      });

    return true;
  }

  reply(sendResponse, {}, "Неизвестный запрос либо отсутствуют параметры.");
  return false;
});
