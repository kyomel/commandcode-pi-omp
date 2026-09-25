#!/usr/bin/env node
/**
 * Refresh the Command Code model cache used by the pi-omp-cc extension.
 *
 * Fetches the documented catalog GET /provider/v1/models and writes the
 * per-host cache (`<agent-dir>/commandcode-models.json`) for pi and Oh My Pi.
 * When a Command Code API key is configured (env or a host auth.json) the
 * request is authenticated, so the catalog reflects the account's plan
 * (e.g. GOAT). The extension re-decorates these raw entries from its bundled
 * catalog meta on load, so this script needs no metadata of its own.
 *
 * Intended wiring: run manually when you need to refresh the catalog without
 * starting a session. The extension also self-refreshes on every session
 * start, so this script is only a manual trigger.
 *
 * Usage:
 *   node scripts/refresh-models.mjs                 # all detected agent dirs
 *   node scripts/refresh-models.mjs --pi            # only ~/.pi/agent
 *   node scripts/refresh-models.mjs --omp           # only ~/.omp/agent
 *   node scripts/refresh-models.mjs --agent-dir DIR # custom dir
 *   node scripts/refresh-models.mjs --url URL --timeout-ms 15000
 */

import { existsSync, readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_URL = "https://api.commandcode.ai/provider/v1/models"
const DEFAULT_TIMEOUT_MS = 10_000
const CACHE_VERSION = 2

/**
 * Resolve a Command Code API key the same way the extension does:
 * env first, then ~/.commandcode/auth.json and the hosts' auth.json files.
 * The target host's own auth file outranks the other host's, matching the
 * extension's per-host resolution. Returns undefined when nothing is
 * configured; the catalog fetch then runs anonymously and returns the
 * public list.
 */
function resolveApiKey(agentDir) {
  if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY
  if (process.env.COMMANDCODE_API_KEY) return process.env.COMMANDCODE_API_KEY
  const home = homedir()
  const commandcode = join(home, ".commandcode", "auth.json")
  const pi = join(home, ".pi", "agent", "auth.json")
  const omp = join(home, ".omp", "agent", "auth.json")
  const authPaths = agentDir === join(home, ".omp", "agent")
    ? [commandcode, omp, pi]
    : [commandcode, pi, omp]
  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue
      const parsed = JSON.parse(readFileSync(authPath, "utf-8"))
      if (!parsed || typeof parsed !== "object") continue
      if (typeof parsed.apiKey === "string" && parsed.apiKey) return parsed.apiKey
      for (const name of ["commandcode", "command-code"]) {
        const entry = parsed[name]
        if (typeof entry === "string" && entry) return entry
        if (entry && typeof entry === "object") {
          const key = typeof entry.access === "string" && entry.access
            ? entry.access
            : typeof entry.key === "string" && entry.key
              ? entry.key
              : undefined
          if (key) return key
        }
      }
    } catch {
      // Ignore malformed or unreadable auth files.
    }
  }
  return undefined
}

function parseArgs(argv) {
  const args = { dirs: [], url: DEFAULT_URL, timeoutMs: DEFAULT_TIMEOUT_MS }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--pi") args.dirs.push(join(homedir(), ".pi", "agent"))
    else if (arg === "--omp") args.dirs.push(join(homedir(), ".omp", "agent"))
    else if (arg === "--agent-dir") args.dirs.push(argv[++i])
    else if (arg === "--url") args.url = argv[++i]
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i])
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: refresh-models.mjs [--pi] [--omp] [--agent-dir DIR] [--url URL] [--timeout-ms N]")
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  if (args.dirs.length === 0) {
    const home = homedir()
    for (const dir of [join(home, ".pi", "agent"), join(home, ".omp", "agent")]) {
      if (existsSync(dir)) args.dirs.push(dir)
    }
    if (args.dirs.length === 0) args.dirs.push(join(home, ".pi", "agent"))
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = DEFAULT_TIMEOUT_MS
  return args
}

async function fetchModels(url, timeoutMs, apiKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  const headers = { accept: "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) {
      throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
    }
    const body = await response.json()
    if (body?.object !== "list" || !Array.isArray(body.data)) {
      throw new Error("unexpected models response shape")
    }
    return body.data.map((model) => ({
      id: model.id,
      name: model.name,
      api: Array.isArray(model.supported_endpoints) && model.supported_endpoints.includes("/messages")
        ? "anthropic-messages"
        : "openai-completions",
      contextLength: model.context_length,
    }))
  } finally {
    clearTimeout(timer)
  }
}

async function writeCache(dir, models) {
  const cachePath = join(dir, "commandcode-models.json")
  await mkdir(dirname(cachePath), { recursive: true })
  const tmp = `${cachePath}.${process.pid}.tmp`
  const payload = { version: CACHE_VERSION, fetchedAt: new Date().toISOString(), models }
  try {
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
    await rename(tmp, cachePath)
  } finally {
    await rm(tmp, { force: true }).catch(() => { })
  }
  return cachePath
}

const args = parseArgs(process.argv.slice(2))
try {
  let failures = 0
  const catalogs = new Map()
  for (const dir of args.dirs) {
    try {
      const apiKey = resolveApiKey(dir)
      const cacheKey = apiKey ?? "anonymous"
      if (!catalogs.has(cacheKey)) {
        const models = await fetchModels(args.url, args.timeoutMs, apiKey)
        catalogs.set(cacheKey, models)
        console.log(
          `fetched ${models.length} Command Code models from ${args.url} (${apiKey ? "authenticated" : "anonymous"})`,
        )
      }
      const path = await writeCache(dir, catalogs.get(cacheKey))
      console.log(`wrote ${path}`)
    } catch (error) {
      failures += 1
      console.error(`failed to refresh cache in ${dir}: ${error instanceof Error ? error.message : error}`)
    }
  }
  process.exit(failures === args.dirs.length ? 1 : 0)
} catch (error) {
  console.error(`model refresh failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
