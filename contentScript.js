(() => {
  if (window.__tabHoverSidebarInit) return;
  window.__tabHoverSidebarInit = true;

  const EDGE_TRIGGER_PX = 16;
  const HIDE_DELAY_MS = 220;
  const SAFE_ICON_CACHE = new Map();
  const DEFAULT_SETTINGS = { showPreview: true };

  let sidebarVisible = false;
  let hideTimer = null;
  let previewItem = null;
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

  const loadSettings = async () => {
    if (!chrome.storage?.local) return;
    const result = await chrome.storage.local.get(DEFAULT_SETTINGS);
    settings = { ...DEFAULT_SETTINGS, ...result };
    previewToggle.checked = Boolean(settings.showPreview);
  };

  const saveSettings = async () => {
    if (!chrome.storage?.local) return;
    await chrome.storage.local.set(settings);
  };

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
    <div class="tab-sidebar-header">
      <span class="header-title">Вкладки</span>
      <div class="header-actions">
        <button type="button" class="sidebar-refresh" title="Обновить список">↻</button>
        <button type="button" class="sidebar-settings" title="Настройки">⚙</button>
      </div>
    </div>
    <div class="tab-sidebar-toolbar">
      <input type="search" class="tab-search" placeholder="Поиск вкладок" aria-label="Поиск вкладок" />
      <span class="tabs-count">0</span>
    </div>
    <div class="tab-settings-panel" hidden>
      <label>
        <input type="checkbox" class="settings-preview-toggle" /> Показывать превью
      </label>
    </div>
    <div class="tabs-list" role="list"></div>
    <div class="tab-sidebar-empty">Нет доступных вкладок</div>
    <div class="tab-preview" aria-hidden="true"></div>
  `;
  document.documentElement.appendChild(sidebar);

  const refreshButton = sidebar.querySelector(".sidebar-refresh");
  const settingsButton = sidebar.querySelector(".sidebar-settings");
  const searchInput = sidebar.querySelector(".tab-search");
  const counter = sidebar.querySelector(".tabs-count");
  const settingsPanel = sidebar.querySelector(".tab-settings-panel");
  const previewToggle = sidebar.querySelector(".settings-preview-toggle");
  const list = sidebar.querySelector(".tabs-list");
  const emptyState = sidebar.querySelector(".tab-sidebar-empty");
  const preview = sidebar.querySelector(".tab-preview");

  const cancelHide = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const hidePreview = () => {
    preview.classList.remove("visible");
    preview.innerHTML = "";
    previewItem = null;
  };

  const scheduleHide = () => {
    cancelHide();
    hideTimer = setTimeout(() => hideSidebar(), HIDE_DELAY_MS);
  };

  const showSidebar = () => {
    if (sidebarVisible) return;
    sidebarVisible = true;
    sidebar.classList.add("visible");
    requestTabs();
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
      console.warn("Не удалось получить вкладки:", response?.error);
      allTabs = [];
      renderTabs();
      return;
    }
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
    if (!response?.success) {
      console.warn(`Операция ${action} не выполнена:`, response?.error);
      return;
    }

    if (action === "activate") {
      hideSidebar(true);
      return;
    }

    requestTabs();
  };

  const showPreview = (item, mouseEvent) => {
    if (!settings.showPreview) {
      hidePreview();
      return;
    }

    if (previewItem !== item) {
      previewItem = item;
      preview.innerHTML = "";

      const previewImage = document.createElement("img");
      previewImage.className = "preview-image";
      previewImage.alt = item.dataset.title || "Превью вкладки";

      if (item.dataset.preview) {
        previewImage.src = item.dataset.preview;
        preview.append(previewImage);
      } else {
        const title = document.createElement("div");
        title.className = "preview-title";
        title.textContent = item.dataset.title || "Без названия";
        preview.append(title);
      }
    }

    const sidebarRect = sidebar.getBoundingClientRect();
    const offsetY = Math.min(sidebarRect.height - 160, Math.max(16, mouseEvent.clientY - sidebarRect.top - 20));

    preview.style.top = `${offsetY}px`;
    preview.classList.add("visible");
  };

  document.addEventListener("mousemove", (event) => {
    if (event.clientX <= EDGE_TRIGGER_PX) {
      showSidebar();
    } else if (
      sidebarVisible &&
      !sidebar.contains(event.target) &&
      event.clientX > sidebar.getBoundingClientRect().right + 24
    ) {
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

  sidebar.addEventListener("mouseenter", cancelHide);
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
    if (!settings.showPreview) hidePreview();
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
      showPreview(item, event);
    },
    { passive: true },
  );

  list.addEventListener("mouseleave", () => hidePreview());

  loadSettings().finally(requestTabs);
})();
