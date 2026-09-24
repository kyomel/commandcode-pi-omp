import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { CATALOG_META, type CatalogMeta } from "./catalog-meta.ts"

export const DEFAULT_PROVIDER_API_BASE = "https://api.commandcode.ai/provider/v1"
export const DEFAULT_MODELS_URL = `${DEFAULT_PROVIDER_API_BASE}/models`
export const DEFAULT_MODELS_TIMEOUT_MS = 10_000

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
const MODEL_CACHE_VERSION = 2
const LEGACY_MODEL_CACHE_VERSION = 1

export type CommandCodeApi = "openai-completions" | "anthropic-messages"
export type CommandCodeInput = "text" | "image"

export interface CommandCodeModel {
  id: string
  name: string
  api: CommandCodeApi
  reasoning: boolean
  /** Selectable reasoning efforts from the official CLI registry; empty when adaptive or unsupported. */
  efforts: readonly string[]
  input: readonly CommandCodeInput[]
  contextWindow: number
  maxTokens: number
  /** Cheapest public plan that serves the model, e.g. "Go and above", "Max". */
  minPlan?: string
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Pi thinking levels, ordered. "off" is implicit and never mapped. */
const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number]

export function thinkingLevelMapForEfforts(
  efforts: readonly string[],
): Partial<Record<PiThinkingLevel, string | null>> {
  const map: Partial<Record<PiThinkingLevel, string | null>> = {}
  for (const level of PI_THINKING_LEVELS) {
    map[level] = efforts.includes(level) ? level : null
  }
  return map
}

export function apiForModelId(id: string): CommandCodeApi {
  return id.startsWith("claude-") ? "anthropic-messages" : "openai-completions"
}

/**
 * pi's anthropic-messages stream appends `/v1/messages` itself, so the base URL
 * for that API must drop the documented `/provider/v1` suffix. OpenAI-shaped
 * models keep `/provider/v1` because the client appends `/chat/completions`.
 */
export function baseUrlForModel(apiBase: string, api: CommandCodeApi): string {
  const normalized = apiBase.replace(/\/+$/g, "")
  if (api !== "anthropic-messages") return normalized
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized
}

/** Display name with plan gating visible: GOAT-and-below models stay plain. */
export function displayName(name: string, minPlan: string | undefined): string {
  if (!minPlan || minPlan === "Go and above" || minPlan === "GOAT and above") {
    return `${name} (CC)`
  }
  if (minPlan === "Pro and above") return `${name} (CC · Pro+)`
  if (minPlan === "Max") return `${name} (CC · Max)`
  return `${name} (CC · ${minPlan})`
}

function apiFromSupportedEndpoints(id: string, endpoints: readonly string[]): CommandCodeApi {
  if (endpoints.includes("/messages")) return "anthropic-messages"
  return apiForModelId(id)
}

function decorateModel(
  id: string,
  name: string,
  api: CommandCodeApi,
  contextLength: number,
): CommandCodeModel {
  const meta: CatalogMeta | undefined = CATALOG_META[id]
  const reasoning = meta?.reasoning ?? false
  const efforts = meta && !meta.adaptive ? meta.efforts : []
  const contextWindow = meta?.contextWindow ?? contextLength
  const maxTokens = Math.min(contextWindow, meta?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)
  return {
    id,
    name: displayName(name, meta?.minPlan),
    api,
    reasoning,
    efforts,
    input: meta?.input ?? ["text"],
    contextWindow,
    maxTokens,
    ...(meta?.minPlan ? { minPlan: meta.minPlan } : {}),
    cost: meta?.cost ?? ZERO_COST,
  }
}

interface ApiModel {
  id: string
  name: string
  contextLength: number
  supportedEndpoints: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string`)
  }
  return value
}

function positiveNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected ${key} to be a positive number`)
  }
  return value
}

function stringListField(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function parseApiModel(value: unknown): ApiModel {
  if (!isRecord(value)) throw new Error("Expected model entry to be an object")
  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    contextLength: positiveNumberField(value, "context_length"),
    supportedEndpoints: stringListField(value, "supported_endpoints"),
  }
}


/**
 * Cache entries carry only raw catalog fields. Decoration (reasoning, efforts,
 * input modalities, min plan, pricing, display suffix) is always re-derived
 * from the bundled CATALOG_META at load time, so any writer that can produce
 * id/name/api/contextLength stays compatible - including refresh-models.mjs.
 */
function parseCachedModel(value: unknown): CommandCodeModel {
  if (!isRecord(value)) throw new Error("Expected cached model entry to be an object")
  const id = stringField(value, "id")
  const name =
    typeof value.name === "string" && value.name.length > 0
      ? value.name.replace(/\s*\(CC[^)]*\)\s*$/, "")
      : id
  const api = value.api === "anthropic-messages" ? "anthropic-messages" : apiForModelId(id)
  const contextLength =
    typeof value.contextLength === "number" && Number.isFinite(value.contextLength) && value.contextLength > 0
      ? value.contextLength
      : positiveNumberField(value, "contextWindow")
  return decorateModel(id, name, api, contextLength)
}

function requireModels(models: readonly CommandCodeModel[]): readonly CommandCodeModel[] {
  if (models.length === 0) throw new Error("Command Code returned an empty model catalog")
  return models
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException("The operation was aborted", "AbortError")
}

function configuredTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_MODELS_TIMEOUT_MS
}

export function getModelsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COMMANDCODE_MODELS_TIMEOUT_MS
  if (!raw) return DEFAULT_MODELS_TIMEOUT_MS
  return configuredTimeoutMs(Number(raw))
}

