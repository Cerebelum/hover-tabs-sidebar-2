(() => {
  if (window.__tabHoverSidebarInit) return;
  window.__tabHoverSidebarInit = true;

  const EDGE_TRIGGER_PX = 16;
  const SAFE_ICON_CACHE = new Map();
  const DEFAULT_SETTINGS = {
    showPreview: true,
    position: "left",
    showDelay: 0,
    hideDelay: 220,
    theme: "dark",
    width: 320,
    manualOrder: [],
  };

  let sidebarVisible = false;
  let hideTimer = null;
  let showTimer = null;
  let previewItem = null;
  let tooltipTimer = null;
  let allTabs = [];
  let searchQuery = "";
  let settings = { ...DEFAULT_SETTINGS };
  let keepOpenUntil = 0;
  let currentZoomFactor = 1;
  let resolvedSide = "left";
  let sortMode = "none";
  let sortSyncBrowser = false;
  let originalBrowserOrder = null;
  let dragTabId = null;

  const safeSendMessage = (payload) =>
    new Promise((resolve) => {
      if (!chrome.runtime?.id) {
        resolve({ success: false, error: "Расширение недоступно." });
        return;
      }
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          const runtimeError = chrome.runtime.lastError?.message;
          if (runtimeError) {
            resolve({ success: false, error: runtimeError });
            return;
          }
          resolve(response);
        });
      } catch (error) {
        resolve({ success: false, error: error?.message || "Ошибка отправки сообщения." });
      }
    });

  const needsSanitization = (iconUrl) =>
    typeof iconUrl === "string" && location.protocol === "https:" && /^http:\/\//i.test(iconUrl);

  const getSafeIconUrl = (iconUrl) => {
    if (!iconUrl) return Promise.resolve(null);
    if (!needsSanitization(iconUrl)) return Promise.resolve(iconUrl);
    if (SAFE_ICON_CACHE.has(iconUrl)) return SAFE_ICON_CACHE.get(iconUrl);

    const promise = safeSendMessage({ type: "resolveFavicon", url: iconUrl }).then((response) => {
      if (response?.success && response.dataUrl) return response.dataUrl;
      return null;
    });

    SAFE_ICON_CACHE.set(iconUrl, promise);
    return promise;
  };

  const getChromeFaviconUrl = (tabUrl) => {
    if (!tabUrl || !/^https?:/i.test(tabUrl)) return "";
    return `chrome://favicon2/?size=32&scale_factor=2x&page_url=${encodeURIComponent(tabUrl)}`;
  };

  const sidebar = document.createElement("div");
  sidebar.id = "tab-hover-sidebar";
  sidebar.setAttribute("tabindex", "-1");
  sidebar.innerHTML = `
    <div class="tab-resizer" aria-hidden="true"></div>
    <div class="tab-sidebar-header">
      <span class="header-title">Вкладки</span>
      <div class="header-actions">
        <button type="button" class="sidebar-sort" title="Сортировка">⇅</button>
        <button type="button" class="sidebar-refresh" title="Обновить список">↻</button>
        <button type="button" class="sidebar-settings" title="Настройки">⚙</button>
      </div>
    </div>
    <div class="tab-sort-panel" hidden>
      <label>Сортировка
        <select class="sort-mode">
          <option value="none">Без сортировки (исходный порядок)</option>
          <option value="domainAsc">Домен (А→Я)</option>
          <option value="domainDesc">Домен (Я→А)</option>
          <option value="lastAccessedAsc">Последний просмотр (старые→новые)</option>
          <option value="lastAccessedDesc">Последний просмотр (новые→старые)</option>
        </select>
      </label>
      <label class="settings-checkbox-row">
        <input type="checkbox" class="sort-sync-browser" />
        Сортировать и стандартную панель вкладок
      </label>
    </div>
    <div class="tab-sidebar-warning" hidden>
      Панель может отображаться некорректно. Обновите текущую вкладку.
    </div>
    <div class="tab-sidebar-toolbar">
      <input type="text" class="tab-search" placeholder="Поиск вкладок" aria-label="Поиск вкладок" />
      <button type="button" class="tab-search-clear" title="Очистить поиск" aria-label="Очистить поиск" hidden>✕</button>
      <span class="tabs-count">0</span>
    </div>
    <div class="tab-settings-panel" hidden>
      <label class="settings-checkbox-row"><input type="checkbox" class="settings-preview-toggle" /> Показывать превью</label>
      <label>Позиция
        <select class="settings-position">
          <option value="left">Слева</option>
          <option value="right">Справа</option>
          <option value="both">Слева и справа</option>
        </select>
      </label>
      <label>Задержка показа (мс)
        <input type="number" class="settings-show-delay" min="0" max="3000" step="50" />
      </label>
      <label>Задержка скрытия (мс)
        <input type="number" class="settings-hide-delay" min="0" max="3000" step="50" />
      </label>
      <label>Тема
        <select class="settings-theme">
          <option value="dark">Темная</option>
          <option value="light">Светлая</option>
        </select>
      </label>
    </div>
    <div class="tabs-list" role="list"></div>
    <div class="tab-sidebar-empty">Нет доступных вкладок</div>
    <div class="tab-preview" aria-hidden="true"></div>
    <div class="tab-tooltip" aria-hidden="true"></div>
  `;
  document.documentElement.appendChild(sidebar);

  const refreshButton = sidebar.querySelector(".sidebar-refresh");
  const settingsButton = sidebar.querySelector(".sidebar-settings");
  const sortButton = sidebar.querySelector(".sidebar-sort");
  const sortPanel = sidebar.querySelector(".tab-sort-panel");
  const sortModeSelect = sidebar.querySelector(".sort-mode");
  const sortSyncCheckbox = sidebar.querySelector(".sort-sync-browser");
  const searchInput = sidebar.querySelector(".tab-search");
  const searchClearButton = sidebar.querySelector(".tab-search-clear");
  const counter = sidebar.querySelector(".tabs-count");
  const settingsPanel = sidebar.querySelector(".tab-settings-panel");
  const warningBox = sidebar.querySelector(".tab-sidebar-warning");
  const resizer = sidebar.querySelector(".tab-resizer");
  const previewToggle = sidebar.querySelector(".settings-preview-toggle");
  const positionSelect = sidebar.querySelector(".settings-position");
  const showDelayInput = sidebar.querySelector(".settings-show-delay");
  const hideDelayInput = sidebar.querySelector(".settings-hide-delay");
  const themeSelect = sidebar.querySelector(".settings-theme");
  const list = sidebar.querySelector(".tabs-list");
  const emptyState = sidebar.querySelector(".tab-sidebar-empty");
  const preview = sidebar.querySelector(".tab-preview");
  const tooltip = sidebar.querySelector(".tab-tooltip");

  const applySidebarPlacement = () => {
    sidebar.classList.remove("position-left", "position-right", "theme-dark", "theme-light");
    const side = settings.position === "both" ? resolvedSide : settings.position;
    sidebar.classList.add(`position-${side}`);
    sidebar.classList.add(`theme-${settings.theme}`);
    sidebar.style.width = `${settings.width}px`;
  };

  const applyZoomCompensation = (zoomFactor) => {
    const parsedFactor = Number(zoomFactor);
    currentZoomFactor = Number.isFinite(parsedFactor) && parsedFactor > 0 ? parsedFactor : 1;
    sidebar.style.zoom = String(1 / currentZoomFactor);
  };

  const saveSettings = async () => {
    if (!chrome.storage?.local) return;
    await chrome.storage.local.set(settings);
  };

  const loadSettings = async () => {
    if (!chrome.storage?.local) return;
    const result = await chrome.storage.local.get(DEFAULT_SETTINGS);
    settings = {
      ...DEFAULT_SETTINGS,
      ...result,
      showDelay: Number(result.showDelay ?? DEFAULT_SETTINGS.showDelay),
      hideDelay: Number(result.hideDelay ?? DEFAULT_SETTINGS.hideDelay),
      width: Math.max(260, Math.min(560, Number(result.width ?? DEFAULT_SETTINGS.width))),
      manualOrder: Array.isArray(result.manualOrder) ? result.manualOrder : [],
    };

    previewToggle.checked = Boolean(settings.showPreview);
    positionSelect.value = settings.position;
    showDelayInput.value = String(settings.showDelay);
    hideDelayInput.value = String(settings.hideDelay);
    themeSelect.value = settings.theme;
    applySidebarPlacement();
  };

  const cancelHide = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const cancelShow = () => {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
  };

  const hideTooltip = () => {
    tooltip.classList.remove("visible");
    tooltip.textContent = "";
    if (tooltipTimer) {
      clearTimeout(tooltipTimer);
      tooltipTimer = null;
    }
  };

  const hidePreview = () => {
    preview.classList.remove("visible");
    preview.innerHTML = "";
    previewItem = null;
    hideTooltip();
  };

  const scheduleHide = () => {
    if (Date.now() < keepOpenUntil) return;
    cancelHide();
    hideTimer = setTimeout(() => hideSidebar(), Math.max(0, Number(settings.hideDelay) || 0));
  };

  const resolveSideByPointer = (event) => {
    if (settings.position !== "both") return;
    resolvedSide = event.clientX <= window.innerWidth / 2 ? "left" : "right";
    applySidebarPlacement();
  };

  const showSidebar = () => {
    cancelShow();
    if (sidebarVisible) return;
    const delay = Math.max(0, Number(settings.showDelay) || 0);
    showTimer = setTimeout(() => {
      sidebarVisible = true;
      sidebar.classList.add("visible");
      requestTabs();
    }, delay);
  };

  const hideSidebar = (force = false) => {
    if (!sidebarVisible) return;
    if (!force) {
      const active = document.activeElement;
      if (active && sidebar.contains(active) && sidebar.matches(":hover")) return;
    }
    sidebarVisible = false;
    sidebar.classList.remove("visible");
    hidePreview();
    settingsPanel.hidden = true;
    sortPanel.hidden = true;
  };

  const requestTabs = async () => {
    const response = await safeSendMessage({ type: "getTabs" });
    if (!response?.success) {
      allTabs = [];
      const message = String(response?.error || "").toLowerCase();
      warningBox.hidden = !(message.includes("context invalidated") || message.includes("receiving end"));
      renderTabs();
      return;
    }

    warningBox.hidden = true;
    allTabs = response.tabs || [];
    applyZoomCompensation(response.zoomFactor);
    renderTabs();
  };

  const buildFallbackIcon = (title) => {
    const fallback = document.createElement("span");
    fallback.className = "tab-icon fallback";
    const symbol = (title || "•").trim().charAt(0).toUpperCase() || "•";
    fallback.textContent = symbol;
    return fallback;
  };

  const createIconImage = (src) => {
    const icon = document.createElement("img");
    icon.className = "tab-icon";
    icon.alt = "";
    icon.decoding = "async";
    icon.referrerPolicy = "no-referrer";
    icon.src = src;
    return icon;
  };

  const tryChromeFavicon = (tab, node) => {
    const chromeFavicon = getChromeFaviconUrl(tab.url);
    if (!chromeFavicon || !node.isConnected) return;
    node.replaceWith(createIconImage(chromeFavicon));
  };

  const buildIconNode = (tab) => {
    if (!tab.favIconUrl) {
      const fallback = buildFallbackIcon(tab.title);
      tryChromeFavicon(tab, fallback);
      return fallback;
    }

    if (!needsSanitization(tab.favIconUrl)) {
      const icon = createIconImage(tab.favIconUrl);
      icon.addEventListener("error", () => {
        const fallback = buildFallbackIcon(tab.title);
        icon.replaceWith(fallback);

        getSafeIconUrl(tab.favIconUrl)
          .then((safeUrl) => {
            if (safeUrl && fallback.isConnected) {
              fallback.replaceWith(createIconImage(safeUrl));
              return;
            }
            tryChromeFavicon(tab, fallback);
          })
          .catch(() => {
            tryChromeFavicon(tab, fallback);
          });
      });
      return icon;
    }

    const placeholder = buildFallbackIcon(tab.title);
    getSafeIconUrl(tab.favIconUrl)
      .then((safeUrl) => {
        if (safeUrl && placeholder.isConnected) {
          placeholder.replaceWith(createIconImage(safeUrl));
          return;
        }
        tryChromeFavicon(tab, placeholder);
      })
      .catch(() => {
        tryChromeFavicon(tab, placeholder);
      });

    return placeholder;
  };

  const getDomain = (url) => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  };

  const compareBySortMode = (a, b) => {
    if (sortMode === "domainAsc") {
      return getDomain(a.url).localeCompare(getDomain(b.url), "ru");
    }
    if (sortMode === "domainDesc") {
      return getDomain(b.url).localeCompare(getDomain(a.url), "ru");
    }
    if (sortMode === "lastAccessedAsc") {
      return (a.lastAccessed || 0) - (b.lastAccessed || 0);
    }
    if (sortMode === "lastAccessedDesc") {
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    }
    return 0;
  };

  const getSourceOrderedTabs = () => [...allTabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const applyManualOrder = (tabs) => {
    if (!settings.manualOrder?.length) return tabs;
    const pos = new Map(settings.manualOrder.map((id, index) => [id, index]));
    return [...tabs].sort((a, b) => {
      const ap = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
      const bp = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (ap !== bp) return ap - bp;
      return (a.index ?? 0) - (b.index ?? 0);
    });
  };

  const getOrderedTabs = () => {
    const source = getSourceOrderedTabs();
    const sorted = sortMode === "none" ? applyManualOrder(source) : [...source].sort(compareBySortMode);
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((tab) => {
      const title = (tab.title || "").toLowerCase();
      const url = (tab.url || "").toLowerCase();
      return title.includes(query) || url.includes(query);
    });
  };

  const syncBrowserTabsOrder = async (orderedIds) => {
    if (!sortSyncBrowser || !orderedIds?.length) return;
    await safeSendMessage({ type: "reorderTabs", orderedIds });
    requestTabs();
  };

  const maybeApplyBrowserSort = async () => {
    if (!sortSyncBrowser) return;

    if (sortMode === "none") {
      if (originalBrowserOrder?.length) {
        await safeSendMessage({ type: "reorderTabs", orderedIds: originalBrowserOrder });
      }
      originalBrowserOrder = null;
      requestTabs();
      return;
    }

    if (!originalBrowserOrder?.length) {
      originalBrowserOrder = getSourceOrderedTabs().map((tab) => tab.id);
    }

    const orderedIds = getOrderedTabs().map((tab) => tab.id);
    await syncBrowserTabsOrder(orderedIds);
  };

  const renderTabs = () => {
    const tabs = getOrderedTabs();
    counter.textContent = String(tabs.length);
    list.innerHTML = "";

    if (!tabs.length) {
      emptyState.style.display = "flex";
      hidePreview();
      return;
    }

    emptyState.style.display = "none";
    const fragment = document.createDocumentFragment();

    tabs.forEach((tab) => {
      const item = document.createElement("div");
      item.className = `tab-item${tab.active ? " is-active" : ""}`;
      item.setAttribute("role", "listitem");
      item.dataset.tabId = tab.id;
      item.dataset.title = tab.title || "Без названия";
      item.dataset.url = tab.url || "";
      item.dataset.preview = tab.preview || "";
      item.draggable = sortMode === "none";

      const pin = document.createElement("span");
      pin.className = "tab-pin";
      pin.title = "Закрепленная вкладка";
      pin.textContent = "📌";
      pin.hidden = !tab.pinned;

      const iconNode = buildIconNode(tab);

      const title = document.createElement("div");
      title.className = "tab-title";
      title.textContent = tab.title || "Без названия";

      const actions = document.createElement("div");
      actions.className = "tab-actions";

      const reloadBtn = document.createElement("button");
      reloadBtn.type = "button";
      reloadBtn.className = "tab-action";
      reloadBtn.dataset.action = "reload";
      reloadBtn.title = "Обновить вкладку";
      reloadBtn.textContent = "↻";

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "tab-action danger";
      closeBtn.dataset.action = "close";
      closeBtn.title = "Закрыть вкладку";
      closeBtn.textContent = "✕";

      actions.append(reloadBtn, closeBtn);
      item.append(pin, iconNode, title, actions);
      fragment.append(item);
    });

    list.append(fragment);
  };

  const handleAction = async (action, tabId) => {
    const typeMap = {
      activate: "activateTab",
      reload: "reloadTab",
      close: "removeTab",
    };
    const type = typeMap[action];
    if (!type) return;

    const response = await safeSendMessage({ type, tabId });
    if (!response?.success) return;

    if (action === "activate") {
      hideSidebar(true);
      return;
    }

    keepOpenUntil = Date.now() + 1200;
    cancelHide();
    requestTabs();
  };

  const showPreviewOrTooltip = (item, mouseEvent) => {
    if (!settings.showPreview) {
      hidePreview();
      const fullText = item.dataset.title || "";
      if (!fullText) return;
      if (tooltipTimer) clearTimeout(tooltipTimer);
      tooltipTimer = setTimeout(() => {
        tooltip.textContent = fullText;
        const rect = sidebar.getBoundingClientRect();
        const offsetY = Math.min(rect.height - 64, Math.max(16, mouseEvent.clientY - rect.top - 18));
        tooltip.style.top = `${offsetY}px`;
        tooltip.classList.add("visible");
      }, 350);
      return;
    }

    hideTooltip();

    if (previewItem !== item) {
      previewItem = item;
      preview.innerHTML = "";

      const title = document.createElement("div");
      title.className = "preview-title";
      title.textContent = item.dataset.title || "Без названия";

      const url = document.createElement("div");
      url.className = "preview-url";
      url.textContent = item.dataset.url || "";

      preview.append(title, url);
    }

    const sidebarRect = sidebar.getBoundingClientRect();
    const offsetY = Math.min(sidebarRect.height - 160, Math.max(16, mouseEvent.clientY - sidebarRect.top - 20));

    preview.style.top = `${offsetY}px`;
    preview.classList.add("visible");
  };

  const pointerOnTrigger = (event) => {
    if (settings.position === "left") return event.clientX <= EDGE_TRIGGER_PX;
    if (settings.position === "right") return event.clientX >= window.innerWidth - EDGE_TRIGGER_PX;
    return event.clientX <= EDGE_TRIGGER_PX || event.clientX >= window.innerWidth - EDGE_TRIGGER_PX;
  };

  const shouldHideOnMove = (event) => {
    const rect = sidebar.getBoundingClientRect();
    if (resolvedSide === "right") {
      return event.clientX < rect.left - 24;
    }
    return event.clientX > rect.right + 24;
  };

  const updateManualOrder = async (draggedId, targetId, insertBefore) => {
    const currentIds = applyManualOrder(getSourceOrderedTabs()).map((tab) => tab.id);
    const fromIndex = currentIds.indexOf(draggedId);
    const targetIndex = currentIds.indexOf(targetId);
    if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return;

    const [moved] = currentIds.splice(fromIndex, 1);
    const adjustedTarget = currentIds.indexOf(targetId);
    const insertIndex = insertBefore ? adjustedTarget : adjustedTarget + 1;
    currentIds.splice(insertIndex, 0, moved);

    settings.manualOrder = currentIds;
    await saveSettings();
    renderTabs();
  };

  document.addEventListener("mousemove", (event) => {
    if (pointerOnTrigger(event)) {
      resolveSideByPointer(event);
      showSidebar();
    } else if (sidebarVisible && !sidebar.contains(event.target) && shouldHideOnMove(event)) {
      scheduleHide();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideSidebar(true);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hideSidebar(true);
  });

  window.addEventListener("blur", () => hideSidebar(true));

  document.addEventListener("pointerdown", (event) => {
    if (!sidebarVisible || sidebar.contains(event.target)) return;
    hideSidebar(true);
  });

  document.addEventListener("focusin", (event) => {
    if (!sidebarVisible || sidebar.contains(event.target)) return;
    hideSidebar(true);
  });

  sidebar.addEventListener("mouseenter", () => {
    cancelHide();
    cancelShow();
  });
  sidebar.addEventListener("mouseleave", scheduleHide);
  sidebar.addEventListener("focusin", cancelHide);
  sidebar.addEventListener("focusout", (event) => {
    if (!sidebar.contains(event.relatedTarget)) scheduleHide();
  });

  refreshButton.addEventListener("click", () => requestTabs());

  settingsButton.addEventListener("click", () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    if (!settingsPanel.hidden) sortPanel.hidden = true;
  });

  sortButton.addEventListener("click", () => {
    sortPanel.hidden = !sortPanel.hidden;
    if (!sortPanel.hidden) settingsPanel.hidden = true;
  });

  sortModeSelect.addEventListener("change", async () => {
    sortMode = sortModeSelect.value;
    renderTabs();
    await maybeApplyBrowserSort();
  });

  sortSyncCheckbox.addEventListener("change", async () => {
    sortSyncBrowser = sortSyncCheckbox.checked;
    await maybeApplyBrowserSort();
  });

  previewToggle.addEventListener("change", () => {
    settings.showPreview = previewToggle.checked;
    saveSettings();
    hidePreview();
  });

  positionSelect.addEventListener("change", () => {
    settings.position = positionSelect.value;
    applySidebarPlacement();
    saveSettings();
  });

  showDelayInput.addEventListener("change", () => {
    settings.showDelay = Math.max(0, Number(showDelayInput.value) || 0);
    showDelayInput.value = String(settings.showDelay);
    saveSettings();
  });

  hideDelayInput.addEventListener("change", () => {
    settings.hideDelay = Math.max(0, Number(hideDelayInput.value) || 0);
    hideDelayInput.value = String(settings.hideDelay);
    saveSettings();
  });

  themeSelect.addEventListener("change", () => {
    settings.theme = themeSelect.value;
    applySidebarPlacement();
    saveSettings();
  });

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value || "";
    searchClearButton.hidden = !searchQuery;
    renderTabs();
  });

  searchClearButton.addEventListener("click", () => {
    searchInput.value = "";
    searchQuery = "";
    searchClearButton.hidden = true;
    renderTabs();
    searchInput.focus();
  });

  list.addEventListener("click", (event) => {
    const item = event.target.closest(".tab-item");
    if (!item) return;

    const tabId = Number(item.dataset.tabId);
    if (!tabId) return;

    const button = event.target.closest("button[data-action]");
    if (button) {
      event.stopPropagation();
      handleAction(button.dataset.action, tabId);
      return;
    }

    handleAction("activate", tabId);
  });

  list.addEventListener(
    "mousemove",
    (event) => {
      const item = event.target.closest(".tab-item");
      if (!item) {
        hidePreview();
        return;
      }
      showPreviewOrTooltip(item, event);
    },
    { passive: true },
  );

  list.addEventListener("mouseleave", () => hidePreview());

  list.addEventListener("dragstart", (event) => {
    const item = event.target.closest(".tab-item");
    if (!item || sortMode !== "none") return;
    dragTabId = Number(item.dataset.tabId);
    item.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(dragTabId));
  });

  list.addEventListener("dragend", (event) => {
    const item = event.target.closest(".tab-item");
    if (item) item.classList.remove("is-dragging");
    dragTabId = null;
  });

  list.addEventListener("dragover", (event) => {
    if (sortMode !== "none") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });

  list.addEventListener("drop", async (event) => {
    if (sortMode !== "none") return;
    event.preventDefault();
    const target = event.target.closest(".tab-item");
    if (!target || !dragTabId) return;

    const targetId = Number(target.dataset.tabId);
    if (!targetId || targetId === dragTabId) return;

    const rect = target.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    await updateManualOrder(dragTabId, targetId, insertBefore);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "zoomChanged") {
      applyZoomCompensation(message.zoomFactor);
    }
  });

  list.addEventListener(
    "wheel",
    (event) => {
      const { scrollTop, scrollHeight, clientHeight } = list;
      const scrollingDown = event.deltaY > 0;
      const scrollingUp = event.deltaY < 0;
      const atTop = scrollTop <= 0;
      const atBottom = scrollTop + clientHeight >= scrollHeight;
      const canScroll = scrollHeight > clientHeight;

      if (canScroll && ((scrollingDown && !atBottom) || (scrollingUp && !atTop))) {
        event.preventDefault();
        list.scrollTop += event.deltaY;
      }
    },
    { passive: false },
  );

  resizer.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    const resizeFromRight = resolvedSide === "right";

    const onMove = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      const next = resizeFromRight ? startWidth - delta : startWidth + delta;
      settings.width = Math.max(260, Math.min(560, Math.round(next)));
      sidebar.style.width = `${settings.width}px`;
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      saveSettings();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  loadSettings().finally(async () => {
    const zoomResponse = await safeSendMessage({ type: "getZoom" });
    if (zoomResponse?.success) {
      applyZoomCompensation(zoomResponse.zoomFactor);
    }
    requestTabs();
  });
})();
