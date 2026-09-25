/**
 * Command Code provider for pi and Oh My Pi, built for GOAT subscriptions.
 *
 * Unofficial community package. Not affiliated with, endorsed by, or supported
 * by Command Code. Uses the documented Provider API with the user's own key.
 *
 * Uses Command Code's documented Provider API:
 *   https://api.commandcode.ai/provider/v1
 *
 * - Chat: POST /provider/v1/chat/completions (OpenAI shape)
 * - Claude models: POST /provider/v1/messages (Anthropic shape)
 * - Catalog: GET /provider/v1/models (public, cached per agent dir)
 *
 * Every plan except Go has Provider API access, so GOAT keys stream through
 * these endpoints directly via the host's native API implementations - no
 * custom wire protocol is required.
 */

import * as piAiCompat from "@earendil-works/pi-ai/compat"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  apiKeyFromCredential,
  getApiKey,
  getConfiguredApiKey,
  login,
  refreshToken,
} from "./src/auth.ts"
import {
  baseUrlForModel,
  DEFAULT_PROVIDER_API_BASE,
  getModelsTimeoutMs,
  loadCachedCommandCodeModels,
  loadCommandCodeModels,
  thinkingLevelMapForEfforts,
  type CommandCodeModel,
} from "./src/models.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"

const DEFAULT_MODELS_URL = `${DEFAULT_PROVIDER_API_BASE}/models`

/**
 * The `apiKey` handed to `registerProvider` means different things per host.
 *
 * pi parses `$COMMAND_CODE_API_KEY` as an env template: unresolved means
 * "not configured", so `/login` credentials take over and the API-key auth
 * method stays registered next to OAuth.
 *
 * Oh My Pi has no template notion: an unresolved value stays a literal config
 * override that shadows its `/login` credential store and would be sent
 * verbatim as `Authorization: Bearer $COMMAND_CODE_API_KEY`. There, omit
 * `apiKey` unless a real key is configured; OMP then reads env keys and stored
 * credentials itself.
 *
 * Hosts are told apart by the `registerApiProvider` probe: pi exports it from
 * `@earendil-works/pi-ai/compat`, OMP's mapped compat module does not.
 */
function isPiHost(): boolean {
  const register = (piAiCompat as { registerApiProvider?: unknown }).registerApiProvider
  return typeof register === "function"
}

/**
 * Key resolution for the running host: env, then the `cmd` CLI auth file,
 * then this host's own auth.json, then the other host's (see src/auth.ts).
 */
function hostConfiguredApiKey(): string | undefined {
  return getConfiguredApiKey({ agentDir: getAgentDir() })
}

function providerApiKey(): string | undefined {
  const configured = hostConfiguredApiKey()
  if (configured) return configured
  return isPiHost() ? "$COMMAND_CODE_API_KEY" : undefined
}

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
}

const PACKAGE_NAME = "@kyomel/pi-omp-cc"
const PACKAGE_DIR_NAME = "pi-omp-cc"

/** pi records installed extensions in `<agent-dir>/settings.json` `packages`. */
function piHasPlugin(home: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(home, ".pi", "agent", "settings.json"), "utf-8"),
    )
    if (typeof parsed !== "object" || parsed === null) return false
    const packages = (parsed as { packages?: unknown }).packages
    if (!Array.isArray(packages)) return false
    return packages.some((entry) => {
      if (typeof entry === "string") {
        return entry.includes(PACKAGE_NAME) || entry.includes(PACKAGE_DIR_NAME)
      }
      if (typeof entry === "object" && entry !== null) {
        const source = (entry as { source?: unknown }).source
        return (
          typeof source === "string" &&
          (source.includes(PACKAGE_NAME) || source.includes(PACKAGE_DIR_NAME))
        )
      }
      return false
    })
  } catch {
    return false
  }
}

/** OMP links or installs plugins under `~/.omp/plugins/node_modules`. */
function ompHasPlugin(home: string): boolean {
  return existsSync(join(home, ".omp", "plugins", "node_modules", "@kyomel", PACKAGE_DIR_NAME))
}

/**
 * Cache paths of the other coding agents that run this plugin. A successful
 * refresh mirrors the catalog there, so updating models in one agent updates
 * the model list of every agent the plugin is installed in.
 */
