// Agent Home — OAuth token-exchange worker (Cloudflare Workers, free tier is plenty).
//
// Why this exists: an OAuth client SECRET cannot live in a public web page.
// This tiny worker is the only server piece in the whole product. It holds the
// two client secrets as environment variables, exchanges one-time auth codes
// for access tokens, and returns the token to the user's own browser.
// The exchange itself stores NOTHING: no tokens, no codes. Stateless by design.
// One exception, and only when the operator binds the optional SETUPS KV
// namespace: an opt-in registry of finished setups (name + GitHub login +
// repo link only — never a token or secret), sent by the setup page only
// when the user ticks "let the person who shared this know I'm set up".
// Without the KV binding, the registry endpoints return 501 — never a
// fake success.
//
// Deploy: see README.md in this folder (about 10 minutes, $0).
//
// Env vars (set as Worker secrets, never in code):
//   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
//   SUPABASE_CLIENT_ID, SUPABASE_CLIENT_SECRET   (optional until Supabase OAuth is registered)
//   ALLOWED_ORIGIN   e.g. https://your-setup-page.example  (the page's origin; CORS lock)
//   ADMIN_GITHUB_LOGIN   GitHub username allowed to read GET /admin (plain var)
//   ADMIN_LINK_KEY   long random secret; GET /admin?key=<this> is the owner's
//                    custom admin link — the link itself IS the credential
// KV bindings (optional):
//   SETUPS   registry of opt-in setups, one entry per GitHub login

// Constant-time-ish string comparison: bail on length mismatch, then
// XOR-accumulate every byte so the loop doesn't exit at the first wrong
// character. Good enough for a single-operator admin link (this is not a
// substitute for a real auth system — it just avoids an obvious timing tell).
function secretEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const PROVIDERS = {
  github: {
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId: (env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
  },
  supabase: {
    // Supabase OAuth 2.0 (platform/integration) token endpoint.
    tokenUrl: "https://api.supabase.com/v1/oauth/token",
    clientId: (env) => env.SUPABASE_CLIENT_ID,
    clientSecret: (env) => env.SUPABASE_CLIENT_SECRET,
  },
};

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    // Public config: client IDs are not secrets — the page fetches them from here
    // so the operator configures everything in exactly one place.
    if (url.pathname === "/config" && request.method === "GET") {
      return json({
        github_client_id: env.GITHUB_CLIENT_ID || null,
        supabase_client_id: env.SUPABASE_CLIENT_ID || null,
      });
    }

    if (url.pathname === "/exchange" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const p = PROVIDERS[body.provider];
      if (!p) return json({ error: "unknown_provider" }, 400);
      if (!body.code || typeof body.code !== "string") return json({ error: "missing_code" }, 400);
      const clientId = p.clientId(env), clientSecret = p.clientSecret(env);
      if (!clientId || !clientSecret) return json({ error: "provider_not_configured" }, 501);

      const form = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: body.code,
        grant_type: "authorization_code",
        ...(body.redirect_uri ? { redirect_uri: body.redirect_uri } : {}),
      });
      const resp = await fetch(p.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.access_token) {
        // Pass through the provider's own error — no silent failures.
        return json({ error: data.error || "exchange_failed", detail: data.error_description || null }, 502);
      }
      // Return ONLY what the page needs. Refresh token, if any, goes to the user's
      // browser too — this worker keeps nothing.
      return json({ access_token: data.access_token, token_type: data.token_type || "bearer",
                    scope: data.scope || null, refresh_token: data.refresh_token || null });
    }

    // Opt-in setup registry. The setup page POSTs here ONLY when the user
    // ticks "let the person who shared this know I'm set up". The entry is
    // public-by-design data (name + repo link) — no tokens, no secrets.
    // AUTHENTICATED: the caller must send the registering user's OWN GitHub
    // access token (the page already holds it in memory from their setup),
    // and it is verified live against GitHub — the token's login must match
    // the body's github_login, so nobody can register or overwrite an entry
    // for someone else's account. The timestamp is set HERE, never trusted
    // from the request (a client-sent future ts would pin a fake entry at
    // the top of the admin list).
    if (url.pathname === "/register" && request.method === "POST") {
      if (!env.SETUPS) return json({ error: "registry_not_configured" }, 501);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      if (!body.github_login || typeof body.github_login !== "string") {
        return json({ error: "missing_github_login" }, 400);
      }
      const login = body.github_login.trim().toLowerCase();
      if (!login) return json({ error: "missing_github_login" }, 400);
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!token) return json({ error: "missing_token" }, 401);
      const meResp = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "agent-home-oauth-worker",
        },
      });
      if (!meResp.ok) return json({ error: "invalid_token" }, 401);
      const me = await meResp.json().catch(() => ({}));
      if (!me.login || String(me.login).toLowerCase() !== login) {
        return json({ error: "login_mismatch", detail: "That GitHub token belongs to a different account than the one being registered." }, 403);
      }
      const entry = {
        name: typeof body.name === "string" ? body.name : "",
        github_login: login,
        repo_url: typeof body.repo_url === "string" ? body.repo_url : "",
        has_db: body.has_db === true,
        verified_count: Number.isFinite(body.verified_count) ? Math.trunc(body.verified_count) : 0,
        ts: Date.now(),
      };
      // One entry per GitHub login — re-registering overwrites the old entry.
      await env.SETUPS.put(login, JSON.stringify(entry));
      return json({ ok: true, github_login: login });
    }

    // Admin view: the sharer's own list of who's set up. Two credentials:
    // (a) a GitHub access token that must belong to ADMIN_GITHUB_LOGIN —
    //     verified live against GitHub, never trusted from the request body;
    // (b) the owner's custom admin link: ?key=<ADMIN_LINK_KEY>, a long random
    //     secret. The link IS the credential (see README §4 warning).
    // A correct key skips the token check; a wrong/absent key falls through
    // to the token path, whose 401/403 behavior is unchanged.
    if (url.pathname === "/admin" && request.method === "GET") {
      if (!env.SETUPS) return json({ error: "registry_not_configured" }, 501);
      const keyParam = url.searchParams.get("key");
      const keyOk = !!env.ADMIN_LINK_KEY && keyParam !== null && secretEquals(keyParam, env.ADMIN_LINK_KEY);
      if (!keyOk) {
        const auth = request.headers.get("Authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (!token) return json({ error: "missing_token" }, 401);
        const meResp = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "agent-home-oauth-worker",
          },
        });
        if (!meResp.ok) return json({ error: "invalid_token" }, 401);
        const me = await meResp.json().catch(() => ({}));
        const adminLogin = (env.ADMIN_GITHUB_LOGIN || "").trim().toLowerCase();
        if (!adminLogin || !me.login || String(me.login).toLowerCase() !== adminLogin) {
          return json({ error: "not_admin", detail: "This GitHub account is not the registered admin for this setup service." }, 403);
        }
      }
      const entries = [];
      let cursor;
      do {
        const page = await env.SETUPS.list(cursor ? { cursor } : {});
        for (const key of page.keys) {
          const raw = await env.SETUPS.get(key.name);
          if (!raw) continue;
          try { entries.push(JSON.parse(raw)); } catch { /* skip a corrupt entry rather than fail the whole list */ }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      const tsValue = (e) => {
        const n = typeof e.ts === "number" ? e.ts : Date.parse(e.ts);
        return Number.isFinite(n) ? n : 0;
      };
      entries.sort((a, b) => tsValue(b) - tsValue(a));
      return json({ setups: entries });
    }

    return json({ error: "not_found" }, 404);
  },
};
