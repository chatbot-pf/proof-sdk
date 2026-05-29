#!/usr/bin/env -S npx tsx
// Agent-path driver for Proof SDK.
//
// Drives the Express server (:4000) end-to-end through the public
// @proof/agent-bridge client: create a doc, set presence, read state,
// post a comment, read marks back. Exercises BOTH the server routes and
// the SDK client in one shot.
//
// Run (server must already be listening on PROOF_BASE_URL):
//   npx tsx .claude/skills/run-proof-sdk/driver.mjs
//   PROOF_BASE_URL=http://127.0.0.1:4000 npx tsx .claude/skills/run-proof-sdk/driver.mjs
//
// We import the package SOURCE directly (not via node_modules). The
// package's index.ts uses repo-relative imports (../../../src, ../../../server)
// that only resolve when loaded from packages/agent-bridge/src/, so going
// through the workspace copy/symlink is fragile — the direct source path
// is robust regardless of how the package manager linked things.
import { createAgentBridgeClient } from '../../../packages/agent-bridge/src/index.ts'

const BASE = (process.env.PROOF_BASE_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '')

// The bridge enforces client-capability headers (CLIENT_UPGRADE_REQUIRED
// without them). A real Proof client sends these; the bundled example does
// NOT, which is why `npm run demo:agent` fails. We pass them explicitly.
const CLIENT_HEADERS = {
  'x-proof-client-version': '0.30.0',
  'x-proof-client-build': '1',
  'x-proof-client-protocol': '3',
}

function ok(label, detail) {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  console.log(`[driver] target ${BASE}`)

  // 1. Create a document (no client headers needed for POST /documents).
  let created
  try {
    const res = await fetch(`${BASE}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Driver Smoke Doc',
        markdown: '# Draft\n\nThe opening is weak and needs a stronger claim.',
      }),
    })
    if (!res.ok) throw new Error(`POST /documents -> ${res.status}`)
    created = await res.json()
  } catch (err) {
    console.error(`[driver] cannot reach server at ${BASE}. Is it running? (npm run serve)`)
    throw err
  }
  if (!created.slug || !created.accessToken) {
    throw new Error('create response missing slug/accessToken')
  }
  ok('POST /documents', `slug=${created.slug} role=${created.accessRole}`)

  // The shareToken (editor role) authorizes the open bridge routes:
  // state, marks, comments, suggestions, rewrite (auth: 'none' in
  // bridge-auth-policy.ts). The owner-only routes (presence, marks/accept,
  // comments/resolve, ...) need the ownerSecret as a bridge token AND a live
  // browser viewer, so they are out of scope for a headless smoke run.
  const bridge = createAgentBridgeClient({
    baseUrl: BASE,
    auth: { shareToken: created.accessToken },
    headers: CLIENT_HEADERS,
  })

  // 2. Read bridge state.
  const state = await bridge.getState(created.slug)
  ok('bridge.getState', `title=${JSON.stringify(state.title)} revision=${state.revision}`)

  // 3. Post a comment (selector-based; anchored by quote text).
  const comment = await bridge.addComment(created.slug, {
    by: 'driver-agent',
    quote: 'weak',
    text: 'Consider opening with the core claim.',
  })
  const markId = comment.markId || comment.mark?.id || '(none)'
  ok('bridge.addComment', `success=${comment.success} markId=${markId}`)

  // 4. Post a suggestion (replace a phrase).
  const suggestion = await bridge.addSuggestion(created.slug, {
    kind: 'replace',
    quote: 'weak',
    by: 'driver-agent',
    content: 'underdeveloped',
  })
  ok('bridge.addSuggestion', `success=${suggestion.success}`)

  // 5. Read marks back — should reflect the comment + suggestion just added.
  // `marks` is an object keyed by markId, not an array.
  const marks = await bridge.getMarks(created.slug)
  const markCount = marks.marks && typeof marks.marks === 'object'
    ? Object.keys(marks.marks).length
    : 0
  ok('bridge.getMarks', `count=${markCount}`)
  if (markCount < 1) throw new Error('expected at least one mark after adding a comment')

  console.log('\n[driver] DRIVER OK')
}

main().catch((err) => {
  console.error('\n[driver] FAILED:', err.message)
  process.exit(1)
})
