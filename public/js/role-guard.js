(function () {
  const ADMIN_AND_ABOVE_PAGES = [
    "billing-plans.html",
    "company-public-profile.html",
    "company-service-areas.html",
    "company-services.html",
    "settings.html",
    "users.html",
    "zip-manager.html"
  ];

  const MANAGER_AND_ABOVE_PAGES = [
    "dashboard.html",
    "marketplace-dashboard.html",
    "marketplace-opportunities.html",
    "marketplace-offers.html",
    "messages.html",
    "clients.html",
    "client.html",
    "estimates.html",
    "jobs.html",
    "calendar.html",
    "invoices.html",
    "invoice.html",
    "subscriptions.html",
    "workers.html",
    "analytics.html",
    "support.html"
  ];

  const PLATFORM_OWNER_PAGES = [
    "admin-marketplace.html",
    "health.html",
    "marketplace-analytics.html",
    "platform.html",
    "support.html"
  ];

  const VALID_ROLES = [
    "platform_owner",
    "owner",
    "admin",
    "manager",
    "worker"
  ];

  function getUser() {
    try {
      return JSON.parse(
        localStorage.getItem("user") || "null"
      );
    } catch {
      return null;
    }
  }

  function normalizeRole(role) {
    const normalized = String(role || "")
      .trim()
      .toLowerCase();

    return VALID_ROLES.includes(normalized)
      ? normalized
      : null;
  }

  function redirectLogin() {
    console.warn("ROLE_GUARD_REDIRECT_LOGIN", {
      page: window.location.pathname
    });
    window.top.location.href = "/login.html";
  }

  function hardDeny(reason) {
    try {
      if (window.top && window.top !== window && window.top.location && window.top.location.origin === window.location.origin) {
        window.top.location.href = "/control.html";
      }
    } catch (_) {}
    try {
      document.documentElement.innerHTML = "<body><h1 style='font-family:Arial,sans-serif;padding:24px;'>Access denied</h1></body>";
    } catch (_) {}
    throw new Error(reason || "Access denied");
  }

  function redirectSafe(role) {
    if (role === "worker") {
      console.warn("ROLE_GUARD_REDIRECT_WORKER", {
        page: window.location.pathname
      });
      window.top.location.href = "/worker.html";
      return;
    }

    console.warn("ROLE_GUARD_REDIRECT_CONTROL", {
      role,
      page: window.location.pathname
    });
    window.top.location.href = "/control.html";
  }

  function hasAccess(role, page) {
    if (!role) {
      return false;
    }

    if (role === "platform_owner") {
      return PLATFORM_OWNER_PAGES.includes(page);
    }

    if (role === "owner") {
      return true;
    }

    if (
      ADMIN_AND_ABOVE_PAGES.includes(page)
    ) {
      return role === "admin";
    }

    if (
      MANAGER_AND_ABOVE_PAGES.includes(page)
    ) {
      return [
        "manager",
        "admin"
      ].includes(role);
    }

    if (page === "worker.html") {
      return role === "worker";
    }

    return true;
  }

  const token = localStorage.getItem("token");
  const user = getUser();
  const role = normalizeRole(
    user && user.role
  );

  const page = window.location.pathname
    .split("/")
    .pop();

  if (!token || !user || !role) {
    localStorage.removeItem("token");
    localStorage.removeItem("customerToken");
    localStorage.removeItem("user");
    localStorage.removeItem("currentPage");
    redirectLogin();
    return;
  }

  if (!hasAccess(role, page)) {
    console.warn("ROLE_GUARD_ACCESS_DENIED", {
      role,
      page
    });
    if (window === window.top) {
      redirectSafe(role);
      return;
    }
    hardDeny("Unauthorized page access");
  }
})();
