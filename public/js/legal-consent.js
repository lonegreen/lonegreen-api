(function () {
  const API = window.location.origin;

  function getToken() {
    return localStorage.getItem("token");
  }

  function isLegalPage() {
    return /\/(terms|privacy|billing-policy|refund-policy|company-ownership|cookie-policy|data-processing)\.html$/i
      .test(window.location.pathname);
  }

  function injectStyles() {
    if (document.getElementById("legalConsentStyles")) return;

    const style = document.createElement("style");
    style.id = "legalConsentStyles";
    style.textContent = `
      .legal-consent-banner {
        position: fixed;
        left: 16px;
        right: 16px;
        bottom: 16px;
        z-index: 9999;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        padding: 14px 16px;
        border: 1px solid #d0dfd5;
        border-radius: 16px;
        background: #ffffff;
        color: #173327;
        box-shadow: 0 18px 42px rgba(16, 24, 40, 0.16);
        font-family: Arial, sans-serif;
      }
      .legal-consent-banner strong { display:block; margin-bottom:4px; color:#1f5c3a; }
      .legal-consent-banner span { color:#52675d; line-height:1.45; font-size:13px; }
      .legal-consent-banner a { color:#1f5c3a; font-weight:800; }
      .legal-consent-actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; }
      .legal-consent-actions button {
        border:0;
        border-radius:12px;
        padding:10px 12px;
        background:#1f5c3a;
        color:white;
        font-weight:800;
        cursor:pointer;
      }
      .legal-consent-actions button.secondary {
        background:#edf6f0;
        color:#1f5c3a;
        border:1px solid #d0dfd5;
      }
      @media (max-width: 720px) {
        .legal-consent-banner { grid-template-columns:1fr; }
        .legal-consent-actions { justify-content:flex-start; }
      }
    `;
    document.head.appendChild(style);
  }

  async function requestConsentStatus() {
    const token = getToken();
    if (!token) return null;

    const res = await fetch(API + "/auth/legal-consent", {
      headers: { Authorization: "Bearer " + token }
    });

    if (!res.ok) return null;
    return res.json();
  }

  async function acceptConsent(button) {
    const token = getToken();
    if (!token) return;

    if (button) {
      button.disabled = true;
      button.textContent = "Saving...";
    }

    const res = await fetch(API + "/auth/legal-consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token
      },
      body: JSON.stringify({ accepted: true })
    });

    if (!res.ok) {
      if (button) {
        button.disabled = false;
        button.textContent = "Accept";
      }
      return;
    }

    const banner = document.getElementById("legalConsentBanner");
    if (banner) banner.remove();
  }

  function showBanner(status) {
    if (!status || status.accepted || document.getElementById("legalConsentBanner") || isLegalPage()) {
      return;
    }

    injectStyles();

    const banner = document.createElement("div");
    banner.id = "legalConsentBanner";
    banner.className = "legal-consent-banner";
    banner.innerHTML = `
      <div>
        <strong>Legal terms updated</strong>
        <span>
          Please review and accept the current
          <a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a>
          and
          <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.
          You can keep using admin pages while you review.
        </span>
      </div>
      <div class="legal-consent-actions">
        <button class="secondary" type="button" onclick="window.open('/terms.html', '_blank', 'noopener')">Review</button>
        <button id="legalConsentAcceptBtn" type="button">Accept</button>
      </div>
    `;

    document.body.appendChild(banner);
    const acceptButton = document.getElementById("legalConsentAcceptBtn");
    if (acceptButton) {
      acceptButton.addEventListener("click", () => acceptConsent(acceptButton));
    }
  }

  async function init() {
    try {
      const status = await requestConsentStatus();
      showBanner(status);
    } catch (err) {
      console.warn("LEGAL CONSENT CHECK FAILED:", err && err.message);
    }
  }

  window.AppLegalConsent = {
    init,
    acceptConsent,
    requestConsentStatus
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
