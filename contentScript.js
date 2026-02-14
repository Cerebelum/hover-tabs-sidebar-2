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
  };

  let sidebarVisible = false;
  let hideTimer = null;
  let showTimer = null;
  let previewItem = null;
  let tooltipTimer = null;
  let allTabs = [];
  let searchQuery = "";
  let settings = { ...DEFAULT_SETTINGS };

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
        <button type="button" class="sidebar-settings" title="Настройки">⚙</button>
      </div>
    </div>
    <div class="tab-sidebar-warning" hidden>
      Панель может отображаться некорректно. Обновите текущую вкладку.
    </div>
    <div class="tab-sidebar-toolbar">
      <input type="search" class="tab-search" placeholder="Поиск вкладок" aria-label="Поиск вкладок" />
      <span class="tabs-count">0</span>
    </div>
    <div class="tab-settings-panel" hidden>
      <label><input type="checkbox" class="settings-preview-toggle" /> Показывать превью</label>
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
  const searchInput = sidebar.querySelector(".tab-search");
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
    sidebar.classList.add(`position-${settings.position === "both" ? "left" : settings.position}`);
    sidebar.classList.add(`theme-${settings.theme}`);
    sidebar.style.width = `${settings.width}px`;
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
    cancelHide();
    hideTimer = setTimeout(() => hideSidebar(), Math.max(0, Number(settings.hideDelay) || 0));
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
      if (active && sidebar.contains(active)) return;
    }
    sidebarVisible = false;
    sidebar.classList.remove("visible");
    hidePreview();
    settingsPanel.hidden = true;
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
    renderTabs();
  };

  const buildFallbackIcon = (title) => {
    const fallback = document.createElement("span");
    fallback.className = "tab-icon fallback";
    const symbol = (title || "•").trim().charAt(0).toUpperCase() || "•";
    fallback.textContent = symbol;
    return fallback;
  };

  const buildIconNode = (tab) => {
    if (!tab.favIconUrl) return buildFallbackIcon(tab.title);

    if (!needsSanitization(tab.favIconUrl)) {
      const icon = document.createElement("img");
      icon.className = "tab-icon";
      icon.alt = "";
      icon.decoding = "async";
      icon.referrerPolicy = "no-referrer";
      icon.src = tab.favIconUrl;
      return icon;
    }

    const placeholder = buildFallbackIcon(tab.title);
    getSafeIconUrl(tab.favIconUrl)
      .then((safeUrl) => {
        if (!safeUrl) return;
        const icon = document.createElement("img");
        icon.className = "tab-icon";
        icon.alt = "";
        icon.decoding = "async";
        icon.referrerPolicy = "no-referrer";
        icon.src = safeUrl;
        placeholder.replaceWith(icon);
      })
      .catch(() => {});

    return placeholder;
  };

  const getFilteredTabs = () => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return allTabs;
    return allTabs.filter((tab) => {
      const title = (tab.title || "").toLowerCase();
      const url = (tab.url || "").toLowerCase();
      return title.includes(query) || url.includes(query);
    });
  };

  const renderTabs = () => {
    const tabs = getFilteredTabs();
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
      item.append(iconNode, title, actions);
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

      if (item.dataset.preview) {
        const previewImage = document.createElement("img");
        previewImage.className = "preview-image";
        previewImage.alt = item.dataset.title || "Превью вкладки";
        previewImage.src = item.dataset.preview;
        preview.append(previewImage);
      } else {
        const title = document.createElement("div");
        title.className = "preview-title";
        title.textContent = item.dataset.title || "Без названия";

        const url = document.createElement("div");
        url.className = "preview-url";
        url.textContent = item.dataset.url || "";

        preview.append(title, url);
      }
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
    if (settings.position === "right") {
      return event.clientX < rect.left - 24;
    }
    return event.clientX > rect.right + 24;
  };

  document.addEventListener("mousemove", (event) => {
    if (pointerOnTrigger(event)) {
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
    renderTabs();
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

  resizer.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    const resizeFromRight = settings.position === "right";

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

  loadSettings().finally(requestTabs);
})();
