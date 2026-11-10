# Architecture — the deliberate decisions

This repo's shape looks unusual (one giant HTML file, one worker file, no
build step). Every part of that is a decision, made for a reason. They are
stated here so nobody "fixes" them by accident.

## 1. The page is a single file

`index.html` is the whole product: markup, CSS, JavaScript, imagery, and
the agent-home template's payload files, all embedded.

- **Portability.** The page can be hosted anywhere that serves one static
  file, copied, archived, and diffed as one artifact.
- **Byte-exact verification.** The embedded template payloads are verified
  byte-for-byte against the template source (decision 3). One file means
  one hash proves what shipped.
- The cost is real — the file is ~2.5 MB and edits must be surgical — and
  accepted. There is no build step because a build step would stand
  between the source and the verified bytes.

## 2. The worker is a single file, and it is the only server piece

`worker.js` is one Cloudflare Worker. It exists for exactly one reason:
**an OAuth client secret cannot live in a public web page.** The worker
holds the GitHub and Supabase client secrets, exchanges one-time auth
codes for access tokens, and returns the token to the user's own browser.

- The exchange is **stateless by design**: it stores no tokens, no codes,
  nothing.
- The one bend in that doctrine is explicit and bounded: when the operator
  binds the optional SETUPS KV namespace, the worker also keeps an opt-in
  registry of finished setups and the invite ledger — names, logins, codes
  and timestamps, never tokens or secrets.
- There is **one worker source**. The template folder and this repo carry
  the same file; if they ever diverge, that is a bug, not a fork. (The
  file's own header carries the reconciliation note.)

## 3. Template payloads are embedded, and byte-identical to their source

The setup installs an agent home from payload files embedded in
`index.html`. Those payloads are a copy of the template source of truth,
which lives outside this repo. The rule:

- never edit a payload in only one place;
- every publish re-verifies that all payloads are byte-identical to the
  template source, by hash.

This is what makes "the page installs the current best-practice template"
a checkable claim instead of a hope.

## 4. The invite gate ships OFF, and off means identical

The worker carries an invite system (single-use `PUMA-` codes, tentative
binding at exchange, redemption only when a setup completes at
`/register`, per-user ledgers, tiered credit). It is controlled by the
`INVITES_REQUIRED` worker variable:

- Only the exact string `"true"` turns the gate on. The committed
  `wrangler.toml` ships `"false"`.
- **With the flag off, `/exchange` and `/register` behave byte-identically
  to the pre-gate worker** — this is a tested property (the flag-off
  regression set in `tests/`), not an intention.
- With the flag on and no KV namespace bound, the gate **fails closed**:
  exchanges return 501 rather than letting anyone through or pretending
  success.
- The operator and pre-gate users are never gated (grandfathering), and
  the completion credit is idempotent — a repeat registration credits
  nobody twice.

Flipping the flag is an operations decision with its own runbook in the
product records; it is never a side effect of a code change.

## 5. One KV namespace, three bounded jobs

The optional `SETUPS` binding carries:

- the **setup registry** (`<login>` keys — only for users who opt in at
  the end of setup),
- the **invite ledger** (`invite:<CODE>`, `invledger:<login>`,
  `invbind:<login>` keys), and
- short-lived **rate-limit counters** for gate failures.

Without the binding, the registry endpoints return 501 — never a fake
success. Cloudflare's free KV write quota (~1,000 writes/day) is the
invite system's first scaling ceiling, at roughly 100 invited setups a
day; that is a known, accepted limit with a pre-agreed escape (Workers
Paid), not a surprise.

## 6. Secrets live only in the worker's environment

- `GITHUB_CLIENT_SECRET`, `SUPABASE_CLIENT_SECRET`, and `ADMIN_LINK_KEY`
  are Cloudflare Worker **secrets**. They are never in this repo, never in
  `wrangler.toml`, and code deploys do not change them.
- What *is* in `wrangler.toml` is public: the OAuth client IDs (the page
  itself fetches them from `/config`), the allowed origin, and the exact
  expected redirect URI, which the worker enforces byte-for-byte on every
  exchange.
- Local worker development uses a gitignored `.dev.vars` file; see
  `.gitignore`.

## 7. Admin has two doors, and one of them is break-glass

- **Primary:** GitHub sign-in. `/admin`, `/admin/invites`, and
  `/admin/img` accept a GitHub bearer token whose login is on the admin
  list — `ADMIN_GITHUB_LOGIN`, or the optional comma-separated
  `ADMIN_GITHUB_LOGINS` allowlist when set. The operator's own login is
  always an admin whenever any admin config exists, so an allowlist can
  never lock the operator out. The allowlist currently ships **empty**:
  the single-login configuration is the production state.
- **Break-glass:** `GET /admin?key=<ADMIN_LINK_KEY>` — a long random
  secret held as a Worker secret, compared in constant time-ish fashion.
  The link itself *is* the credential; treat any copy of it as a password.
  Its value appears nowhere in this repo or its history.

## 8. One repo, two deploy targets

Pushes to `main` deploy the Pages site (GitHub Pages) **and** the worker
(Cloudflare Workers Builds) together. There is no separate release step
for either half, which is why the flag discipline in decision 4 matters:
behaviour changes that must not go live ship behind a worker variable
that defaults to off.
