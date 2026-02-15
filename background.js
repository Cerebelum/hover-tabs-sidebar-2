const faviconCache = new Map();
const tabPreviewCache = new Map();

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

const reorderTabsInWindow = (orderedIds, sendResponse) => {
  if (!orderedIds?.length) {
    reply(sendResponse, {});
    return;
  }

  const moveNext = (index) => {
    if (index >= orderedIds.length) {
      reply(sendResponse, {});
      return;
    }

    chrome.tabs.move(orderedIds[index], { index }, () => {
      if (chrome.runtime.lastError?.message) {
        reply(sendResponse, {}, chrome.runtime.lastError.message);
        return;
      }
      moveNext(index + 1);
    });
  };

  moveNext(0);
};

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

      const payload = tabs.map(({ id, title, url: tabUrl, favIconUrl, active, pinned, index, lastAccessed }) => ({
        id,
        title,
        url: tabUrl,
        favIconUrl,
        active,
        pinned,
        index,
        lastAccessed,
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

  if (type === "reorderTabs") {
    reorderTabsInWindow(Array.isArray(message.orderedIds) ? message.orderedIds : [], sendResponse);
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
        reply(sendResponse, {}, error.message || "Ошибка загрузки favicon.");
      });

    return true;
  }

  reply(sendResponse, {}, "Неизвестный запрос либо отсутствуют параметры.");
  return false;
});
