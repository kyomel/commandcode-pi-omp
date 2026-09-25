/**
 * Command Code authentication for pi/OMP `/login`.
 *
 * Two documented flows:
 * 1. Browser login opens Command Code Studio; the site POSTs the API key back
 *    to a localhost callback server.
 * 2. Direct API key paste (keys are created in Studio > API Keys).
 *
 * Command Code API keys do not expire, so they are stored as OAuth credentials
 * with a far-future expiry. The same key authenticates the CLI subscription
 * and the Provider API.
 */

import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai"

import { startAuthServer } from "./auth-server.ts"

export type { OAuthCredentials, OAuthLoginCallbacks }

const STUDIO_BASE_URL = "https://commandcode.ai"
const DEFAULT_API_BASE = "https://api.commandcode.ai"
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000
const DEFAULT_AUTH_TIMEOUT_MS = 120_000

class AuthTimeoutError extends Error {
  constructor() {
    super("Browser authentication timed out")
    this.name = "AuthTimeoutError"
  }
}

function generateStateToken(): string {
  return randomBytes(32).toString("base64url")
}

function getAuthTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.COMMANDCODE_AUTH_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTH_TIMEOUT_MS
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuthTimeoutError()), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function credentialsFromApiKey(apiKey: string): OAuthCredentials {
  return { refresh: apiKey, access: apiKey, expires: Date.now() + TEN_YEARS_MS }
}

/** Remove terminal paste wrappers/control characters from a pasted key. */
export function sanitizeApiKey(input: string): string {
  const esc = String.fromCharCode(27)
  return Array.from(
    input
      .replaceAll(`${esc}[200~`, "")
      .replaceAll(`${esc}[201~`, "")
      .replaceAll("[200~", "")
      .replaceAll("[201~", ""),
  )
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join("")
    .trim()
}

/** Validates a key against the documented `GET /alpha/whoami` endpoint. */
export async function validateApiKey(
  apiKey: string,
  options: { fetchImpl?: typeof fetch; apiBase?: string } = {},
): Promise<void> {
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${options.apiBase ?? DEFAULT_API_BASE}/alpha/whoami`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
  } catch (error) {
    throw new Error(
      `Could not validate the Command Code API key: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (response.status === 401) throw new Error("Invalid Command Code API key")
  if (!response.ok) {
    throw new Error(`Could not validate the Command Code API key (${response.status})`)
  }
}

async function promptForApiKey(
  callbacks: OAuthLoginCallbacks,
  message: string,
): Promise<OAuthCredentials> {
  const apiKey = sanitizeApiKey(await callbacks.onPrompt({ message }))
  if (!apiKey) throw new Error("No Command Code API key provided")
  await validateApiKey(apiKey)
  return credentialsFromApiKey(apiKey)
}

type LoginChoice = { type: "browser" } | { type: "prompt" } | { type: "apiKey"; apiKey: string }

async function chooseLoginFlow(callbacks: OAuthLoginCallbacks): Promise<LoginChoice> {
  const input = sanitizeApiKey(
    await callbacks.onPrompt({
      message:
        "Command Code login: press Enter for browser login, type 'key' to paste an API key, or paste the API key directly:",
    }),
  )
  const normalized = input.toLowerCase()
  if (!input || normalized === "1" || normalized === "b" || normalized === "browser") {
    return { type: "browser" }
  }
  if (
    normalized === "2" ||
    normalized === "k" ||
    normalized === "key" ||
    normalized === "api" ||
    normalized === "paste"
  ) {
    return { type: "prompt" }
  }
  return { type: "apiKey", apiKey: input }
}

async function browserLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const stateToken = generateStateToken()
  let authServer: Awaited<ReturnType<typeof startAuthServer>>
  try {
    authServer = await startAuthServer({ expectedState: stateToken })
  } catch {
    return promptForApiKey(callbacks, "Could not start browser auth. Paste your Command Code API key:")
  }

  const callbackUrl = `http://localhost:${authServer.port}/callback`
  const authUrl = `${STUDIO_BASE_URL}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(stateToken)}`
  callbacks.onAuth({ url: authUrl })

  try {
    const callback = await withTimeout(authServer.waitForCallback, getAuthTimeoutMs())
    return credentialsFromApiKey(callback.apiKey)
  } catch (error) {
    if (error instanceof AuthTimeoutError) {
      return promptForApiKey(
        callbacks,
        "Automatic transfer failed or timed out. Paste your Command Code API key:",
      )
    }
    throw error
  } finally {
    authServer.server.close()
  }
}

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const choice = await chooseLoginFlow(callbacks)
  if (choice.type === "apiKey") {
    await validateApiKey(choice.apiKey)
    return credentialsFromApiKey(choice.apiKey)
  }
  if (choice.type === "prompt") {
    return promptForApiKey(callbacks, "Paste your Command Code API key:")
  }
  return browserLogin(callbacks)
}