function mirrorCachePaths(currentAgentDir: string): string[] {
  const home = homedir()
  const paths: string[] = []
  const piDir = join(home, ".pi", "agent")
  const ompDir = join(home, ".omp", "agent")
  if (currentAgentDir !== piDir && piHasPlugin(home)) {
    paths.push(join(piDir, "commandcode-models.json"))
  }
  if (currentAgentDir !== ompDir && ompHasPlugin(home)) {
    paths.push(join(ompDir, "commandcode-models.json"))
  }
  return paths
}

/**
 * Oh My Pi reads its own `thinking` capability surface on a model
 * (`ProviderModelConfig.thinking`); it does not read pi's `thinkingLevelMap`.
 * The effort tokens are the same, so the Command Code catalog efforts are
 * forwarded verbatim on that host.
 */
interface OmpThinkingConfig {
  mode: "effort"
  efforts: readonly string[]
}

type HostProviderModelConfig = ProviderModelConfig & { thinking?: OmpThinkingConfig }

function toProviderModels(
  models: readonly CommandCodeModel[],
  apiBase: string,
  ompHost: boolean,
): HostProviderModelConfig[] {
  const headers = commandCodeHeaders()
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: baseUrlForModel(apiBase, model.api),
    reasoning: model.reasoning,
    ...(ompHost
      ? model.reasoning && model.efforts.length > 0
        ? { thinking: { mode: "effort", efforts: [...model.efforts] } }
        : {}
      : model.reasoning
        ? { thinkingLevelMap: thinkingLevelMapForEfforts(model.efforts) }
        : {}),
    input: [...model.input],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(headers ? { headers } : {}),
  }))
}

interface RefreshContext {
  modelsUrl: string
  cachePath: string
  mirrorPaths: readonly string[]
  timeoutMs: number
}

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
  refresh: RefreshContext,
  ompHost: boolean,
): ProviderConfig {
  const apiKey = providerApiKey()
  const headers = commandCodeHeaders()
  return {
    name: "Command Code",
    baseUrl: apiBase,
    ...(apiKey ? { apiKey } : {}),
    api: "openai-completions",
    authHeader: true,
    ...(headers ? { headers } : {}),
    oauth: {
      name: "Command Code",
      isSubscription: true,
      login,
      refreshToken,
      getApiKey,
    },
    models: toProviderModels(models, apiBase, ompHost),
    refreshModels: async (context) => {
      if (!context.allowNetwork) return toProviderModels(models, apiBase, ompHost)
      const key = apiKeyFromCredential(context.credential) ?? hostConfiguredApiKey()
      const loaded = await loadCommandCodeModels({
        url: refresh.modelsUrl,
        cachePath: refresh.cachePath,
        mirrorPaths: refresh.mirrorPaths,
        timeoutMs: refresh.timeoutMs,
        apiKey: key,
        signal: context.signal,
      })
      const next = loaded.models.length > 0 ? loaded.models : models
      return toProviderModels(next, apiBase, ompHost)
    },
  }
}

export default async function (pi: ExtensionAPI) {
  // Sessions stored against an older custom-API Command Code registration keep
  // a stale `model.api`. Rebind the selection to the registered native API
  // before the first turn so migrated sessions keep working.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model?.provider !== "commandcode") return
    const registered = ctx.modelRegistry.find("commandcode", ctx.model.id)
    if (registered && ctx.model.api !== registered.api) {
      await pi.setModel(registered)
    }
  })

  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  const ompHost = !isPiHost()
  const mirrorPaths = mirrorCachePaths(getAgentDir())

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: (signal) =>
      loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        mirrorPaths,
        timeoutMs: modelsTimeoutMs,
        apiKey: hostConfiguredApiKey(),
        signal,
      }),
    loadCachedModels: () => loadCachedCommandCodeModels(modelsCachePath),
    createProviderConfig: (models) =>
      createProviderConfig(
        models,
        apiBase,
        { modelsUrl, cachePath: modelsCachePath, mirrorPaths, timeoutMs: modelsTimeoutMs },
        ompHost,
      ),
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
