import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  credentialsFromApiKey,
  getApiKey,
  getConfiguredApiKey,
  sanitizeApiKey,
  validateApiKey,
} from "../src/auth.ts"
import { assert, assertEqual, jsonResponse } from "./helpers.ts"

const ESC = String.fromCharCode(27)
assertEqual(
  sanitizeApiKey(`${ESC}[200~ user_abc123 ${ESC}[201~\n`),
  "user_abc123",
  "sanitize strips bracketed-paste markers and control chars",
)
assertEqual(sanitizeApiKey("  user_abc123  "), "user_abc123", "sanitize trims whitespace")

const creds = credentialsFromApiKey("user_abc123")
assertEqual(creds.access, "user_abc123", "credentials carry the key as access")
assertEqual(creds.refresh, "user_abc123", "credentials carry the key as refresh")
assert(creds.expires > Date.now() + 9 * 365 * 24 * 60 * 60 * 1000, "expiry is far in the future")
assertEqual(getApiKey(creds), "user_abc123", "getApiKey returns access")

// env resolution
assertEqual(
  getConfiguredApiKey({ env: { COMMAND_CODE_API_KEY: "user_env" }, authPaths: [] }),
  "user_env",
  "env COMMAND_CODE_API_KEY wins",
)
assertEqual(
  getConfiguredApiKey({ env: { COMMANDCODE_API_KEY: "user_env2" }, authPaths: [] }),
  "user_env2",
  "env COMMANDCODE_API_KEY fallback works",
)
assertEqual(getConfiguredApiKey({ env: {}, authPaths: [] }), undefined, "no key resolves undefined")

// auth-file resolution
const dir = mkdtempSync(join(tmpdir(), "pi-omp-cc-auth-"))
try {
  const authFile = join(dir, "auth.json")
  writeFileSync(authFile, JSON.stringify({ commandcode: { type: "oauth", access: "user_file" } }))
  assertEqual(
    getConfiguredApiKey({ env: {}, authPaths: [authFile] }),
    "user_file",
    "oauth credential in auth.json resolves",
  )
  writeFileSync(authFile, JSON.stringify({ "command-code": { type: "api", key: "user_api" } }))
  assertEqual(
    getConfiguredApiKey({ env: {}, authPaths: [authFile] }),
    "user_api",
    "api credential in auth.json resolves",
  )
  writeFileSync(authFile, JSON.stringify({ apiKey: "user_direct" }))
  assertEqual(
    getConfiguredApiKey({ env: {}, authPaths: [authFile] }),
    "user_direct",
    "direct apiKey field resolves",
  )
  writeFileSync(authFile, "{not json")
  assertEqual(
    getConfiguredApiKey({ env: {}, authPaths: [authFile] }),
    undefined,
    "malformed auth file is ignored",
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// host-aware ordering: the running host's own auth file outranks the other host's
const hostHome = mkdtempSync(join(tmpdir(), "pi-omp-cc-home-"))
try {
  const home = join(hostHome, "home")
  const cliDir = join(home, ".commandcode")
  const piDir = join(home, ".pi", "agent")
  const ompDir = join(home, ".omp", "agent")
  mkdirSync(piDir, { recursive: true })
  mkdirSync(ompDir, { recursive: true })
  writeFileSync(join(piDir, "auth.json"), JSON.stringify({ commandcode: { type: "oauth", access: "user_pi" } }))
  writeFileSync(join(ompDir, "auth.json"), JSON.stringify({ commandcode: { type: "oauth", access: "user_omp" } }))
  assertEqual(
    getConfiguredApiKey({ env: {}, homeDir: () => home, agentDir: piDir }),
    "user_pi",
    "pi host resolves its own auth file first",
  )
  assertEqual(
    getConfiguredApiKey({ env: {}, homeDir: () => home, agentDir: ompDir }),
    "user_omp",
    "omp host resolves its own auth file first",
  )
  assertEqual(
    getConfiguredApiKey({ env: {}, homeDir: () => home }),
    "user_pi",
    "without agentDir the pi order applies",
  )
  assertEqual(
    getConfiguredApiKey({ env: { COMMAND_CODE_API_KEY: "user_env3" }, homeDir: () => home, agentDir: ompDir }),
    "user_omp",
    "omp's own auth store beats an ambient env key",
  )
  assertEqual(
    getConfiguredApiKey({ env: { COMMANDCODE_API_KEY: "user_env4" }, homeDir: () => home, agentDir: ompDir, authPaths: [] }),
    "user_env4",
    "omp falls back to the env key when no auth file carries one",
  )
  rmSync(join(ompDir, "auth.json"))
  assertEqual(
    getConfiguredApiKey({ env: {}, homeDir: () => home, agentDir: ompDir }),
    "user_pi",
    "host without its own key falls back to the other host's file",
  )
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(join(cliDir, "auth.json"), JSON.stringify({ apiKey: "user_cli" }))
  assertEqual(
    getConfiguredApiKey({ env: {}, homeDir: () => home, agentDir: ompDir }),
    "user_cli",
    "cmd CLI auth file outranks both host files",
  )
} finally {
  rmSync(hostHome, { recursive: true, force: true })
}

// validateApiKey via injected fetch
let calls = 0
const fetchOk = async (input: string | URL | Request) => {
  calls += 1
  const url = String(input)
  assert(url.endsWith("/alpha/whoami"), "validation hits /alpha/whoami")
  return jsonResponse({ ok: true })
}
await validateApiKey("user_valid", { fetchImpl: fetchOk as typeof fetch })
assertEqual(calls, 1, "validateApiKey called the endpoint once")

const fetch401 = async () => jsonResponse({}, { status: 401 })
let threw = false
try {
  await validateApiKey("user_bad", { fetchImpl: fetch401 as typeof fetch })
} catch (error) {
  threw = error instanceof Error && error.message.includes("Invalid Command Code API key")
}
assert(threw, "401 produces an invalid-key error")

console.log("test-auth: all assertions passed")
