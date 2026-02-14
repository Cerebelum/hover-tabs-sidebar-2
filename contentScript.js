(() => {
  if (window.__tabHoverSidebarInit) return;
  window.__tabHoverSidebarInit = true;

  const EDGE_TRIGGER_PX = 16;
  const HIDE_DELAY_MS = 220;
  const SAFE_ICON_CACHE = new Map();

  let sidebarVisible = false;
  let hideTimer = null;
  let previewItem = null;

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
    <div class="tab-sidebar-header">
      <span>Вкладки окна</span>
      <button type="button" class="sidebar-refresh" title="Обновить список вкладок">Обновить</button>
    </div>
    <div class="tabs-list" role="list"></div>
    <div class="tab-sidebar-empty">Нет доступных вкладок</div>
    <div class="tab-preview" aria-hidden="true"></div>
  `;
  document.documentElement.appendChild(sidebar);

  const refreshButton = sidebar.querySelector(".sidebar-refresh");
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
  };

  const requestTabs = async () => {
    const response = await safeSendMessage({ type: "getTabs" });
    if (!response?.success) {
      console.warn("Не удалось получить вкладки:", response?.error);
      renderTabs([]);
      return;
    }
    renderTabs(response.tabs || []);
  };

  const buildFallbackIcon = (title) => {
    const fallback = document.createElement("span");
    fallback.className = "tab-icon fallback";
    const symbol = (title || "•").trim().charAt(0).toUpperCase() || "•";
    fallback.textContent = symbol;
    return fallback;
  };

  const buildIconNode = (tab) => {
    if (!tab.favIconUrl) {
      return buildFallbackIcon(tab.title);
    }

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

  const renderTabs = (tabs) => {
    list.innerHTML = "";
    if (!tabs.length) {
      emptyState.style.display = "flex";
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

      const main = document.createElement("div");
      main.className = "tab-main";

      const iconNode = buildIconNode(tab);

      const textWrap = document.createElement("div");
      textWrap.className = "tab-text";

      const title = document.createElement("div");
      title.className = "tab-title";
      title.textContent = tab.title || "Без названия";

      const url = document.createElement("div");
      url.className = "tab-url";
      url.textContent = tab.url || "";

      textWrap.append(title, url);
      main.append(iconNode, textWrap);

      const actions = document.createElement("div");
      actions.className = "tab-actions";

      const activateBtn = document.createElement("button");
      activateBtn.type = "button";
      activateBtn.className = "tab-action";
      activateBtn.dataset.action = "activate";
      activateBtn.textContent = "Перейти";

      const reloadBtn = document.createElement("button");
      reloadBtn.type = "button";
      reloadBtn.className = "tab-action";
      reloadBtn.dataset.action = "reload";
      reloadBtn.textContent = "Обновить";

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "tab-action danger";
      closeBtn.dataset.action = "close";
      closeBtn.textContent = "Закрыть";

      actions.append(activateBtn, reloadBtn, closeBtn);
      item.append(main, actions);
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
    if (action === "activate") hideSidebar(true);
    requestTabs();
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

  refreshButton.addEventListener("click", () => {
    requestTabs();
  });

  list.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const item = button.closest(".tab-item");
    if (!item) return;
    const tabId = Number(item.dataset.tabId);
    if (!tabId) return;
    handleAction(button.dataset.action, tabId);
  });

  list.addEventListener(
    "mousemove",
    (event) => {
      const item = event.target.closest(".tab-item");
      if (!item) {
        hidePreview();
        return;
      }

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
      const offsetY = Math.min(sidebarRect.height - 96, Math.max(16, event.clientY - sidebarRect.top - 20));

      preview.style.top = `${offsetY}px`;
      preview.classList.add("visible");
    },
    { passive: true },
  );

  list.addEventListener("mouseleave", () => hidePreview());
})();
