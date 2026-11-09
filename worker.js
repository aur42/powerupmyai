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
// Invite gate (2026-11-09): the same SETUPS namespace also carries the
// invite ledger — single-use codes (invite:<CODE>), per-user ledgers
// (invledger:<login>) and exchange bindings (invbind:<login>) — when the
// operator turns the gate on with INVITES_REQUIRED. Codes, logins and
// timestamps only: the statelessness doctrine bends for the ledger exactly
// as it already did for the registry, and never for tokens or secrets.
// With the flag off (the default), every route behaves as it always has.
//
// SOURCE NOTE (2026-11-09 reconciliation): this file is the union of the
// deployed PowerUpMyAI worker (Supabase Basic auth, EXPECTED_REDIRECT_URI
// discipline, /report, /admin/img, repo-URL validation) and the template
// copy, which had fallen behind it. There is now ONE worker source; the
// template folder and the Pages repo carry the same file.
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
//   INVITES_REQUIRED   "true" turns the invite gate on at /exchange (default off)
//   INVITES_BALANCE    codes each completed user receives (default 5)
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
    // Supabase requires HTTP Basic client authentication (client id + secret
    // in the Authorization header), NOT credentials in the form body.
    tokenUrl: "https://api.supabase.com/v1/oauth/token",
    clientId: (env) => env.SUPABASE_CLIENT_ID,
    clientSecret: (env) => env.SUPABASE_CLIENT_SECRET,
    basicAuth: true,
  },
};

// ---------------- Invite gate ----------------
// Codes are bearer invitations, not credentials: PUMA- plus 6 characters
// from a no-lookalike alphabet (no 0/O/1/I/L), typeable and read-aloud-able.
// A code is spent only when the invited person's setup COMPLETES at
// /register; at /exchange it is merely bound, tentatively, to the verified
// GitHub login that presented it — an abandoned setup spends nothing.
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_TIER_TABLE = [
  { at: 1, name: "First door opened" },
  { at: 5, name: "Founding recruiter" },
  { at: 10, name: "Connector" },
  { at: 25, name: "Pillar" },
];

