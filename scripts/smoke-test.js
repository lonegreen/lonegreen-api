#!/usr/bin/env node
/**
 * Lightweight HTTP smoke checks for local/staging.
 * No paid external services. Uses optional credentials from env only.
 *
 * Env:
 *   SMOKE_BASE_URL     — default http://127.0.0.1:4000
 *   SMOKE_USERNAME     — optional, staff login username for /auth/login
 *   SMOKE_PASSWORD     — optional, staff login password
 */
"use strict";

const baseUrl = String(process.env.SMOKE_BASE_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
const smokeUser = String(process.env.SMOKE_USERNAME || "").trim();
const smokePass = String(process.env.SMOKE_PASSWORD || "").trim();

function fail(message) {
  console.error("SMOKE FAIL:", message);
  process.exit(1);
}

function ok(message) {
  console.log("SMOKE OK:", message);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _parseError: true, raw: text.slice(0, 500) };
  }
  return { res, body };
}

async function main() {
  console.log("Smoke test against", baseUrl);

  {
    const { res, body } = await fetchJson(`${baseUrl}/health`);
    if (!res.ok) {
      fail(`/health returned ${res.status}`);
    }
    if (!body || typeof body !== "object") {
      fail("/health response is not JSON object");
    }
    if (!("ok" in body)) {
      fail("/health JSON missing `ok` field");
    }
    if (body.database && body.database.status !== "ok") {
      fail(`/health database.status expected ok, got ${body.database.status}`);
    }
    if (body.migrations && body.migrations.status !== "current") {
      fail(`/health migrations.status expected current, got ${body.migrations.status}`);
    }
    ok("/health returns JSON with ok field");
  }

  {
    const { res, body } = await fetchJson(`${baseUrl}/health/ready`);
    if (res.status === 404) {
      console.log("SMOKE SKIP: /health/ready is not available");
    } else {
      if (!res.ok) {
        fail(`/health/ready returned ${res.status}`);
      }
      if (!body || body.ok !== true) {
        fail("/health/ready should return JSON with ok=true");
      }
      if (body.database && body.database.status !== "ok") {
        fail(`/health/ready database.status expected ok, got ${body.database.status}`);
      }
      if (body.migrations && body.migrations.status !== "current") {
        fail(`/health/ready migrations.status expected current, got ${body.migrations.status}`);
      }
      ok("/health/ready confirms DB and migration readiness");
    }
  }

  {
    const { res, body } = await fetchJson(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (res.status !== 400) {
      fail(`POST /auth/login with empty body should be 400, got ${res.status}`);
    }
    if (!body || typeof body.error !== "string") {
      fail("POST /auth/login (empty body) should return JSON with error string");
    }
    ok("POST /auth/login rejects missing credentials with expected shape");
  }

  if (!smokeUser || !smokePass) {
    console.log("SMOKE SKIP: billing probe (set SMOKE_USERNAME and SMOKE_PASSWORD to test /billing/me)");
  } else {
    const { res, body } = await fetchJson(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: smokeUser,
        password: smokePass
      })
    });

    if (res.status !== 200 || !body || typeof body.token !== "string" || !body.user) {
      fail(
        `Login failed or unexpected shape (HTTP ${res.status}). Check SMOKE_USERNAME / SMOKE_PASSWORD.`
      );
    }

    const me = await fetchJson(`${baseUrl}/billing/me`, {
      headers: { Authorization: `Bearer ${body.token}` }
    });

    if (me.res.status === 401) {
      fail("/billing/me returned 401 after login — token rejected");
    }

    if (me.res.status !== 200 || !me.body || typeof me.body !== "object") {
      fail(`/billing/me unexpected response (HTTP ${me.res.status})`);
    }

    ok("/billing/me responds when authenticated (billing readiness probe)");
  }

  console.log("All smoke checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
