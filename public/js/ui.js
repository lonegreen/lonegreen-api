(function () {
  const emptyStateActions = new Map();

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function safeText(value, fallback) {
    if (value === null || value === undefined || value === "") return fallback || "";
    return String(value);
  }

  function ensureShell() {
    if (document.querySelector(".page-status")) return;

    const status = document.createElement("div");
    status.className = "page-status";
    status.innerHTML = '<div class="toast-stack" id="pageToastStack"></div>';
    document.body.prepend(status);

    document.body.classList.add("page-shell");
  }

  function showToast(message, type) {
    ensureShell();

    const stack = document.getElementById("pageToastStack");
    if (!stack) return;

    const toast = document.createElement("div");
    toast.className = "page-toast " + (type || "info");
    toast.textContent = message || "Done";

    stack.appendChild(toast);

    window.setTimeout(() => {
      toast.remove();
    }, 3400);
  }

  // Disabled full-screen loading overlay.
  // Pages should stay visible and load data inside cards/sections instead.
  function setLoading() {
    return;
  }

  async function withButton(button, action, labels) {
    if (button) {
      button.disabled = true;

      if (labels && labels.loading) {
        button.dataset.originalLabel = button.textContent;
        button.textContent = labels.loading;
      }
    }

    try {
      return await action();
    } finally {
      if (button) {
        button.disabled = false;

        if (button.dataset.originalLabel) {
          button.textContent = button.dataset.originalLabel;
          delete button.dataset.originalLabel;
        }
      }
    }
  }

  function emptyState(title, message, actions) {
    const stateId = "es-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const safeActions = Array.isArray(actions)
      ? actions.filter(function (action) {
        return action && typeof action.onClick === "function";
      }).map(function (action) {
        return {
          label: safeText(action.label, "Open"),
          className: safeText(action.className, "btn primary"),
          onClick: action.onClick
        };
      })
      : [];

    if (safeActions.length) {
      emptyStateActions.set(stateId, safeActions);
      window.setTimeout(function () {
        const host = document.querySelector('[data-empty-state-id="' + stateId + '"] [data-empty-state-actions]');
        const scopedActions = emptyStateActions.get(stateId) || [];
        if (!host || !scopedActions.length) {
          emptyStateActions.delete(stateId);
          return;
        }
        scopedActions.forEach(function (action) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = action.className;
          button.textContent = action.label;
          button.addEventListener("click", function (event) {
            action.onClick(event);
          });
          host.appendChild(button);
        });
        emptyStateActions.delete(stateId);
      }, 0);
    }

    return (
      '<div class="page-empty" data-empty-state-id="' + stateId + '">' +
      "<h3>" +
      escapeHTML(safeText(title, "")) +
      "</h3>" +
      "<p>" +
      escapeHTML(safeText(message, "")) +
      "</p>" +
      (safeActions.length ? '<div class="page-empty-actions" data-empty-state-actions></div>' : "") +
      "</div>"
    );
  }

  function showForbidden(message) {
    showToast(message || "You do not have permission to access this page.", "error");

    const fallback = document.querySelector("[data-forbidden-message]");
    if (fallback) {
      fallback.textContent = message || "You do not have permission to access this page.";
    }
  }

  window.AppUI = {
    init: ensureShell,
    showToast,
    showForbidden,
    setLoading,
    withButton,
    emptyState,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureShell);
  } else {
    ensureShell();
  }
})();