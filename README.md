# PowerUpMyAI

**One page that gives a non-technical person an agent home of their own** —
live at [powerupmyai.com](https://powerupmyai.com).

A visitor signs in with GitHub and Supabase (OAuth, in their own browser),
and the page creates, in *their* accounts:

- a **private GitHub repository** — the home's folder, holding the files all
  of their AIs share, and
- a **Supabase database** — the home's memory, where their AIs keep what
  they learn,

then installs a best-practice agent-home template into the repo and walks
the person through wiring the AIs they already use (Claude, ChatGPT, Muse,
Grok, and others) into it. Everything created belongs to the user, in the
user's own accounts; nothing is hosted for them here.

## What's in this repo

| File | What it is |
| --- | --- |
| `index.html` | The entire product page — markup, styles, logic, imagery, and the embedded template payloads, in one file, on purpose (see ARCHITECTURE.md). |
| `worker.js` | The one server piece: a Cloudflare Worker that exchanges OAuth codes for tokens (a client secret cannot live in a public page), plus the optional setup registry, the invite gate, problem reports, and the admin surfaces. |
| `wrangler.toml` | The worker's deploy configuration. **Read its header comment** — it carries one placeholder value (the SETUPS KV namespace id) that must be replaced from the live worker before deploying from a fresh clone. |
| `CNAME`, `favicon*`, `apple-touch-icon.png` | The custom domain and the brand mark (the "B" house). |
| `tests/` | The worker's test suite (see below). |
| `ARCHITECTURE.md` | The deliberate design decisions behind this repo's shape. |

## How the pieces fit

1. The page (static, GitHub Pages) fetches the public OAuth client IDs from
   the worker's `GET /config` — the operator configures everything in
   exactly one place.
2. The user authorises GitHub and Supabase in their own browser; the
   providers return one-time codes to the page.
3. The page sends each code to the worker's `POST /exchange`; the worker —
   the only place the client secrets exist — swaps it for an access token
   and returns the token to the user's browser. The exchange stores
   nothing.
4. With the user's own tokens, the page creates the private repo and the
   Supabase project, installs the template payloads embedded in the page,
   and verifies both creations by reading them back.
5. Optional, and only if the user opts in: the page registers the finished
   setup with the worker (`POST /register`), which stores name + GitHub
   login + repo link in the SETUPS KV namespace — never a token.

The worker also serves the invite gate (currently **off** — see
ARCHITECTURE.md) and the operator's admin view.

## Working on it locally

- **The page:** serve the folder with any static file server (for example
  `python3 -m http.server`) or just open `index.html`. Know that the page
  calls the **production** worker (`powerupmyai-oauth.…workers.dev`) for
  `/config` and `/exchange` — a local page preview exercises the live
  worker's public endpoints, and a full sign-in flow completes against the
  live configuration.
- **The worker:** `npx wrangler dev` runs it locally; put throwaway values
  in a `.dev.vars` file (gitignored). Never point a local worker at the
  production KV namespace casually — the registry and invite ledger are
  live data.

## Run the tests

The worker has a self-contained test suite — stub KV, stub provider
fetches, real `Request` objects, no network:

```sh
sh tests/RUN-TESTS.sh        # from the repo root; needs Node.js
# or: node tests/run-tests.mjs
```

74 checks: the flag-off regression set (the pre-invite worker's exact
behaviour), the invite gate, completion credit, tiers and ranking, rate
shaping, fail-closed behaviour without KV, admin sign-in, and the admin
allowlist. All 74 pass.

There is no test suite for the page itself in this repo; the page is
verified by the lab's external harness before each publish (see "Product
records" below).

## Deployment

Pushes to `main` deploy **both** halves, automatically:

- the **Pages site** (GitHub Pages, custom domain via `CNAME`), and
- the **worker** (Cloudflare Workers Builds is connected to this repo).

So a commit that touches only `index.html` still republishes the worker,
and vice versa. Treat every push to `main` as a production deploy of both.

Secrets are never in this repo. The OAuth client secrets and the admin
break-glass key exist only as Cloudflare Worker secrets; `wrangler.toml`
carries public values only (the client IDs are public — the page itself
fetches them from `/config`).

## Product records

This repo is deliberately only the deployable artifact. The design
baseline, specs, audits, and decision records for PowerUpMyAI live
**outside** this repo, in the lab workspace (`~/workspace/agent-home-product/`),
and the agent-home template's source of truth lives outside it too
(`~/workspace/agent-home-template/`) — the page embeds a byte-identical
copy of its payload files, verified by hash at every publish. If you are
looking for *why* something is the way it is, ask the lab for the records;
if you are looking for *what runs*, you are in the right place.