/** Keys do not expire; "refresh" just re-wraps the stored key. */
export async function refreshToken(
  credentials: OAuthCredentials,
  _signal?: AbortSignal,
): Promise<OAuthCredentials> {
  return credentialsFromApiKey(credentials.refresh)
}

export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access
}

// ---------------------------------------------------------------------------
// Configured-key resolution (env + auth files), shared by both hosts.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Extract the bearer key from a host `Credential` or an auth.json entry. */
export function apiKeyFromCredential(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (stringValue(value.type) === "oauth") return stringValue(value.access)
  if (stringValue(value.type) === "api_key" || stringValue(value.type) === "api") {
    return stringValue(value.key)
  }
  return stringValue(value.access) ?? stringValue(value.key)
}

/**
 * Auth files, most specific first. The running host's own file outranks the
 * other host's file, so pi and OMP can hold different Command Code keys.
 * `agentDir` is the current host's agent directory (pi `~/.pi/agent`,
 * OMP `~/.omp/agent`); without it the pi order applies.
 */
function defaultAuthPaths(home: string, agentDir?: string): readonly string[] {
  const commandCode = join(home, ".commandcode", "auth.json")
  const pi = join(home, ".pi", "agent", "auth.json")
  const omp = join(home, ".omp", "agent", "auth.json")
  if (agentDir === join(home, ".omp", "agent")) return [commandCode, omp, pi]
  return [commandCode, pi, omp]
}

/** Read one auth file and extract its Command Code key, if any. */
function readAuthFileKey(authPath: string): string | undefined {
  try {
    if (!existsSync(authPath)) return undefined
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"))
    if (!isRecord(parsed)) return undefined
    const direct = stringValue(parsed.apiKey)
    if (direct) return direct
    for (const key of ["commandcode", "command-code"] as const) {
      const value = parsed[key]
      const credential = apiKeyFromCredential(value) ?? stringValue(value)
      if (credential) return credential
    }
    return undefined
  } catch {
    // Ignore malformed or unreadable auth files.
    return undefined
  }
}

function firstAuthFileKey(authPaths: readonly string[]): string | undefined {
  for (const authPath of authPaths) {
    const key = readAuthFileKey(authPath)
    if (key) return key
  }
  return undefined
}

/**
 * Resolve a Command Code API key from the environment and the auth files.
 *
 * Precedence is host-specific. pi treats `COMMAND_CODE_API_KEY` as an env
 * template, so an ambient env key wins there. Oh My Pi has no such template:
 * a raw env key becomes a literal `apiKey` override that shadows its `/login`
 * credential store (see index.ts). So for OMP the persistent per-host auth
 * files win over an ambient env key. That keeps a stale `COMMANDCODE_API_KEY`
 * (a leftover from an old `~/.env`) from bricking the stored per-host key. For
 * OMP the env key is still the fallback when no auth file carries a key.
 */
export function getConfiguredApiKey(
  options: {
    env?: NodeJS.ProcessEnv
    authPaths?: readonly string[]
    homeDir?: () => string
    agentDir?: string
  } = {},
): string | undefined {
  const env = options.env ?? process.env
  const envKey = stringValue(env.COMMAND_CODE_API_KEY) ?? stringValue(env.COMMANDCODE_API_KEY)
  const home = options.homeDir?.() ?? homedir()
  const authPaths = options.authPaths ?? defaultAuthPaths(home, options.agentDir)

  if (options.agentDir === join(home, ".omp", "agent")) {
    return firstAuthFileKey(authPaths) ?? envKey
  }
  return envKey ?? firstAuthFileKey(authPaths)
}