export class ModelDiscoveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command Code model discovery timed out after ${timeoutMs}ms`)
    this.name = "ModelDiscoveryTimeoutError"
  }
}

function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let onExternalAbort: (() => void) | undefined

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (onExternalAbort && externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort)
      }
    }
    const resolveOnce = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = (reason: unknown) => {
      const error = abortError(reason)
      controller.abort(error)
      rejectOnce(error)
    }

    if (externalSignal?.aborted) {
      abort(externalSignal.reason)
      return
    }
    onExternalAbort = () => abort(externalSignal?.reason)
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
    timer = setTimeout(() => abort(new ModelDiscoveryTimeoutError(timeoutMs)), timeoutMs)

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(resolveOnce, rejectOnce)
  })
}

export function commandCodeModelsFromApiResponse(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new Error("Expected models response to be an object")
  if (value.object !== "list") throw new Error("Expected models response object to be 'list'")
  const data = value.data
  if (!Array.isArray(data)) throw new Error("Expected models response data to be an array")
  return data.map(parseApiModel).map((model) =>
    decorateModel(
      model.id,
      model.name,
      apiFromSupportedEndpoints(model.id, model.supportedEndpoints),
      model.contextLength,
    ),
  )
}

export function commandCodeModelsFromCache(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new Error("Expected model cache to be an object")
  if (value.version !== MODEL_CACHE_VERSION && value.version !== LEGACY_MODEL_CACHE_VERSION) {
    throw new Error(`Expected model cache version ${MODEL_CACHE_VERSION} or ${LEGACY_MODEL_CACHE_VERSION}`)
  }
  if (!Array.isArray(value.models)) throw new Error("Expected cached models to be an array")
  return requireModels(value.models.map(parseCachedModel))
}

export interface FetchCommandCodeModelsOptions {
  url?: string
  fetchImpl?: typeof fetch
  /**
   * Optional Command Code API key. The models endpoint filters the catalog to
   * the authenticated account's plan (e.g. GOAT); without it the public
   * catalog is returned.
   */
  apiKey?: string | undefined
  signal?: AbortSignal
  timeoutMs?: number
}

export async function fetchCommandCodeModels(
  options: FetchCommandCodeModelsOptions = {},
): Promise<readonly CommandCodeModel[]> {
  const url = options.url ?? DEFAULT_MODELS_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const headers: Record<string, string> = { accept: "application/json" }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`
  const body: unknown = await runWithTimeout(
    async (signal) => {
      const response = await fetchImpl(url, { headers, signal })
      if (!response.ok) {
        throw new Error(
          `Failed to fetch Command Code models: ${response.status} ${response.statusText}`,
        )
      }
      return (await response.json()) as unknown
    },
    configuredTimeoutMs(options.timeoutMs),
    options.signal,
  )
  return requireModels(commandCodeModelsFromApiResponse(body))
}

async function readCommandCodeModelsCache(cachePath: string): Promise<readonly CommandCodeModel[]> {
  const contents = await readFile(cachePath, "utf-8")
  return commandCodeModelsFromCache(JSON.parse(contents))
}

/** Reads the cached catalog without touching the network; empty when missing or invalid. */
export async function loadCachedCommandCodeModels(
  cachePath: string,
): Promise<readonly CommandCodeModel[]> {
  try {
    return await readCommandCodeModelsCache(cachePath)
  } catch {
    return []
  }
}

export function serializeCommandCodeModelsCache(models: readonly CommandCodeModel[]): string {
  const payload = {
    version: MODEL_CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    models: models.map((model) => ({
      id: model.id,
      name: model.name.replace(/\s*\(CC[^)]*\)\s*$/, ""),
      api: model.api,
      contextLength: model.contextWindow,
    })),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

async function writeCommandCodeModelsCache(
  cachePath: string,
  models: readonly CommandCodeModel[],
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  const temporaryPath = `${cachePath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, serializeCommandCodeModelsCache(models), {
      encoding: "utf-8",
      mode: 0o600,
    })
    await rename(temporaryPath, cachePath)
  } finally {
    try {
      await rm(temporaryPath, { force: true })
    } catch {
      // Best-effort cleanup must not hide the original cache write error.
    }
  }
}

export interface LoadCommandCodeModelsOptions extends FetchCommandCodeModelsOptions {
  cachePath: string
}

export interface LoadCommandCodeModelsResult {
  models: readonly CommandCodeModel[]
  source: "live" | "cache" | "empty"
  warning?: string | undefined
}

export async function loadCommandCodeModels(
  options: LoadCommandCodeModelsOptions,
): Promise<LoadCommandCodeModelsResult> {
  const cachePath = options.cachePath
  try {
    const models = await fetchCommandCodeModels(options)
    try {
      await writeCommandCodeModelsCache(cachePath, models)
      return { models, source: "live" }
    } catch (error) {
      return {
        models,
        source: "live",
        warning: `Loaded the live Command Code model catalog but could not update ${cachePath}: ${errorMessage(error)}`,
      }
    }
  } catch (liveError) {
    if (options.signal?.aborted) throw abortError(options.signal.reason ?? liveError)
    try {
      const models = await readCommandCodeModelsCache(cachePath)
      return {
        models,
        source: "cache",
        warning: `Could not refresh the Command Code model catalog (${errorMessage(liveError)}). Using the cached catalog from ${cachePath}.`,
      }
    } catch (cacheError) {
      return {
        models: [],
        source: "empty",
        warning: `Could not refresh the Command Code model catalog (${errorMessage(liveError)}), and no valid cached catalog is available at ${cachePath} (${errorMessage(cacheError)}). Command Code models stay unavailable until /commandcode-refresh succeeds.`,
      }
    }
  }
}
