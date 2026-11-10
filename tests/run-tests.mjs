// Invite-system test harness for the PowerUpMyAI worker.
// Local node: stub KV + stub GitHub/provider fetches, real Request objects.
// Run: node tests/run-tests.mjs (from the repo root), or sh tests/RUN-TESTS.sh
import worker from "../worker.js";

class StubKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); }
  async delete(k) { this.map.delete(k); }
  async list(opts = {}) {
    const prefix = opts.prefix || "";
    const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
    const limit = opts.limit || 1000;
    const slice = all.slice(start, start + limit);
    const complete = start + limit >= all.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: complete,
      cursor: complete ? "" : String(start + limit),
    };
  }
}

// Fetch stub: GitHub /user resolves any "tok-<login>" to <login>;
// provider token endpoints turn OAuth code "code-<login>" into "tok-<login>".
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === "https://api.github.com/user") {
    const auth = (opts.headers && opts.headers.Authorization) || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token.startsWith("tok-") && token.length > 4) {
      return new Response(JSON.stringify({ login: token.slice(4) }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
  }
  if (u === "https://github.com/login/oauth/access_token") {
    const code = opts.body.get("code");
    if (typeof code === "string" && code.startsWith("code-")) {
      return new Response(JSON.stringify({ access_token: "tok-" + code.slice(5), token_type: "bearer", scope: "repo" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 400 });
  }
  if (u === "https://api.supabase.com/v1/oauth/token") {
    return new Response(JSON.stringify({ access_token: "sbtok-1", token_type: "bearer" }), { status: 200 });
  }
  throw new Error("unstubbed fetch: " + u);
};

function makeEnv(kv, extra = {}) {
  return {
    GITHUB_CLIENT_ID: "ghcid", GITHUB_CLIENT_SECRET: "ghsec",
    SUPABASE_CLIENT_ID: "sbid", SUPABASE_CLIENT_SECRET: "sbsec",
    ALLOWED_ORIGIN: "https://powerupmyai.com",
    EXPECTED_REDIRECT_URI: "https://powerupmyai.com/",
    ADMIN_GITHUB_LOGIN: "aur42", ADMIN_LINK_KEY: "test-link-key",
    SETUPS: kv, ...extra,
  };
}
function req(path, { method = "GET", body, token, ip } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (ip) headers["CF-Connecting-IP"] = ip;
  return new Request("https://worker.test" + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
}
async function call(env, request) {
  const res = await worker.fetch(request, env);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, data };
}
const exchange = (env, login, extra = {}, ip) =>
  call(env, req("/exchange", { method: "POST", ip, body: { provider: "github", code: "code-" + login, redirect_uri: "https://powerupmyai.com/", ...extra } }));
const register = (env, login, name) =>
  call(env, req("/register", { method: "POST", token: "tok-" + login, body: { github_login: login, name: name || "", repo_url: "https://github.com/" + login + "/agent-home", has_db: true, verified_count: 3 } }));

let passed = 0, failed = 0;
function check(label, cond, extra) {
  if (cond) { passed++; console.log("  PASS " + label); }
  else { failed++; console.log("  FAIL " + label + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
const CODE_RE = /^PUMA-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

// ---------- A. Flag-off regression ----------
console.log("A. Flag-off regression");
{
  const kv = new StubKV();
  const env = makeEnv(kv);
  const cfg = await call(env, req("/config"));
  check("A1 /config invites.required === false", cfg.data.invites.required === false, cfg.data);
  const ex = await exchange(env, "theo");
  check("A2 exchange 200 + token", ex.status === 200 && ex.data.access_token === "tok-theo", ex);
  check("A2 exchange response keys unchanged", JSON.stringify(Object.keys(ex.data).sort()) === JSON.stringify(["access_token", "refresh_token", "scope", "token_type"]), Object.keys(ex.data));
  const reg = await register(env, "theo", "Theo");
  check("A3 register 200, exact old shape", reg.status === 200 && JSON.stringify(reg.data) === JSON.stringify({ ok: true, github_login: "theo" }), reg.data);
  const rep = await call(env, req("/report", { method: "POST", body: { step: "s", error: "e" } }));
  check("A5 /report still ok", rep.data && rep.data.ok === true, rep.data);
  const adm = await call(env, req("/admin?key=test-link-key"));
  check("A4 admin lists the setup", adm.data.setups.length === 1 && adm.data.setups[0].github_login === "theo", adm.data);
  check("A4 admin invites section present but empty", adm.data.invites.totals.issued === 0 && adm.data.invites.leaderboard.length === 0, adm.data.invites);
}

// ---------- B. Flag-on gate ----------
console.log("B. Flag-on gate");
const kvB = new StubKV();
const envB = makeEnv(kvB, { INVITES_REQUIRED: "true" });
let code1, code2;
{
  const batch = await call(envB, req("/admin/invites?key=test-link-key", { method: "POST", body: { count: 2, issuerName: "Arnold Boss", forName: "Theo" } }));
  check("B1 admin batch ok", batch.status === 200 && batch.data.ok === true && batch.data.issuerLogin === "aur42", batch.data);
  [code1, code2] = batch.data.codes;
  check("B1 codes match PUMA format", CODE_RE.test(code1) && CODE_RE.test(code2) && code1 !== code2, batch.data.codes);
  const val = await call(envB, req("/invite/validate", { method: "POST", body: { code: code1.toLowerCase() } }));
  check("B2 validate: valid + giver first name only", val.data.valid === true && val.data.issuerName === "Arnold", val.data);
  const bad = await call(envB, req("/invite/validate", { method: "POST", body: { code: "PUMA-ZZZZZZ" } }));
  check("B3 validate unknown code → valid:false, nothing leaked", bad.data.valid === false && !("issuerName" in bad.data), bad.data);
  const noCode = await exchange(envB, "patrick", {}, "10.0.0.1");
  check("B4 codeless new login → 403 invite_required, no token", noCode.status === 403 && noCode.data.error === "invite_required" && !("access_token" in noCode.data), noCode.data);
  const wrong = await exchange(envB, "patrick", { invite_code: "PUMA-ZZZZZZ" }, "10.0.0.1");
  check("B5 wrong code → 403 invite_invalid", wrong.status === 403 && wrong.data.error === "invite_invalid", wrong.data);
  const ok = await exchange(envB, "patrick", { invite_code: code1 }, "10.0.0.1");
  check("B6 valid code admits", ok.status === 200 && ok.data.access_token === "tok-patrick", ok.data);
  const rec1 = JSON.parse(await kvB.get("invite:" + code1));
  check("B6 code bound tentatively, not yet redeemed", rec1.boundTo === "patrick" && rec1.status === "issued", rec1);
  check("B6 binding record written", !!(await kvB.get("invbind:patrick")), null);
  const second = await exchange(envB, "mar", { invite_code: code1 }, "10.0.0.2");
  check("B7 same code, second login → 403 invite_spent", second.status === 403 && second.data.error === "invite_spent", second.data);
  const rec1b = JSON.parse(await kvB.get("invite:" + code1));
  check("B7 conflict recorded, binding untouched", rec1b.conflict === "mar" && rec1b.boundTo === "patrick", rec1b);
  const resume = await exchange(envB, "patrick", { invite_code: code1 }, "10.0.0.1");
  check("B8 bound login re-exchange passes (resume)", resume.status === 200, resume.data);
  const oper = await exchange(envB, "aur42", {}, "10.0.0.3");
  check("B9 operator never gated", oper.status === 200, oper.data);
  await kvB.put("oldtimer", JSON.stringify({ name: "Old Timer", github_login: "oldtimer", repo_url: "", has_db: true, verified_count: 3, ts: 1 }));
  const grand = await exchange(envB, "oldtimer", {}, "10.0.0.4");
  check("B10 pre-gate user (setup entry) ungated", grand.status === 200, grand.data);
  const sbPlain = await call(envB, req("/exchange", { method: "POST", body: { provider: "supabase", code: "sbcode", redirect_uri: "https://powerupmyai.com/" } }));
  check("B11 supabase exchange without github_token unchanged", sbPlain.status === 200 && sbPlain.data.access_token === "sbtok-1", sbPlain.data);
  const sbStranger = await call(envB, req("/exchange", { method: "POST", body: { provider: "supabase", code: "sbcode", redirect_uri: "https://powerupmyai.com/", github_token: "tok-stranger" } }));
  check("B11 supabase + ungated github_token → 403 invite_required", sbStranger.status === 403 && sbStranger.data.error === "invite_required", sbStranger.data);
  const sbBound = await call(envB, req("/exchange", { method: "POST", body: { provider: "supabase", code: "sbcode", redirect_uri: "https://powerupmyai.com/", github_token: "tok-patrick" } }));
  check("B11 supabase + bound github_token passes", sbBound.status === 200, sbBound.data);
}

// ---------- C. Completion credit ----------
console.log("C. Completion credit");
{
  const reg = await register(envB, "patrick", "Patrick");
  check("C1 register returns invites payload", reg.status === 200 && !!reg.data.invites, reg.data);
  const inv = reg.data.invites;
  check("C1 new user receives 5 codes", inv.codes.length === 5 && inv.codes.every((c) => CODE_RE.test(c.code) && c.status === "issued"), inv.codes);
  check("C1 balance 5, points 0, tier null, nextTierAt 1", inv.balance === 5 && inv.points === 0 && inv.tier === null && inv.nextTierAt === 1 && inv.foundingRecruiter === false, inv);
  const rec1 = JSON.parse(await kvB.get("invite:" + code1));
  check("C1 code flipped to redeemed at completion", rec1.status === "redeemed" && rec1.redeemedByLogin === "patrick" && typeof rec1.redeemedAt === "number", rec1);
  const aur = JSON.parse(await kvB.get("invledger:aur42"));
  check("C2 issuer credited once: points 1, redeemedCount 1, tier field via points", aur.points === 1 && aur.redeemedCount === 1, aur);
  check("C2 issuer balance spent down 2 → 1", aur.balance === 1, aur);
  const again = await register(envB, "patrick", "Patrick");
  const aur2 = JSON.parse(await kvB.get("invledger:aur42"));
  const pat = JSON.parse(await kvB.get("invledger:patrick"));
  check("C3 repeat register: no double credit, no re-issue", aur2.points === 1 && pat.issued.length === 5 && again.data.invites.codes.length === 5, { aur: aur2.points, pat: pat.issued.length });
  // Theo completes via the second admin code, then five people ride Theo's codes.
  await exchange(envB, "theo", { invite_code: code2 }, "10.0.1.1");
  const theoReg = await register(envB, "theo", "Theo");
  const theoCodes = theoReg.data.invites.codes.map((c) => c.code);
  check("C4 theo completes, receives own 5", theoCodes.length === 5, theoReg.data.invites);
  for (let i = 1; i <= 5; i++) {
    const u = "u" + i;
    const ex = await exchange(envB, u, { invite_code: theoCodes[i - 1] }, "10.0.2." + i);
    if (ex.status !== 200) check("C5 rider " + u + " exchange", false, ex.data);
    await register(envB, u, "User " + i);
  }
  const theo = JSON.parse(await kvB.get("invledger:theo"));
  check("C5 5th redemption: points 5", theo.points === 5 && theo.redeemedCount === 5, theo);
  check("C5 prize: founding mark + 5 fresh codes + balance back to 5", theo.foundingRecruiter === true && theo.prizeGranted === true && theo.issued.length === 10 && theo.balance === 5, theo);
  const theoMine = await call(envB, req("/invite/mine", { token: "tok-theo" }));
  check("C5 mine shows tier Founding recruiter, nextTierAt 10", theoMine.data.tier === "Founding recruiter" && theoMine.data.nextTierAt === 10, theoMine.data);
  const patMine = await call(envB, req("/invite/mine", { token: "tok-patrick" }));
  check("C6 standing: patrick rank 3 of 8 homes", patMine.data.standing.rank === 3 && patMine.data.standing.ofHomes === 8, patMine.data.standing);
  const oldReg = await register(envB, "oldtimer", "Old Timer");
  check("C7 grandfather completes under flag-on: starter codes, nobody credited", oldReg.data.invites.codes.length === 5, oldReg.data.invites);
  const noTok = await call(envB, req("/invite/mine"));
  const badTok = await call(envB, req("/invite/mine", { token: "nonsense" }));
  check("H mine auth: missing token 401, bad token 401", noTok.status === 401 && badTok.status === 401, { noTok: noTok.status, badTok: badTok.status });
  check("H mine leaks nobody else's codes", patMine.data.codes.every((c) => c.code.startsWith("PUMA-")) && patMine.data.login === "patrick", patMine.data.login);
}

// ---------- F. Admin board (on the B/C ledger) ----------
console.log("F. Admin board");
{
  const adm = await call(envB, req("/admin", { token: "tok-aur42" }));
  const t = adm.data.invites.totals;
  check("F totals: issued 47, redeemed 7, outstanding 40", t.issued === 47 && t.redeemed === 7 && t.outstanding === 40 && t.revoked === 0, t);
  const lb = adm.data.invites.leaderboard;
  check("F leaderboard order: theo 5, aur42 2, then the rest", lb[0].login === "theo" && lb[0].points === 5 && lb[0].tier === "Founding recruiter" && lb[1].login === "aur42" && lb[1].points === 2, lb.slice(0, 2));
  const row = adm.data.invites.codes.find((c) => c.code === code1);
  check("F code row carries the graph", row && row.issuerLogin === "aur42" && row.redeemedByLogin === "patrick" && row.status === "redeemed", row);
  check("F balances map present", adm.data.invites.balances.theo === 5 && adm.data.invites.balances.aur42 === 0, adm.data.invites.balances);
  const denied = await call(envB, req("/admin/invites", { method: "POST", token: "tok-theo", body: { count: 1 } }));
  check("F non-admin cannot mint codes", denied.status === 403 && denied.data.error === "not_admin", denied.data);
}

// ---------- D. Tier boundaries (seeded read-path) ----------
console.log("D. Tier boundaries");
{
  const kv = new StubKV();
  const env = makeEnv(kv, { INVITES_REQUIRED: "true" });
  const cases = [
    [0, null, 1], [1, "First door opened", 5], [4, "First door opened", 5],
    [5, "Founding recruiter", 10], [9, "Founding recruiter", 10],
    [10, "Connector", 25], [24, "Connector", 25],
    [25, "Pillar", null], [26, "Pillar", null],
  ];
  for (let i = 0; i < cases.length; i++) {
    const login = "s" + i;
    await kv.put("invledger:" + login, JSON.stringify({ login, name: "", issued: [], balance: 0, cap: 5, redeemedCount: cases[i][0], points: cases[i][0], foundingRecruiter: cases[i][0] >= 5, prizeGranted: cases[i][0] >= 5, cycles: 0, updatedAt: 0 }));
    const mine = await call(env, req("/invite/mine", { token: "tok-" + login }));
    check("D points " + cases[i][0] + " → tier " + cases[i][1] + ", next " + cases[i][2],
      mine.data.tier === cases[i][1] && mine.data.nextTierAt === cases[i][2] && mine.data.points === cases[i][0], mine.data);
  }
}

// ---------- E. Rank with ties ----------
console.log("E. Rank with ties");
{
  const kv = new StubKV();
  const env = makeEnv(kv, { INVITES_REQUIRED: "true" });
  for (const [login, pts] of [["ta", 5], ["tb", 5], ["tc", 3]]) {
    await kv.put("invledger:" + login, JSON.stringify({ login, name: "", issued: [], balance: 0, cap: 5, redeemedCount: pts, points: pts, foundingRecruiter: false, prizeGranted: false, cycles: 0, updatedAt: 0 }));
    await kv.put(login, JSON.stringify({ name: "", github_login: login, repo_url: "", has_db: false, verified_count: 0, ts: 1 }));
  }
  const a = await call(env, req("/invite/mine", { token: "tok-ta" }));
  const b = await call(env, req("/invite/mine", { token: "tok-tb" }));
  const c = await call(env, req("/invite/mine", { token: "tok-tc" }));
  check("E tied leaders share rank 1; next is 3; ofHomes 3",
    a.data.standing.rank === 1 && b.data.standing.rank === 1 && c.data.standing.rank === 3 && a.data.standing.ofHomes === 3,
    { a: a.data.standing, b: b.data.standing, c: c.data.standing });
}

// ---------- G. Rate shaping on gate failures ----------
console.log("G. Rate shaping");
{
  const kv = new StubKV();
  const env = makeEnv(kv, { INVITES_REQUIRED: "true" });
  let last = null;
  for (let i = 0; i < 10; i++) last = await exchange(env, "guesser", { invite_code: "PUMA-ZZZZZZ" }, "10.9.9.9");
  check("G 10th bad attempt still a plain refusal", last.status === 403 && last.data.error === "invite_invalid", last.data);
  const eleventh = await exchange(env, "guesser", { invite_code: "PUMA-ZZZZZZ" }, "10.9.9.9");
  check("G 11th attempt → 429 rate_limited", eleventh.status === 429 && eleventh.data.error === "rate_limited", eleventh.data);
}

// ---------- I. Fail-closed without KV ----------
console.log("I. Fail-closed without KV");
{
  const env = makeEnv(null, { INVITES_REQUIRED: "true" });
  delete env.SETUPS;
  const ex = await exchange(env, "theo");
  check("I gate on + no KV → 501, no token", ex.status === 501 && ex.data.error === "registry_not_configured" && !("access_token" in ex.data), ex.data);
}

// ---------- J. Admin sign-in via GitHub Bearer (the page's primary path) ----------
// Mirrors the deployed page exactly: #admin runs the GitHub OAuth flow,
// the callback stores the token as adminToken, and /admin is then called
// with Authorization: Bearer <token> — no ?key= anywhere. The key link is
// the break-glass fallback only.
console.log("J. Admin Bearer sign-in");
{
  const kv = new StubKV();
  const env = makeEnv(kv, { INVITES_REQUIRED: "true" });
  const mint = await call(env, req("/admin/invites", { method: "POST", token: "tok-aur42", body: { count: 3, issuerName: "Arnold Boss" } }));
  check("J1 operator Bearer can mint codes (no key)", mint.status === 200 && mint.data.ok === true && mint.data.codes.length === 3 && mint.data.issuerLogin === "aur42", mint.data);
  const adm = await call(env, req("/admin", { token: "tok-aur42" }));
  check("J2 operator Bearer reads /admin incl. invites section", adm.status === 200 && adm.data.invites.totals.issued === 3 && Array.isArray(adm.data.invites.leaderboard) && adm.data.invites.leaderboard.length === 1 && adm.data.invites.leaderboard[0].login === "aur42", adm.data.invites);
  const stranger = await call(env, req("/admin", { token: "tok-theo" }));
  check("J3 non-operator Bearer → 403 not_admin", stranger.status === 403 && stranger.data.error === "not_admin", stranger.data);
  const strangerMint = await call(env, req("/admin/invites", { method: "POST", token: "tok-theo", body: { count: 1 } }));
  check("J3 non-operator Bearer cannot mint → 403 not_admin", strangerMint.status === 403 && strangerMint.data.error === "not_admin", strangerMint.data);
  const badTok = await call(env, req("/admin", { token: "nonsense" }));
  check("J4 bad Bearer token → 401 invalid_token", badTok.status === 401 && badTok.data.error === "invalid_token", badTok.data);
  const noTok = await call(env, req("/admin"));
  check("J5 no token, no key → 401 missing_token", noTok.status === 401 && noTok.data.error === "missing_token", noTok.data);
  const imgAuth = await call(env, req("/admin/img?name=img%3A1%3Aabc", { token: "tok-aur42" }));
  check("J6 operator Bearer passes /admin/img auth (400 on bad name shape)", imgAuth.status === 404 || imgAuth.status === 400, imgAuth.data);
  const imgStranger = await call(env, req("/admin/img?name=img%3A1%3Aabc", { token: "tok-theo" }));
  check("J6 non-operator Bearer → 403 on /admin/img", imgStranger.status === 403, imgStranger.data);
  const keyStill = await call(env, req("/admin?key=test-link-key"));
  check("J7 break-glass key still works alongside", keyStill.status === 200 && keyStill.data.invites.totals.issued === 3, keyStill.data && keyStill.data.invites && keyStill.data.invites.totals);
}

// ---------- K. Two-person admin allowlist (ADMIN_GITHUB_LOGINS) ----------
// The allowlist ships EMPTY in production: this section proves the
// mechanism with a stub second login ("operator-b"). With the var unset,
// section A–J above already prove the single-login world is unchanged.
console.log("K. Admin allowlist");
{
  const kv = new StubKV();
  const env = makeEnv(kv, { ADMIN_GITHUB_LOGINS: "aur42, operator-b" });
  const admB = await call(env, req("/admin", { token: "tok-operator-b" }));
  check("K1 operator B Bearer reads /admin, invites section present", admB.status === 200 && !!admB.data.invites, admB.data);
  const mintB = await call(env, req("/admin/invites", { method: "POST", token: "tok-operator-b", body: { count: 2 } }));
  check("K2 operator B mints; issuer defaults to the caller, not aur42", mintB.status === 200 && mintB.data.issuerLogin === "operator-b" && mintB.data.codes.length === 2, mintB.data);
  const imgB = await call(env, req("/admin/img?name=img%3A1%3Aabc", { token: "tok-operator-b" }));
  check("K3 operator B passes /admin/img auth (400/404, not 401/403)", imgB.status === 400 || imgB.status === 404, imgB.status);
  const envGate = makeEnv(new StubKV(), { ADMIN_GITHUB_LOGINS: "aur42, operator-b", INVITES_REQUIRED: "true" });
  const wave = await exchange(envGate, "operator-b", {}, "10.5.0.1");
  check("K4 operator B waved through the invite gate with no code", wave.status === 200 && wave.data.access_token === "tok-operator-b", wave.data);
  const dAdm = await call(env, req("/admin", { token: "tok-mallory" }));
  const dMint = await call(env, req("/admin/invites", { method: "POST", token: "tok-mallory", body: { count: 1 } }));
  const dImg = await call(env, req("/admin/img?name=img%3A1%3Aabc", { token: "tok-mallory" }));
  check("K5 non-listed login → 403 not_admin on all three surfaces", dAdm.status === 403 && dAdm.data.error === "not_admin" && dMint.status === 403 && dMint.data.error === "not_admin" && dImg.status === 403 && dImg.data.error === "not_admin", { adm: dAdm.status, mint: dMint.status, img: dImg.status });
  const envMessy = makeEnv(new StubKV(), { ADMIN_GITHUB_LOGINS: " aur42 , Operator-B " });
  const messy = await call(envMessy, req("/admin", { token: "tok-Operator-B" }));
  check("K6 parsing tolerance: spaces + mixed case still authorise operator B", messy.status === 200, messy.status);
  const keyK = await call(env, req("/admin?key=test-link-key"));
  check("K7 break-glass key unchanged under the allowlist config", keyK.status === 200 && keyK.data.invites.totals.issued === 2, keyK.data && keyK.data.invites && keyK.data.invites.totals);
  const envSolo = makeEnv(new StubKV());
  const soloB = await call(envSolo, req("/admin", { token: "tok-operator-b" }));
  const soloA = await call(envSolo, req("/admin", { token: "tok-aur42" }));
  check("K8 fallback config (var unset): operator B 403, operator A 200 — single-login world unchanged", soloB.status === 403 && soloB.data.error === "not_admin" && soloA.status === 200, { b: soloB.status, a: soloA.status });
}

console.log("\nTOTAL: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
