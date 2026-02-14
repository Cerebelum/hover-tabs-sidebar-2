const faviconCache = new Map();

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

      const payload = tabs.map(({ id, title, url: tabUrl, favIconUrl, active }) => ({
        id,
        title,
        url: tabUrl,
        favIconUrl,
        active,
      }));

      reply(sendResponse, { tabs: payload });
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
