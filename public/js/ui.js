(function () {
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
    const buttons = Array.isArray(actions)
      ? actions
          .map((action) => {
            const label = action && action.label ? action.label : "Open";
            const onClick = action && action.onClick ? action.onClick : "";
            const className = action && action.className ? action.className : "btn primary";

            return (
              '<button class="' +
              className +
              '" onclick="' +
              onClick +
              '">' +
              label +
              "</button>"
            );
          })
          .join("")
      : "";

    return (
      '<div class="page-empty">' +
      "<h3>" +
      title +
      "</h3>" +
      "<p>" +
      message +
      "</p>" +
      (buttons ? '<div class="page-empty-actions">' + buttons + "</div>" : "") +
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