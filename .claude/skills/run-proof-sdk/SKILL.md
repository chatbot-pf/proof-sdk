---
name: run-proof-sdk
description: Build, run, and drive Proof SDK — the collaborative markdown editor, Express collab/agent server, and agent HTTP bridge. Use when asked to start proof-sdk, run its server, build the editor, drive the agent bridge, take a screenshot of the editor, or run its tests.
---

Proof SDK has two runnable surfaces: an **Express server** on `:4000` (REST + agent HTTP bridge + WebSocket collab) and a **Vite editor** bundle served at `/d/:slug`. The primary agent path is the server + `@proof/agent-bridge` SDK, driven by **`.claude/skills/run-proof-sdk/driver.mjs`** (create a doc → set state → comment → suggest → read marks back). For the editor UI, build the bundle and open a doc URL in a browser.

All paths below are relative to the repo root (`proof-sdk/`).

## Prerequisites

- **Node.js 18+** (verified on v22) and **bun** (the repo ships `bun.lock` + `bunfig.toml`).
- A Chromium/Chrome binary only if you want editor screenshots. No system packages were needed on macOS; on Ubuntu install Chrome's libs for headless screenshots.

## Setup

```bash
bun install
```

No env vars are required to run. One is worth setting to silence a warning and stabilize collab signing across restarts:

```bash
export PROOF_COLLAB_SIGNING_SECRET=local-dev-secret-12345   # optional; default is an ephemeral in-memory key
```

## Build

**Only needed for the editor UI** — the server's REST + bridge API works without a build. The build is two steps short of serving the editor; see Gotchas.

```bash
npm run build                 # vite build -> dist/ + finalize manifest
cp -R dist/assets/. public/assets/   # REQUIRED: server serves /assets from public/, not dist/
```

## Run (agent path) — server + bridge driver

Start the server (foreground spawns and listens; background it for scripting):

```bash
PORT=4000 PROOF_COLLAB_SIGNING_SECRET=local-dev-secret-12345 npm run serve
# -> [proof-sdk] listening on http://127.0.0.1:4000
```

Then drive it with the committed driver (server must be listening):

```bash
PROOF_BASE_URL=http://127.0.0.1:4000 npx tsx .claude/skills/run-proof-sdk/driver.mjs
```

Expected output:

```
[driver] target http://127.0.0.1:4000
  ✓ POST /documents — slug=… role=editor
  ✓ bridge.getState — title="Driver Smoke Doc" revision=1
  ✓ bridge.addComment — success=true markId=…
  ✓ bridge.addSuggestion — success=true
  ✓ bridge.getMarks — count=2

[driver] DRIVER OK
```

The driver imports the package **source** directly (`../../../packages/agent-bridge/src/index.ts`) and passes the required client-capability headers — see Gotchas 1 & 2 for why both matter.

### Raw curl smoke (no SDK)

```bash
B=http://127.0.0.1:4000
CREATE=$(curl -s -X POST "$B/documents" -H 'Content-Type: application/json' \
  -d '{"title":"Smoke","markdown":"# Hello\n\nThe opening is weak."}')
SLUG=$(printf '%s' "$CREATE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).slug))')
TOKEN=$(printf '%s' "$CREATE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).accessToken))')

curl -s "$B/documents/$SLUG/state" -H "x-share-token: $TOKEN"           # 200

# Bridge routes REQUIRE client-capability headers (else 426):
curl -s -X POST "$B/documents/$SLUG/bridge/comments" \
  -H "x-share-token: $TOKEN" \
  -H "x-proof-client-version: 0.30.0" -H "x-proof-client-build: 1" -H "x-proof-client-protocol: 3" \
  -H 'Content-Type: application/json' -d '{"by":"agent","quote":"weak","text":"Tighten this."}'   # 200
```

## Run (browser path) — editor UI

After `npm run build` **and** the `cp -R dist/assets/. public/assets/` step, create a doc and open its token URL on `:4000`:

```bash
curl -s -X POST http://127.0.0.1:4000/documents -H 'Content-Type: application/json' \
  -d '{"title":"Demo","markdown":"# Demo\n\nHello."}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tokenUrl))'
# open the printed http://127.0.0.1:4000/d/<slug>?token=<token> in a browser
```

