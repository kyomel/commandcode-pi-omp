/**
 * Command Code provider for pi and Oh My Pi, built for GOAT subscriptions.
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

function providerApiKey(): string | undefined {
  const configured = getConfiguredApiKey()
  if (configured) return configured
  return isPiHost() ? "$COMMAND_CODE_API_KEY" : undefined
}

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
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
      const key = apiKeyFromCredential(context.credential) ?? getConfiguredApiKey()
      const loaded = await loadCommandCodeModels({
        url: refresh.modelsUrl,
        cachePath: refresh.cachePath,
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

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: (signal) =>
      loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        timeoutMs: modelsTimeoutMs,
        apiKey: getConfiguredApiKey(),
        signal,
      }),
    loadCachedModels: () => loadCachedCommandCodeModels(modelsCachePath),
    createProviderConfig: (models) =>
      createProviderConfig(
        models,
        apiBase,
        { modelsUrl, cachePath: modelsCachePath, timeoutMs: modelsTimeoutMs },
        ompHost,
      ),
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
