(function(){
  const API = window.location.origin;

  function authHeaders(headers){
    const token = window.AppAuth ? window.AppAuth.getToken() : localStorage.getItem("token");
    return {
      ...(headers || {}),
      ...(token ? { Authorization: "Bearer " + token } : {})
    };
  }

  function handleUnauthorized(){
    if(window.AppAuth){
      window.AppAuth.clearSession();
      window.AppAuth.redirectToLogin();
    } else {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.top.location.href = "/login.html";
    }
  }

  function handleForbidden(){
    if(window.AppUI && window.AppUI.showForbidden){
      window.AppUI.showForbidden("You do not have permission to access this area.");
    } else if(window.AppUI && window.AppUI.showToast){
      window.AppUI.showToast("You do not have permission to access this area.", "error");
    }
  }

  async function apiFetch(url, options = {}){
    const res = await fetch(url, {
      ...options,
      headers: authHeaders(options.headers)
    });

    if(res.status === 403){
      handleForbidden();
    }

    if(res.status === 401){
      handleUnauthorized();
      throw new Error("Unauthorized");
    }

    return res;
  }

  async function safeFetch(url, options = {}){
    const res = await apiFetch(url, options);
    const data = await res.json();
    if(!res.ok){
      throw new Error(data.error || "Request failed");
    }
    return data;
  }

  async function getBillingMe(){
    return safeFetch(API + "/billing/me");
  }

  async function createStripeCheckoutSession(plan, options = {}){
    return safeFetch(API + "/billing/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, ...options })
    });
  }

  async function createBillingCheckoutSession(plan, options = {}){
    return safeFetch(API + "/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, ...options })
    });
  }

  async function createStripePortalSession(){
    return safeFetch(API + "/billing/create-portal-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  }

  async function createBillingPortalSession(){
    return safeFetch(API + "/billing/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  }

  async function createBillingRecoverySession(){
    return safeFetch(API + "/billing/recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  }

  async function changeBillingPlan(plan, options = {}){
    return safeFetch(API + "/billing/change-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, ...options })
    });
  }

  async function subscribeCompany(plan, options = {}){
    return safeFetch(API + "/billing/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...options, plan })
    });
  }

  async function upgradeCompanyPlan(plan){
    return safeFetch(API + "/billing/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan })
    });
  }

  async function downgradeCompanyPlan(plan){
    return safeFetch(API + "/billing/downgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan })
    });
  }

  async function cancelCompanySubscription(options = {}){
    return safeFetch(API + "/billing/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options)
    });
  }

  async function reactivateCompanySubscription(){
    return safeFetch(API + "/billing/reactivate", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  }

  async function getLegalConsent(){
    return safeFetch(API + "/auth/legal-consent");
  }

  async function acceptLegalConsent(){
    return safeFetch(API + "/auth/legal-consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted: true })
    });
  }

  async function getInvoiceIntegrity(invoiceId){
    return safeFetch(API + "/workflow/invoices/" + encodeURIComponent(invoiceId) + "/integrity");
  }

  async function getInvoiceLedger(invoiceId){
    return safeFetch(API + "/workflow/invoices/" + encodeURIComponent(invoiceId) + "/ledger");
  }

  async function recordInvoicePaymentRefund(invoiceId, paymentId, body){
    return safeFetch(API + "/workflow/invoices/" + encodeURIComponent(invoiceId) + "/payments/" + encodeURIComponent(paymentId) + "/refunds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  async function getPlatformBillingAnalytics(){
    return safeFetch(API + "/platform/billing/analytics");
  }

  async function platformSuspendCompany(companyId, body){
    return safeFetch(API + "/platform/companies/" + encodeURIComponent(companyId) + "/suspend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  async function platformUnsuspendCompany(companyId){
    return safeFetch(API + "/platform/companies/" + encodeURIComponent(companyId) + "/unsuspend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
  }

  async function platformBillingCompanyOverride(companyId, patch){
    return safeFetch(API + "/platform/billing/companies/" + encodeURIComponent(companyId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch || {})
    });
  }

  async function getNotifications(){
    return safeFetch(API + "/notifications");
  }

  async function getNotificationsUnreadCount(){
    return safeFetch(API + "/notifications/unread-count");
  }

  async function markAllNotificationsRead(){
    return safeFetch(API + "/notifications/read-all", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
  }

  async function sendInvoiceSentEmail(invoiceId, body){
    return safeFetch(API + "/workflow/invoices/" + encodeURIComponent(invoiceId) + "/send-invoice-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  async function sendPaymentReminderEmail(invoiceId, body){
    return safeFetch(API + "/workflow/invoices/" + encodeURIComponent(invoiceId) + "/send-payment-reminder-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  async function sendSubscriptionReminderEmail(subscriptionId, body){
    return safeFetch(API + "/ops/subscriptions/" + encodeURIComponent(subscriptionId) + "/send-reminder-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  window.API = window.API || API;
  window.AppAPI = {
    base: API,
    authHeaders,
    fetch: apiFetch,
    safeFetch,
    handleForbidden,
    handleUnauthorized,
    getBillingMe,
    createStripeCheckoutSession,
    createBillingCheckoutSession,
    createStripePortalSession,
    createBillingPortalSession,
    createBillingRecoverySession,
    changeBillingPlan,
    subscribeCompany,
    upgradeCompanyPlan,
    downgradeCompanyPlan,
    cancelCompanySubscription,
    reactivateCompanySubscription,
    getLegalConsent,
    acceptLegalConsent,
    getInvoiceIntegrity,
    getInvoiceLedger,
    recordInvoicePaymentRefund,
    getPlatformBillingAnalytics,
    platformSuspendCompany,
    platformUnsuspendCompany,
    platformBillingCompanyOverride,
    getNotifications,
    getNotificationsUnreadCount,
    markAllNotificationsRead,
    sendInvoiceSentEmail,
    sendPaymentReminderEmail,
    sendSubscriptionReminderEmail
  };

})();