The editor chrome loads (top bar: `Proof | <title> | ● status | + Add agent | Share`), shows a "Choose a display name" onboarding modal (click **Continue anonymously**), and connects over WebSocket. See Gotcha 6 about the document body.

Headless screenshot (verified on macOS Chrome):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --window-size=1200,900 --virtual-time-budget=8000 \
  --screenshot=/tmp/proof-editor-shot.png \
  "http://localhost:4000/d/<slug>?token=<token>"
```

`example-screenshot.png` in this skill dir is a captured reference (editor chrome + onboarding modal).

The Vite dev server (`npm run dev` on `:3000`) is for editor development; it proxies `/d`, `/api`, `/documents` to `:4000`, so it still needs the `:4000` server running and the bundle built+copied for `/d/:slug` to render.

## Test

```bash
npm test   # tsx-based: agent-bridge client tests + server routes/share tests
```

## Gotchas

1. **Bridge routes need client-capability headers or they 426.** Every `/documents/:slug/bridge/*` route enforces `x-proof-client-version` (≥ `0.30.0`), `x-proof-client-build`, and `x-proof-client-protocol` (`3`). Without them you get `426 CLIENT_UPGRADE_REQUIRED` / `"reason":"missing_headers"`. (`GET /documents/:slug/state` is NOT a bridge route and needs only `x-share-token`.) Defined in `server/client-capabilities.ts`.

2. **`npm run demo:agent` is broken two ways out of the box.** (a) The bundled `@proof/agent-bridge` client does NOT send the headers from Gotcha 1 → `Client upgrade required`. (b) bun's hoisted linker *copies* the workspace package into `apps/proof-example/node_modules/@proof/agent-bridge` instead of symlinking, so its repo-relative import `../../../src/bridge/bridge-routes.js` resolves to a nonexistent `node_modules/src/...` → `ERR_MODULE_NOT_FOUND`. The driver sidesteps both by importing the package source path directly and passing `headers`.

3. **Editor 404s as "Loading editor…" forever unless you copy assets.** The server reads the doc HTML from `dist/index.html` but serves `/assets/*` from `public/` (the only `express.static` mount, `server/index.ts:49`). The built `editor.js` lands in `dist/assets/`, so `/assets/editor.js` 404s until you `cp -R dist/assets/. public/assets/`.

4. **`/d/:slug` before a build returns** `Editor not built. Run: npm run build` (`server/share-web-routes.ts`). The bridge/REST API works without a build; only the editor page needs `dist/`.

5. **Owner-only bridge routes need the ownerSecret AND a live viewer.** `presence`, `marks/accept|reject|reply|resolve`, `comments/reply|resolve` require `auth: 'bridge-token'` — pass the `ownerSecret` (from the create response) as `x-bridge-token`. Even then, `presence` returns `"No active viewer for this document"` unless a browser tab is connected. Open routes (`state`, `marks`, `comments`, `suggestions`, `rewrite`) accept the editor `shareToken`. Policy table: `server/bridge-auth-policy.ts`.

6. **The live editor canvas can stay blank in a local run.** The page loads, `[initFromShare] Loaded shared document` and `[ShareClient] WebSocket connected` fire, the chrome + agent toolbar render — but the ProseMirror body may remain empty with a "Connecting" badge (collab sync doesn't fully populate the view in this single-process local setup). The content is still fully available via `GET /documents/:slug/bridge/state` and as an SSR fallback in the DOM (`read_page` shows a "Document Content" block). Don't treat the blank canvas as a build failure.

## Troubleshooting

- `426 CLIENT_UPGRADE_REQUIRED` → add the three `x-proof-client-*` headers (Gotcha 1).
- `ERR_MODULE_NOT_FOUND … node_modules/src/bridge/bridge-routes.js` → don't run `demo:agent`; use `driver.mjs`, which imports the package source (Gotcha 2).
- Browser stuck on "Loading editor…" → you skipped `cp -R dist/assets/. public/assets/` (Gotcha 3).
- `Editor not built` → `npm run build` first (Gotcha 4).
- `Missing or invalid bridge token` / `No active viewer` → owner-only route; use `ownerSecret` and open a viewer (Gotcha 5).
- Port 3000 already in use → Vite uses `strictPort`, so it fails instead of incrementing; free the port.
