(() => {
  if (window.__tabHoverSidebarInit) return;
  window.__tabHoverSidebarInit = true;

  const SAFE_ICON_CACHE = new Map();
  const SORT_NONE = "none";
  const EDGE_TRIGGER_PX = 16;
  const DEFAULT_SETTINGS = {
    showPreview: true,
    position: "left",
    showDelay: 0,
    hideDelay: 220,
    theme: "dark",
    width: 320,
    edgeSensitivityPx: 16,
    ignoreScrollbarHover: false,
    edgeTransientDelayMs: 0,
  };

  let sidebarVisible = false;
  let hideTimer = null;
  let showTimer = null;
  let edgeIntentTimer = null;
  let previewItem = null;
  let tooltipTimer = null;
  let allTabs = [];
  let searchQuery = "";
  let settings = { ...DEFAULT_SETTINGS };
  let edgeTriggerPx = EDGE_TRIGGER_PX;
  let keepOpenUntil = 0;
  let currentZoomFactor = 1;
  let currentSide = "left";
  let cursorInTriggerZone = false;
  let sortMode = SORT_NONE;
  let sortWithBrowser = false;
  let sidebarOrder = [];
  let browserOriginalOrder = [];
  let browserSortApplied = false;
  let draggedTabId = null;
  let dropTargetTabId = null;
  let dropInsertAfter = false;

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

  const sidebar = document.createElement("div");
  sidebar.id = "tab-hover-sidebar";
  sidebar.setAttribute("tabindex", "-1");
  sidebar.innerHTML = `
    <div class="tab-resizer" aria-hidden="true"></div>
    <div class="tab-sidebar-header">
      <span class="header-title">Вкладки</span>
      <div class="header-actions">
        <button type="button" class="sidebar-refresh" title="Обновить список">↻</button>
        <button type="button" class="sidebar-sort" title="Сортировка">⇅</button>
        <button type="button" class="sidebar-settings" title="Настройки">⚙</button>
      </div>
    </div>
    <div class="tab-sort-panel" hidden>
      <label>Тип сортировки
        <select class="sort-mode-select">
          <option value="none">Без сортировки</option>
          <option value="domainAsc">Домен (А-Я)</option>
          <option value="domainDesc">Домен (Я-А)</option>
          <option value="lastViewedAsc">Последний просмотр (старые → новые)</option>
          <option value="lastViewedDesc">Последний просмотр (новые → старые)</option>
        </select>
      </label>
      <label class="settings-checkbox-row"><input type="checkbox" class="sort-with-browser" /> Сортировать и стандартные вкладки Chrome</label>
      <div class="sort-actions">
        <button type="button" class="sort-apply">Применить</button>
        <button type="button" class="sort-reset">Сбросить</button>
      </div>
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
      <label>Edge activation zone (px)
        <input type="number" class="settings-edge-sensitivity" min="0" max="128" step="1" />
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
  const sortButton = sidebar.querySelector(".sidebar-sort");
  const settingsButton = sidebar.querySelector(".sidebar-settings");
  const sortPanel = sidebar.querySelector(".tab-sort-panel");
  const sortModeSelect = sidebar.querySelector(".sort-mode-select");
  const sortWithBrowserCheckbox = sidebar.querySelector(".sort-with-browser");
  const sortApplyButton = sidebar.querySelector(".sort-apply");
  const sortResetButton = sidebar.querySelector(".sort-reset");
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
  const edgeSensitivityInput = sidebar.querySelector(".settings-edge-sensitivity");
  const themeSelect = sidebar.querySelector(".settings-theme");
  const list = sidebar.querySelector(".tabs-list");
  const emptyState = sidebar.querySelector(".tab-sidebar-empty");
  const preview = sidebar.querySelector(".tab-preview");
  const tooltip = sidebar.querySelector(".tab-tooltip");

  const getTargetSide = () => (settings.position === "both" ? currentSide : settings.position);

  const applySidebarPlacement = () => {
    const targetSide = getTargetSide();
    sidebar.classList.toggle("position-left", targetSide === "left");
    sidebar.classList.toggle("position-right", targetSide === "right");
    sidebar.classList.toggle("theme-dark", settings.theme === "dark");
    sidebar.classList.toggle("theme-light", settings.theme === "light");
    sidebar.style.width = `${settings.width}px`;
  };

  const switchSidebarSideWithoutJank = (nextSide) => {
    if (nextSide === currentSide) return;
    const wasVisible = sidebarVisible;

    sidebar.classList.add("no-transition");
    if (wasVisible) {
      sidebar.classList.remove("visible");
    }

    currentSide = nextSide;
    applySidebarPlacement();
    void sidebar.offsetWidth;

    if (wasVisible) {
      sidebar.classList.add("visible");
    }
    requestAnimationFrame(() => sidebar.classList.remove("no-transition"));
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
      edgeSensitivityPx: Number(result.edgeSensitivityPx ?? DEFAULT_SETTINGS.edgeSensitivityPx),
      ignoreScrollbarHover: Boolean(result.ignoreScrollbarHover ?? DEFAULT_SETTINGS.ignoreScrollbarHover),
      edgeTransientDelayMs: Number(result.edgeTransientDelayMs ?? DEFAULT_SETTINGS.edgeTransientDelayMs),
      width: Math.max(260, Math.min(560, Number(result.width ?? DEFAULT_SETTINGS.width))),
    };
    edgeTriggerPx =
      Number.isFinite(Number(settings.edgeSensitivityPx))
        ? Math.max(0, Number(settings.edgeSensitivityPx))
        : EDGE_TRIGGER_PX;

    previewToggle.checked = Boolean(settings.showPreview);
    positionSelect.value = settings.position;
    showDelayInput.value = String(settings.showDelay);
    hideDelayInput.value = String(settings.hideDelay);
    edgeSensitivityInput.value = String(settings.edgeSensitivityPx);
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

  const cancelEdgeIntent = () => {
    if (edgeIntentTimer) {
      clearTimeout(edgeIntentTimer);
      edgeIntentTimer = null;
    }
  };

  const triggerShowWithIntentCheck = (side) => {
    const edgeTransientDelay = Math.max(0, Number(settings.edgeTransientDelayMs) || 0);
    if (edgeTransientDelay === 0) {
      showSidebar(side);
      return;
    }

    cancelEdgeIntent();
    edgeIntentTimer = setTimeout(() => {
      edgeIntentTimer = null;
      if (!cursorInTriggerZone) return;
      showSidebar(side);
    }, edgeTransientDelay);
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

  const showSidebar = (side) => {
    if (side && settings.position === "both") {
      switchSidebarSideWithoutJank(side);
    }

    if (sidebarVisible || showTimer) return;
    const delay = Math.max(0, Number(settings.showDelay) || 0);
    showTimer = setTimeout(() => {
      showTimer = null;
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

  const reconcileSidebarOrder = () => {
    const presentIds = allTabs.map((tab) => tab.id);
    const presentSet = new Set(presentIds);
    sidebarOrder = sidebarOrder.filter((tabId) => presentSet.has(tabId));
    presentIds.forEach((id) => {
      if (!sidebarOrder.includes(id)) sidebarOrder.push(id);
    });
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
    reconcileSidebarOrder();
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

  const buildIconNode = (tab) => {
    const fallback = buildFallbackIcon(tab.title);
    const rawSources = [tab.favIconUrl, tab.extensionFavIconUrl].filter(Boolean);
    if (!rawSources.length) return fallback;

    const applySource = (sourceIndex) => {
      if (sourceIndex >= rawSources.length) return;
      const source = rawSources[sourceIndex];
      getSafeIconUrl(source)
        .then((safeUrl) => {
          if (!safeUrl || !fallback.isConnected) {
            applySource(sourceIndex + 1);
            return;
          }
          const icon = createIconImage(safeUrl);
          icon.addEventListener("error", () => {
            if (!fallback.isConnected && icon.isConnected) {
              icon.replaceWith(fallback);
            }
            applySource(sourceIndex + 1);
          });
          if (fallback.isConnected) {
            fallback.replaceWith(icon);
          }
        })
        .catch(() => applySource(sourceIndex + 1));
    };

    setTimeout(() => applySource(0), 0);
    return fallback;
  };

  const getDomain = (url) => {
    try {
      return new URL(url).hostname || "";
    } catch {
      return "";
    }
  };

  const getBaseOrderedTabs = () => {
    const tabMap = new Map(allTabs.map((tab) => [tab.id, tab]));
    return sidebarOrder.map((id) => tabMap.get(id)).filter(Boolean);
  };

  const sortUnpinnedTabs = (tabs) => {
    if (sortMode === SORT_NONE) return tabs;
    const sorted = tabs.slice();

    if (sortMode === "domainAsc") {
      sorted.sort((a, b) => getDomain(a.url).localeCompare(getDomain(b.url), "ru", { sensitivity: "base" }));
    } else if (sortMode === "domainDesc") {
      sorted.sort((a, b) => getDomain(b.url).localeCompare(getDomain(a.url), "ru", { sensitivity: "base" }));
    } else if (sortMode === "lastViewedAsc") {
      sorted.sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
    } else if (sortMode === "lastViewedDesc") {
      sorted.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    }

    return sorted;
  };

  const applySortMode = (tabs) => {
    if (sortMode === SORT_NONE) return tabs;
    const pinned = tabs.filter((tab) => tab.pinned);
    const unpinned = tabs.filter((tab) => !tab.pinned);
    return [...pinned, ...sortUnpinnedTabs(unpinned)];
  };

  const getDisplayTabs = () => {
    const ordered = applySortMode(getBaseOrderedTabs());
    const query = searchQuery.trim().toLowerCase();
    if (!query) return ordered;

    return ordered.filter((tab) => {
      const title = (tab.title || "").toLowerCase();
      const url = (tab.url || "").toLowerCase();
      return title.includes(query) || url.includes(query);
    });
  };

  const renderTabs = () => {
    const tabs = getDisplayTabs();
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
      item.draggable = sortMode === SORT_NONE && !searchQuery.trim();
      if (dropTargetTabId === tab.id) {
        item.classList.add(dropInsertAfter ? "drop-after" : "drop-before");
      }

      const iconNode = buildIconNode(tab);

      const title = document.createElement("div");
      title.className = "tab-title";
      title.textContent = tab.title || "Без названия";

      const actions = document.createElement("div");
      actions.className = "tab-actions";

      const pin = document.createElement("span");
      pin.className = "tab-pin";
      pin.title = "Закрепленная вкладка";
      pin.textContent = "📌";
      pin.hidden = !tab.pinned;

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
      item.append(iconNode, title, pin, actions);
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

  const getTriggerSide = (event) => {
    if (settings.position === "left") return event.clientX <= edgeTriggerPx ? "left" : "";
    if (settings.position === "right") return event.clientX >= window.innerWidth - edgeTriggerPx ? "right" : "";
    if (event.clientX <= edgeTriggerPx) return "left";
    if (event.clientX >= window.innerWidth - edgeTriggerPx) return "right";
    return "";
  };

  const shouldHideOnMove = (event) => {
    const rect = sidebar.getBoundingClientRect();
    const side = getTargetSide();
    if (side === "right") {
      return event.clientX < rect.left - 24;
    }
    return event.clientX > rect.right + 24;
  };

  const getSortedOrderIds = () => applySortMode(getBaseOrderedTabs()).map((tab) => tab.id);

  const applyBrowserOrder = async (tabIds) => {
    const response = await safeSendMessage({ type: "reorderTabs", tabIds });
    return Boolean(response?.success);
  };

  const restoreBrowserOrderIfNeeded = async () => {
    if (!browserSortApplied || !browserOriginalOrder.length) return true;
    const success = await applyBrowserOrder(browserOriginalOrder);
    if (!success) return false;
    browserSortApplied = false;
    browserOriginalOrder = [];
    return true;
  };

  const applySort = async () => {
    sortMode = sortModeSelect.value;
    sortWithBrowser = sortWithBrowserCheckbox.checked;

    if (sortMode === SORT_NONE) {
      await restoreBrowserOrderIfNeeded();
      requestTabs();
      return;
    }

    if (sortWithBrowser) {
      if (!browserSortApplied) {
        browserOriginalOrder = allTabs.map((tab) => tab.id);
      }
      const success = await applyBrowserOrder(getSortedOrderIds());
      if (success) {
        browserSortApplied = true;
        await requestTabs();
      }
      return;
    }

    if (browserSortApplied) {
      await restoreBrowserOrderIfNeeded();
      await requestTabs();
      return;
    }

    renderTabs();
  };

  const resetSort = async () => {
    sortMode = SORT_NONE;
    sortModeSelect.value = SORT_NONE;
    sortWithBrowserCheckbox.checked = false;
    sortWithBrowser = false;
    await restoreBrowserOrderIfNeeded();
    requestTabs();
  };

  const moveTabInArray = (ids, movedId, targetId, insertAfter) => {
    const fromIndex = ids.indexOf(movedId);
    const targetIndex = ids.indexOf(targetId);
    if (fromIndex === -1 || targetIndex === -1) return ids;

    const next = ids.slice();
    next.splice(fromIndex, 1);

    let insertionIndex = next.indexOf(targetId);
    if (insertAfter) insertionIndex += 1;
    next.splice(insertionIndex, 0, movedId);
    return next;
  };

  const clearDropIndicator = () => {
    list.querySelectorAll(".tab-item.drop-before, .tab-item.drop-after").forEach((item) => {
      item.classList.remove("drop-before", "drop-after");
    });
  };

  const updateDropIndicator = () => {
    clearDropIndicator();
    if (!dropTargetTabId) return;
    const targetItem = list.querySelector(`.tab-item[data-tab-id="${dropTargetTabId}"]`);
    if (!targetItem) return;
    targetItem.classList.add(dropInsertAfter ? "drop-after" : "drop-before");
  };

  document.addEventListener("mousemove", (event) => {
    const triggerSide =
      settings.ignoreScrollbarHover && event.clientX >= document.documentElement.clientWidth ? "" : getTriggerSide(event);
    if (triggerSide) {
      if (!cursorInTriggerZone) {
        cursorInTriggerZone = true;
        triggerShowWithIntentCheck(triggerSide);
      }
    } else if (sidebarVisible && !sidebar.contains(event.target) && shouldHideOnMove(event)) {
      cursorInTriggerZone = false;
      cancelEdgeIntent();
      cancelShow();
      scheduleHide();
    } else {
      cursorInTriggerZone = false;
      cancelEdgeIntent();
      cancelShow();
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

  sortButton.addEventListener("click", () => {
    sortPanel.hidden = !sortPanel.hidden;
    settingsPanel.hidden = true;
  });

  sortApplyButton.addEventListener("click", () => {
    applySort();
  });

  sortResetButton.addEventListener("click", () => {
    resetSort();
  });

  settingsButton.addEventListener("click", () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    sortPanel.hidden = true;
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

  edgeSensitivityInput.addEventListener("input", () => {
    settings.edgeSensitivityPx = Number(edgeSensitivityInput.value);
    edgeTriggerPx = Number.isFinite(Number(settings.edgeSensitivityPx)) ? Math.max(0, Number(settings.edgeSensitivityPx)) : EDGE_TRIGGER_PX;
  });

  edgeSensitivityInput.addEventListener("change", () => {
    settings.edgeSensitivityPx = Number(edgeSensitivityInput.value);
    edgeTriggerPx = Number.isFinite(Number(settings.edgeSensitivityPx)) ? Math.max(0, Number(settings.edgeSensitivityPx)) : EDGE_TRIGGER_PX;
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

  list.addEventListener("dragstart", (event) => {
    const item = event.target.closest(".tab-item");
    if (!item || !item.draggable) return;
    draggedTabId = Number(item.dataset.tabId);
    item.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(draggedTabId));
    }
  });

  list.addEventListener("dragend", (event) => {
    const item = event.target.closest(".tab-item");
    if (item) item.classList.remove("is-dragging");
    draggedTabId = null;
    dropTargetTabId = null;
    dropInsertAfter = false;
    clearDropIndicator();
  });

  list.addEventListener("dragover", (event) => {
    if (!draggedTabId || searchQuery.trim() || sortMode !== SORT_NONE) return;
    event.preventDefault();

    const target = event.target.closest(".tab-item");
    if (!target) return;

    const targetTabId = Number(target.dataset.tabId);
    if (!targetTabId || targetTabId === draggedTabId) return;

    const rect = target.getBoundingClientRect();
    const nextInsertAfter = event.clientY > rect.top + rect.height / 2;
    if (dropTargetTabId === targetTabId && dropInsertAfter === nextInsertAfter) return;

    dropTargetTabId = targetTabId;
    dropInsertAfter = nextInsertAfter;
    updateDropIndicator();
  });

  list.addEventListener("dragleave", (event) => {
    if (!list.contains(event.relatedTarget)) {
      dropTargetTabId = null;
      dropInsertAfter = false;
      clearDropIndicator();
    }
  });

  list.addEventListener("drop", async (event) => {
    if (!draggedTabId || searchQuery.trim() || sortMode !== SORT_NONE) return;
    event.preventDefault();

    try {
      const target = event.target.closest(".tab-item");
      if (!target) return;

      const targetTabId = Number(target.dataset.tabId);
      if (!targetTabId || targetTabId === draggedTabId) return;

      sidebarOrder = moveTabInArray(sidebarOrder, draggedTabId, targetTabId, dropInsertAfter);

      if (sortWithBrowserCheckbox.checked) {
        await applyBrowserOrder(sidebarOrder);
        await requestTabs();
      } else {
        renderTabs();
      }
    } finally {
      dropTargetTabId = null;
      dropInsertAfter = false;
      clearDropIndicator();
    }
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

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "zoomChanged") {
      applyZoomCompensation(message.zoomFactor);
      return;
    }

    if (message?.type === "manualOpenSidebar") {
      if (sidebarVisible) return;
      cancelShow();
      sidebarVisible = true;
      sidebar.classList.add("visible");
      requestTabs();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    let changed = false;

    if (Object.prototype.hasOwnProperty.call(changes, "showPreview")) {
      settings.showPreview = Boolean(changes.showPreview.newValue ?? DEFAULT_SETTINGS.showPreview);
      previewToggle.checked = settings.showPreview;
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "position")) {
      settings.position = changes.position.newValue ?? DEFAULT_SETTINGS.position;
      positionSelect.value = settings.position;
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "showDelay")) {
      settings.showDelay = Number(changes.showDelay.newValue ?? DEFAULT_SETTINGS.showDelay);
      showDelayInput.value = String(settings.showDelay);
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "hideDelay")) {
      settings.hideDelay = Number(changes.hideDelay.newValue ?? DEFAULT_SETTINGS.hideDelay);
      hideDelayInput.value = String(settings.hideDelay);
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "theme")) {
      settings.theme = changes.theme.newValue ?? DEFAULT_SETTINGS.theme;
      themeSelect.value = settings.theme;
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "width")) {
      settings.width = Math.max(260, Math.min(560, Number(changes.width.newValue ?? DEFAULT_SETTINGS.width)));
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "edgeSensitivityPx")) {
      settings.edgeSensitivityPx = Number(changes.edgeSensitivityPx.newValue ?? DEFAULT_SETTINGS.edgeSensitivityPx);
      edgeSensitivityInput.value = String(settings.edgeSensitivityPx);
      edgeTriggerPx = Number.isFinite(Number(settings.edgeSensitivityPx)) ? Math.max(0, Number(settings.edgeSensitivityPx)) : EDGE_TRIGGER_PX;
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "ignoreScrollbarHover")) {
      settings.ignoreScrollbarHover = Boolean(changes.ignoreScrollbarHover.newValue ?? DEFAULT_SETTINGS.ignoreScrollbarHover);
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "edgeTransientDelayMs")) {
      settings.edgeTransientDelayMs = Number(changes.edgeTransientDelayMs.newValue ?? DEFAULT_SETTINGS.edgeTransientDelayMs);
      changed = true;
    }

    if (!changed) return;
    applySidebarPlacement();
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
    const resizeFromRight = getTargetSide() === "right";

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
