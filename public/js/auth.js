(function () {
  const VALID_ROLES = ["platform_owner", "owner", "admin", "manager", "worker"];

  function getToken() {
    return localStorage.getItem("token");
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem("user") || "null");
    } catch (err) {
      return null;
    }
  }

  function normalizeRole(role) {
    const value = String(role || "").trim().toLowerCase();
    return VALID_ROLES.includes(value) ? value : null;
  }

  function getRole() {
    const user = getUser();
    return normalizeRole(user && user.role);
  }

  function clearSession() {
    localStorage.removeItem("token");
    localStorage.removeItem("customerToken");
    localStorage.removeItem("user");
    localStorage.removeItem("currentPage");
  }

  function redirectToLogin() {
    window.top.location.href = "/login.html";
  }

  function redirectToHome() {
    window.top.location.href = "/";
  }

  function redirectAfterLogin(user) {
    const role = normalizeRole(user && user.role);
    localStorage.removeItem("currentPage");

    if (role === "worker") {
      localStorage.setItem("currentPage", "worker.html");
      window.location.href = "/control.html";
      return;
    }

    if (role === "platform_owner") {
      localStorage.setItem("currentPage", "platform.html#overview");
      window.location.href = "/control.html";
      return;
    }

    localStorage.setItem("currentPage", "dashboard.html");
    window.location.href = "/control.html";
  }

  function requireAuth() {
    const token = getToken();
    const user = getUser();
    const role = normalizeRole(user && user.role);

    if (!token || !user || !role) {
      clearSession();
      redirectToLogin();
      return false;
    }

    return true;
  }

  function isWorker() {
    return getRole() === "worker";
  }

  function isManagerOrAbove() {
    const role = getRole();
    return ["manager", "admin", "owner"].includes(role);
  }

  function isAdminOrOwner() {
    const role = getRole();
    return ["admin", "owner"].includes(role);
  }

  window.AppAuth = {
    getToken,
    getUser,
    getRole,
    normalizeRole,
    clearSession,
    redirectToLogin,
    redirectToHome,
    redirectAfterLogin,
    requireAuth,
    isWorker,
    isManagerOrAbove,
    isAdminOrOwner
  };
})();