function inviteTierName(points) {
  let name = null;
  for (const row of INVITE_TIER_TABLE) if (points >= row.at) name = row.name;
  return name;
}
function inviteNextTierAt(points) {
  for (const row of INVITE_TIER_TABLE) if (points < row.at) return row.at;
  return null;
}
function invitesConfig(env) {
  const b = parseInt(env.INVITES_BALANCE, 10);
  return { required: env.INVITES_REQUIRED === "true", balance: Number.isFinite(b) && b > 0 ? b : 5 };
}
function normInviteCode(v) {
  return typeof v === "string" ? v.trim().toUpperCase() : "";
}
function firstNameOf(name) {
  if (typeof name !== "string") return null;
  const t = name.trim().split(/\s+/)[0];
  return t || null;
}
// Verifies a GitHub access token live and returns its login (lowercased),
// or null. The same pattern /register and /admin have always used.
async function verifyGitHubToken(token) {
  const meResp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "agent-home-oauth-worker",
    },
  });
  if (!meResp.ok) return null;
  const me = await meResp.json().catch(() => ({}));
  return me.login ? String(me.login).toLowerCase() : null;
}
async function genInviteCode(kv) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const buf = new Uint8Array(6);
    crypto.getRandomValues(buf);
    let s = "";
    for (const byte of buf) s += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
    const code = "PUMA-" + s;
    if (!(await kv.get("invite:" + code))) return code;
  }
  throw new Error("invite_code_gen_failed");
}
function newInviteLedger(login, name) {
  return {
    login, name: typeof name === "string" ? name : "",
    issued: [], balance: 0, cap: 0,
    redeemedCount: 0, points: 0,
    foundingRecruiter: false, prizeGranted: false, cycles: 0,
    updatedAt: 0,
  };
}
async function getInviteLedger(kv, login) {
  const raw = await kv.get("invledger:" + login);
  if (!raw) return null;
  try {
    const l = JSON.parse(raw);
    if (l && typeof l === "object" && Array.isArray(l.issued)) return l;
  } catch { /* corrupt ledger reads as absent rather than crashing the gate */ }
  return null;
}
async function putInviteLedger(kv, ledger) {
  ledger.updatedAt = Date.now();
  await kv.put("invledger:" + ledger.login, JSON.stringify(ledger));
}
async function getInviteRecord(kv, code) {
  const raw = await kv.get("invite:" + code);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    if (r && typeof r === "object") return r;
  } catch { /* corrupt code record reads as unknown */ }
  return null;
}
// Creates n fresh code records owned by the ledger's user and credits them
// to the ledger (issued list + balance). Caller saves the ledger.
async function issueInvites(kv, ledger, n, opts = {}) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const code = await genInviteCode(kv);
    const rec = {
      code, issuerLogin: ledger.login, issuerName: ledger.name || null,
      status: "issued",
      forName: typeof opts.forName === "string" ? opts.forName : "",
      lang: typeof opts.lang === "string" ? opts.lang : "",
      batch: typeof opts.batch === "string" ? opts.batch : "",
      createdAt: Date.now(), expiresAt: null,
      boundTo: null, boundAt: null,
      redeemedByLogin: null, redeemedAt: null,
      conflict: null,
    };
    await kv.put("invite:" + code, JSON.stringify(rec));
    ledger.issued.push(code);
    ledger.balance += 1;
    codes.push(code);
  }
  return codes;
}
async function listAllKvKeys(kv, prefix) {
  const names = [];
  let cursor;
  do {
    const page = await kv.list(cursor ? { prefix, cursor } : { prefix });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}
// The /invite/mine shape — also embedded in the /register response.
async function inviteMinePayload(kv, ledger) {
  const codes = [];
  for (const code of ledger.issued) {
    const rec = await getInviteRecord(kv, code);
    if (!rec) continue;
    codes.push({
      code: rec.code, status: rec.status,
      forName: rec.forName || "",
      redeemedByLogin: rec.redeemedByLogin || null,
      redeemedAt: rec.redeemedAt || null,
    });
  }
  // Standing: soft rank by points across all ledgers (ties share the better
  // rank — rank = 1 + the number of people strictly ahead). ofHomes is the
  // count of registered homes (setup entries) — the truer denominator:
  // "3rd of 12 homes", not "3rd of the 4 people who have points".
  let ahead = 0;
  for (const key of await listAllKvKeys(kv, "invledger:")) {
    if (key === "invledger:" + ledger.login) continue;
    const raw = await kv.get(key);
    if (!raw) continue;
    try {
      const other = JSON.parse(raw);
      if (other && typeof other.points === "number" && other.points > ledger.points) ahead++;
    } catch { /* skip corrupt ledgers */ }
  }
  let ofHomes = 0;
  for (const name of await listAllKvKeys(kv, "")) {
    if (name.includes(":")) continue; // setup entries live under the bare login
    const raw = await kv.get(name);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.github_login) ofHomes++;
    } catch { /* skip corrupt entries */ }
  }
  return {
    login: ledger.login,
    codes, balance: ledger.balance,
    points: ledger.points,
    tier: inviteTierName(ledger.points),
    nextTierAt: inviteNextTierAt(ledger.points),
    foundingRecruiter: ledger.foundingRecruiter === true,
    standing: { rank: ahead + 1, ofHomes },
  };
}
// A login the gate waves through: the operator, anyone with an exchange
// binding or a ledger, and anyone with a finished-setup registry entry
// (pre-gate users are grandfathered by their entry — never re-gated).
async function inviteKnownLogin(env, login) {
  const adminLogin = (env.ADMIN_GITHUB_LOGIN || "").trim().toLowerCase();
  if (adminLogin && login === adminLogin) return true;
  const kv = env.SETUPS;
  if (await kv.get("invbind:" + login)) return true;
  if (await kv.get("invledger:" + login)) return true;
  if (await kv.get(login)) return true;
  return false;
}
// The /exchange gate. Returns null when the exchange may proceed, or a
// refusal Response. The provider token has already been fetched at this
// point; on refusal it is simply never returned to the caller.
async function inviteGate(env, json, request, accessToken, body) {
  const kv = env.SETUPS;
  const login = await verifyGitHubToken(accessToken);
  if (!login) {
    return json({ error: "invalid_token", detail: "GitHub did not recognise the token from that sign-in. Please try connecting again." }, 401);
  }
  if (await inviteKnownLogin(env, login)) return null;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = "rl:invite:" + ip;
  const fails = parseInt((await kv.get(rlKey)) || "0", 10) || 0;
  if (fails >= 10) {
    return json({ error: "rate_limited", detail: "Too many invite attempts from this connection. Please wait an hour and try again." }, 429);
  }
  const fail = async (error, detail) => {
    await kv.put(rlKey, String(fails + 1), { expirationTtl: 3600 });
    return json({ error, detail }, 403);
  };
  const code = normInviteCode(body.invite_code);
  if (!code) {
    return fail("invite_required", "This beta is invite-only. Add the invite code from the person who sent you, then connect again.");
  }
  const rec = await getInviteRecord(kv, code);
  if (!rec || rec.status === "revoked" || (rec.expiresAt && rec.expiresAt < Date.now())) {
    return fail("invite_invalid", "That invite code doesn't work. Check it with the person who sent you.");
  }
  if (rec.status === "redeemed" && rec.redeemedByLogin !== login) {
    if (!rec.conflict) { rec.conflict = login; await kv.put("invite:" + code, JSON.stringify(rec)); }
    return fail("invite_spent", "That invite code has already been used. Ask the person who sent you to check their invites.");
  }
  if (rec.boundTo && rec.boundTo !== login) {
    if (!rec.conflict) { rec.conflict = login; await kv.put("invite:" + code, JSON.stringify(rec)); }
    return fail("invite_spent", "That invite code has already been used. Ask the person who sent you to check their invites.");
  }
  if (rec.status === "redeemed") return null; // their own code, re-presented mid-flow
  // Bind tentatively to this login. The code flips to "redeemed" only when
  // the setup completes at /register — an abandoned setup spends nothing.
  rec.boundTo = login;
  rec.boundAt = Date.now();
  await kv.put("invite:" + code, JSON.stringify(rec));
  await kv.put("invbind:" + login, JSON.stringify({
    code, issuerLogin: rec.issuerLogin, boundAt: rec.boundAt, completedAt: null,
  }));
  return null;
}
// Completion credit — runs inside /register when the gate flag is on.
// Idempotent: the binding's completedAt and the caller's own ledger are
// the two guards, so a repeated /register neither double-credits the
// issuer nor re-issues the caller's codes.
async function inviteCompletion(env, login, displayName) {
  const kv = env.SETUPS;
  const cfg = invitesConfig(env);
  const now = Date.now();
  const bindRaw = await kv.get("invbind:" + login);
  if (bindRaw) {
    let bind = null;
    try { bind = JSON.parse(bindRaw); } catch { bind = null; }
    if (bind && !bind.completedAt && bind.code) {
      const rec = await getInviteRecord(kv, bind.code);
      if (rec && rec.status !== "redeemed") {
        rec.status = "redeemed";
        rec.redeemedByLogin = login;
        rec.redeemedAt = now;
        await kv.put("invite:" + bind.code, JSON.stringify(rec));
        const issuer = rec.issuerLogin;
        if (issuer && issuer !== login) {
          let il = await getInviteLedger(kv, issuer);
          if (!il) {
            // Issuer has no ledger yet (their codes came from an admin
            // batch before they ever completed) — start one now.
            let issuerName = "";
            const entryRaw = await kv.get(issuer);
            if (entryRaw) {
              try {
                const e = JSON.parse(entryRaw);
                if (e && typeof e.name === "string") issuerName = e.name;
              } catch { /* name is decoration here */ }
            }
            il = newInviteLedger(issuer, issuerName);
            il.cap = cfg.balance;
          }
          il.redeemedCount += 1;
          // Points are stored explicitly (today: 1 per completed invite) so
          // a future weighting never rewrites history.
          il.points = il.redeemedCount;
          il.balance = Math.max(0, il.balance - 1);
          if (il.points >= cfg.balance && !il.prizeGranted) {
            // The prize: using every invite earns the next handful and the
            // founding-recruiter mark. Once per ledger — no code fountains.
            il.prizeGranted = true;
            il.foundingRecruiter = true;
            il.cycles += 1;
            il.cap = cfg.balance * 2;
            await issueInvites(kv, il, cfg.balance, { batch: "prize" });
          }
          await putInviteLedger(kv, il);
        }
      }
      bind.completedAt = now;
      await kv.put("invbind:" + login, JSON.stringify(bind));
    }
  }
  let ledger = await getInviteLedger(kv, login);
  if (!ledger) {
    ledger = newInviteLedger(login, displayName);
    ledger.cap = cfg.balance;
    await issueInvites(kv, ledger, cfg.balance, { batch: "starter" });
    await putInviteLedger(kv, ledger);
  }
  return inviteMinePayload(kv, ledger);
}

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
    const adminLogin = (env.ADMIN_GITHUB_LOGIN || "").trim().toLowerCase();

    // Public config: client IDs are not secrets — the page fetches them from here
    // so the operator configures everything in exactly one place. The invites
    // block lets the operator enable/tune the gate without a page release.
    if (url.pathname === "/config" && request.method === "GET") {
      return json({
        github_client_id: env.GITHUB_CLIENT_ID || null,
        supabase_client_id: env.SUPABASE_CLIENT_ID || null,
        invites: invitesConfig(env),
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

      // redirect_uri discipline: when EXPECTED_REDIRECT_URI is configured,
      // any redirect_uri the page sends must match it byte-for-byte. Supabase
      // requires the exact redirect_uri from its authorize step, so for
      // Supabase a missing one is an error, not an omission.
      if (env.EXPECTED_REDIRECT_URI && body.redirect_uri && body.redirect_uri !== env.EXPECTED_REDIRECT_URI) {
        return json({ error: "redirect_uri_mismatch" }, 400);
      }
      if (p.basicAuth && !body.redirect_uri) return json({ error: "missing_redirect_uri" }, 400);

      const form = new URLSearchParams({
        code: body.code,
        grant_type: "authorization_code",
        ...(body.redirect_uri ? { redirect_uri: body.redirect_uri } : {}),
      });
      const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
      if (p.basicAuth) {
        // Supabase: client credentials travel ONLY in the Basic header.
        headers.Authorization = "Basic " + btoa(clientId + ":" + clientSecret);
      } else {
        // GitHub: credentials in the form body, as GitHub expects.
        form.set("client_id", clientId);
        form.set("client_secret", clientSecret);
      }
      const resp = await fetch(p.tokenUrl, {
        method: "POST",
        headers,
        body: form,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.access_token) {
        // Pass through the provider's own error — no silent failures.
        return json({ error: data.error || "exchange_failed", detail: data.error_description || null }, 502);
      }
      // INVITE GATE — only when the operator has flipped INVITES_REQUIRED
      // on. With the flag off, nothing below runs and the response is
      // byte-identical to what this worker has always returned.
      if (invitesConfig(env).required) {
        if (!env.SETUPS) return json({ error: "registry_not_configured" }, 501);
        if (body.provider === "github") {
          // The gate bites here, at the front door: the token has been
          // fetched and its owner verified; on refusal the token is simply
          // never returned, so no capability is granted.
          const refusal = await inviteGate(env, json, request, data.access_token, body);
          if (refusal) return refusal;
        } else if (body.provider === "supabase" && typeof body.github_token === "string" && body.github_token) {
          // A Supabase exchange carries no GitHub identity of its own, so
          // it cannot be gated directly — the GitHub exchange always comes
          // first in the flow and is where the gate lives. If the page
          // sends its GitHub token along, verify the binding anyway.
          const ghLogin = await verifyGitHubToken(body.github_token);
          if (!ghLogin || !(await inviteKnownLogin(env, ghLogin))) {
            return json({ error: "invite_required", detail: "This beta is invite-only. Connect GitHub with a valid invite code first." }, 403);
          }
        }
      }
      // Return ONLY what the page needs. Refresh token, if any, goes to the user's
      // browser too — this worker keeps nothing.
      return json({ access_token: data.access_token, token_type: data.token_type || "bearer",
                    scope: data.scope || null, refresh_token: data.refresh_token || null });
    }

    // Problem reports from the page's failure screens. Sent only when the
    // user taps "send this report" — the payload is the same short diagnostic
    // summary the copy-button produces (step, error line, language, what was
    // already created). No auth exists at that point in the flow and none is
    // required: fields are length-capped, the timestamp is set here, and the
    // page's report builder includes no tokens or secrets by construction.
    // Stored under report:* keys so the admin list can separate them from
    // setup entries (GitHub logins never contain a colon).
    if (url.pathname === "/report" && request.method === "POST") {
      if (!env.SETUPS) return json({ error: "registry_not_configured" }, 501);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const clean = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
      const entry = {
        step: clean(body.step, 120),
        error: clean(body.error, 300),
        lang: clean(body.lang, 16),
        repo_created: body.repo_created === true,
        db_created: body.db_created === true,
        ts: Date.now(),
      };
      // Feedback payloads (kind: "feedback") may carry a longer note and
      // ONE downscaled screenshot. The image is stored raw under a paired
      // img:* key (same ts + suffix as the report key) so report listings
      // stay small; the admin view fetches it via /admin/img. An image
      // that fails validation is dropped silently — the text always lands.
      if (clean(body.kind, 16) === "feedback") {
        entry.kind = "feedback";
        entry.note = clean(body.note, 2000);
        const img = body.image;
        if (typeof img === "string" && img.startsWith("data:image/") && img.length <= 750000) {
          entry.has_image = true;
          entry._img = img;
        }
      }
      // Abuse shaping (added after the operator flagged that anonymous
      // reports had neither a rate limit nor a retention limit): at most
      // 10 reports per IP per hour, and only the newest 100 reports are
      // kept. KV is eventually consistent, so this shapes volume rather
      // than policing it — proportionate for an endpoint that must stay
      // auth-free so a failed setup can always ask for help.
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rlKey = "rl:report:" + ip;
      const rlCount = parseInt((await env.SETUPS.get(rlKey)) || "0", 10) || 0;
      if (rlCount >= 10) return json({ error: "rate_limited" }, 429);
      await env.SETUPS.put(rlKey, String(rlCount + 1), { expirationTtl: 3600 });
      const suffix = entry.ts + ":" + Math.random().toString(36).slice(2, 8);
      const key = "report:" + suffix;
      if (entry._img) {
        entry.img_key = "img:" + suffix;
        await env.SETUPS.put(entry.img_key, entry._img);
        delete entry._img;
      }
      await env.SETUPS.put(key, JSON.stringify(entry));
      const stored = await env.SETUPS.list({ prefix: "report:", limit: 1000 });
      if (stored.keys.length > 100) {
        const oldest = stored.keys.map((k) => k.name).sort().slice(0, stored.keys.length - 100);
        for (const name of oldest) {
          await env.SETUPS.delete(name);
          await env.SETUPS.delete("img:" + name.slice("report:".length));
        }
      }
      return json({ ok: true });
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
      // Repo links are validated before storage: exactly
      // https://github.com/<owner>/<repo>, nothing else renders in admin.
      const repoUrl = typeof body.repo_url === "string" ? body.repo_url.trim() : "";
      if (repoUrl && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoUrl)) {
        return json({ error: "invalid_repo_url" }, 400);
      }
      const entry = {
        name: typeof body.name === "string" ? body.name : "",
        github_login: login,
        repo_url: repoUrl,
        has_db: body.has_db === true,
        verified_count: Number.isFinite(body.verified_count) ? Math.trunc(body.verified_count) : 0,
        ts: Date.now(),
      };
      // One entry per GitHub login — re-registering overwrites the old entry.
      await env.SETUPS.put(login, JSON.stringify(entry));
      // Invite completion credit: a finished setup is the moment an invite
      // is spent and the next handful is earned. Runs only with the gate
      // flag on; with it off, the response is exactly what it has always
      // been. Idempotent — see inviteCompletion.
      if (invitesConfig(env).required) {
        const invites = await inviteCompletion(env, login, entry.name);
        return json({ ok: true, github_login: login, invites });
      }
      return json({ ok: true, github_login: login });
    }

    // Friendly early check for the page's invite step: is this code usable?
    // Reveals nothing beyond the giver's first name (as carried on the
    // code) — never the giver's login, never why an unusable code failed.
    if (url.pathname === "/invite/validate" && request.method === "POST") {
      if (!env.SETUPS) return json({ error: "registry_not_configured" }, 501);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rlKey = "rl:validate:" + ip;
      const hits = parseInt((await env.SETUPS.get(rlKey)) || "0", 10) || 0;
      if (hits >= 30) return json({ error: "rate_limited" }, 429);
      const code = normInviteCode(body.code);
      const rec = code ? await getInviteRecord(env.SETUPS, code) : null;
      const usable = !!rec && rec.status === "issued" && !rec.boundTo &&
        !(rec.expiresAt && rec.expiresAt < Date.now());
      if (!usable) {
        await env.SETUPS.put(rlKey, String(hits + 1), { expirationTtl: 3600 });
        return json({ valid: false });
      }
      const out = { valid: true };
      const giver = firstNameOf(rec.issuerName);
      if (giver) out.issuerName = giver;
      return json(out);
    }

    // The caller's own invites: their codes with statuses, balance, points,
    // tier and soft standing. Authenticated exactly like /register — the
    // caller's own GitHub token, verified live; a caller only ever sees
    // their own codes. No leaderboard here by design (admin has the board).
    if (url.pathname === "/invite/mine" && request.method === "GET") {
      if (!env.SETUPS) return json({ error: "registry_not_configured" }, 501);
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!token) return json({ error: "missing_token" }, 401);
      const login = await verifyGitHubToken(token);
      if (!login) return json({ error: "invalid_token" }, 401);
      let ledger = await getInviteLedger(env.SETUPS, login);
      if (!ledger) {
        const entryRaw = await env.SETUPS.get(login);
        if (!entryRaw) {
          // No finished setup yet — an empty, truthful payload.
          return json(await inviteMinePayload(env.SETUPS, newInviteLedger(login, "")));
        }
        // Grandfather path: a finished setup but no ledger (they completed
        // before the gate existed) — issue their starter codes on first
        // sight. They are never re-gated and never asked for a code.
        let name = "";
        try {
          const e = JSON.parse(entryRaw);
          if (e && typeof e.name === "string") name = e.name;
        } catch { /* name is decoration here */ }
        ledger = newInviteLedger(login, name);
        ledger.cap = invitesConfig(env).balance;
        await issueInvites(env.SETUPS, ledger, invitesConfig(env).balance, { batch: "starter" });
        await putInviteLedger(env.SETUPS, ledger);
      }
      return json(await inviteMinePayload(env.SETUPS, ledger));
    }

    // Admin: generate a batch of invite codes. Auth mirrors /admin exactly
    // (the link key, or a GitHub token belonging to ADMIN_GITHUB_LOGIN).
    // Default issuer is the operator; forLogin issues on behalf of a user
    // (e.g. replacing lost codes). forName/lang ride on each code as the
    // recipient context for the invite link.
    if (url.pathname === "/admin/invites" && request.method === "POST") {
      if (!env.SETUPS) return json({ error: "registry_not_configured" }, 501);
      const keyParam = url.searchParams.get("key");
      const keyOk = !!env.ADMIN_LINK_KEY && keyParam !== null && secretEquals(keyParam, env.ADMIN_LINK_KEY);
      if (!keyOk) {
        const auth = request.headers.get("Authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (!token) return json({ error: "missing_token" }, 401);
        const login = await verifyGitHubToken(token);
        if (!login) return json({ error: "invalid_token" }, 401);
        if (!adminLogin || login !== adminLogin) {
          return json({ error: "not_admin", detail: "This GitHub account is not the registered admin for this setup service." }, 403);
        }
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const count = Number.isFinite(body.count) ? Math.trunc(body.count) : 0;
      if (count < 1 || count > 50) return json({ error: "bad_count", detail: "count must be between 1 and 50." }, 400);
      const issuerLogin = (typeof body.forLogin === "string" && body.forLogin.trim())
        ? body.forLogin.trim().toLowerCase()
        : adminLogin;
      if (!issuerLogin) return json({ error: "no_issuer", detail: "ADMIN_GITHUB_LOGIN is not configured and no forLogin was given." }, 400);
      let ledger = await getInviteLedger(env.SETUPS, issuerLogin);
      if (!ledger) {
        let name = typeof body.issuerName === "string" ? body.issuerName : "";
        if (!name) {
          const entryRaw = await env.SETUPS.get(issuerLogin);
          if (entryRaw) {
            try {
              const e = JSON.parse(entryRaw);
              if (e && typeof e.name === "string") name = e.name;
            } catch { /* name is decoration here */ }
          }
        }
        ledger = newInviteLedger(issuerLogin, name);
        ledger.cap = invitesConfig(env).balance;
      } else if (typeof body.issuerName === "string" && body.issuerName && !ledger.name) {
        ledger.name = body.issuerName;
      }
      const codes = await issueInvites(env.SETUPS, ledger, count, {
        forName: body.forName, lang: body.lang,
        batch: typeof body.batch === "string" ? body.batch : "admin",
      });
      await putInviteLedger(env.SETUPS, ledger);
      return json({ ok: true, issuerLogin, codes });
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
      const reports = [];
      const inviteRows = [];
      const inviteLedgers = [];
      let cursor;
      do {
        const page = await env.SETUPS.list(cursor ? { cursor } : {});
        for (const key of page.keys) {
          if (key.name.startsWith("img:")) continue; // screenshots are fetched via /admin/img
          const raw = await env.SETUPS.get(key.name);
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            if (key.name.startsWith("report:")) reports.push(parsed);
            else if (key.name.startsWith("invite:")) { if (parsed && parsed.code) inviteRows.push(parsed); }
            else if (key.name.startsWith("invledger:")) { if (parsed && parsed.login) inviteLedgers.push(parsed); }
            // Only genuine setup entries (they always carry github_login)
            // join the list — rate-limit counters and any future internal
            // keys in this namespace must never surface as fake setups.
            else if (parsed && typeof parsed === "object" && parsed.github_login) entries.push(parsed);
          } catch { /* skip a corrupt entry rather than fail the whole list */ }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      const tsValue = (e) => {
        const n = typeof e.ts === "number" ? e.ts : Date.parse(e.ts);
        return Number.isFinite(n) ? n : 0;
      };
      entries.sort((a, b) => tsValue(b) - tsValue(a));
      reports.sort((a, b) => tsValue(b) - tsValue(a));
      // Invites section: the operator is the host and sees the whole board —
      // totals, every code's row, per-person balances, and the leaderboard
      // (points desc; login as the stable tiebreak). User-facing endpoints
      // never expose this; /invite/mine is scoped to the caller.
      const inviteTotals = { issued: inviteRows.length, redeemed: 0, revoked: 0, outstanding: 0 };
      for (const r of inviteRows) {
        if (r.status === "redeemed") inviteTotals.redeemed++;
        else if (r.status === "revoked") inviteTotals.revoked++;
        else inviteTotals.outstanding++;
      }
      inviteRows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const inviteBalances = {};
      for (const l of inviteLedgers) inviteBalances[l.login] = l.balance || 0;
      const leaderboard = inviteLedgers
        .map((l) => ({
          login: l.login, name: l.name || "",
          points: l.points || 0, tier: inviteTierName(l.points || 0),
          balance: l.balance || 0, foundingRecruiter: l.foundingRecruiter === true,
        }))
        .sort((a, b) => (b.points - a.points) || a.login.localeCompare(b.login));
      return json({
        setups: entries, reports: reports.slice(0, 50),
        invites: { totals: inviteTotals, codes: inviteRows, balances: inviteBalances, leaderboard },
      });
    }

    // Feedback screenshots, fetched one at a time by the admin view so the
    // /admin list itself stays small. Auth mirrors /admin exactly: the
    // link key (option b) OR a Bearer GitHub token belonging to the admin
    // login (option a) — the page's admin view can therefore sign in with
    // GitHub and never needs the key in a URL at all.
    if (url.pathname === "/admin/img" && request.method === "GET") {
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
          return json({ error: "not_admin" }, 403);
        }
      }
      const name = url.searchParams.get("name") || "";
      if (!/^img:\d+:[a-z0-9]+$/.test(name)) return json({ error: "bad_name" }, 400);
      const img = await env.SETUPS.get(name);
      if (!img) return json({ error: "not_found" }, 404);
      return json({ image: img });
    }

    return json({ error: "not_found" }, 404);
  },
};
// Deploy verification 2026-11-09: comment-only change to trigger Workers Builds auto-deploy. No functional change.
