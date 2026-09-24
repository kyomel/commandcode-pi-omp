import type { CommandCodeModel, LoadCommandCodeModelsResult } from "../src/models.ts"
import {
  createCommandCodeRuntime,
  formatCommandCodeStatus,
  redactDiagnosticText,
  type CommandCodeCommandContext,
  type CommandCodeRuntimeApi,
} from "../src/runtime.ts"
import { assert, assertEqual } from "./helpers.ts"

function makeModel(id: string): CommandCodeModel {
  return {
    id,
    name: `${id} (CC)`,
    api: "openai-completions",
    reasoning: false,
    efforts: [],
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

interface FakeConfig {
  models: readonly CommandCodeModel[]
}

function fakeHost() {
  const registrations: FakeConfig[] = []
  const commands = new Map<string, (args: string, ctx: CommandCodeCommandContext) => Promise<void>>()
  const notifications: { message: string; type?: string | undefined }[] = []
  const api: CommandCodeRuntimeApi<FakeConfig, CommandCodeCommandContext> = {
    registerProvider(name, config) {
      assertEqual(name, "commandcode", "registers the commandcode provider")
      registrations.push(config)
    },
    registerCommand(name, options) {
      commands.set(name, options.handler)
    },
  }
  const ctx: CommandCodeCommandContext = {
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  }
  return { api, commands, ctx, notifications, registrations }
}

// initialize with cache: registers cached then refreshes in background
{
  const { api, registrations } = fakeHost()
  const cached = [makeModel("cached-model")]
  const live = [makeModel("live-model"), makeModel("live-model-2")]
  const runtime = createCommandCodeRuntime(api, {
    endpoint: "https://api.commandcode.ai/provider/v1/models",
    cachePath: "/tmp/cache.json",
    loadModels: async () => ({ models: live, source: "live" } as LoadCommandCodeModelsResult),
    loadCachedModels: async () => cached,
    createProviderConfig: (models) => ({ models }),
  })
  await runtime.initialize()
  // Give the background refresh a tick to settle.
  await runtime.refresh()
  assertEqual(registrations.length, 2, "cached registers first, live refresh re-registers")
  assertEqual(registrations[0]!.models[0]!.id, "cached-model", "cached catalog registered first")
  assertEqual(registrations[1]!.models.length, 2, "live catalog registered after refresh")
  const status = runtime.getStatus()
  assertEqual(status.source, "live", "status reports live after refresh")
  assertEqual(status.modelCount, 2, "status reports live count")
}

// initialize without cache: awaits live refresh
{
  const { api, registrations } = fakeHost()
  const runtime = createCommandCodeRuntime(api, {
    endpoint: "https://api.commandcode.ai/provider/v1/models",
    cachePath: "/tmp/cache.json",
    loadModels: async () => ({ models: [makeModel("live")] , source: "live" } as LoadCommandCodeModelsResult),
    loadCachedModels: async () => [],
    createProviderConfig: (models) => ({ models }),
  })
  await runtime.initialize()
  assertEqual(registrations.length, 1, "no cache registers once live arrives")
  assertEqual(registrations[0]!.models[0]!.id, "live", "live catalog registered")
}

// failed refresh keeps the current catalog
{
  const { api, registrations, commands, ctx, notifications } = fakeHost()
  let call = 0
  const runtime = createCommandCodeRuntime(api, {
    endpoint: "https://api.commandcode.ai/provider/v1/models",
    cachePath: "/tmp/cache.json",
    loadModels: async () => {
      call += 1
      if (call === 1) return { models: [makeModel("live")], source: "live" }
      return { models: [], source: "empty", warning: "offline" }
    },
    loadCachedModels: async () => [],
    createProviderConfig: (models) => ({ models }),
  })
  await runtime.initialize()
  const handler = commands.get("commandcode-refresh")
  assert(handler !== undefined, "commandcode-refresh is registered")
  await handler("", ctx)
  assertEqual(registrations.length, 1, "failed refresh keeps the live registration untouched")
  assertEqual(runtime.getStatus().modelCount, 1, "last known catalog stays active")
  assert(notifications.some((n) => n.message.includes("unchanged")), "refresh failure notifies unchanged")
}

// concurrent refresh calls coalesce
{
  const { api } = fakeHost()
  let calls = 0
  const runtime = createCommandCodeRuntime(api, {
    endpoint: "https://api.commandcode.ai/provider/v1/models",
    cachePath: "/tmp/cache.json",
    loadModels: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { models: [makeModel("live")], source: "live" }
    },
    loadCachedModels: async () => [],
    createProviderConfig: (models) => ({ models }),
  })
  const [a, b] = await Promise.all([runtime.refresh(), runtime.refresh()])
  assertEqual(calls, 1, "overlapping refreshes coalesce into one fetch")
  assertEqual(a.modelCount, b.modelCount, "coalesced refresh returns the same result")
}

// status + redaction
{
  const status = formatCommandCodeStatus({
    source: "live",
    modelCount: 3,
    lastSuccess: 1700000000000,
    lastAttempt: 1700000000000,
    cachePath: "/tmp/cache.json",
    endpoint: "https://api.commandcode.ai/provider/v1/models?key=user_secret12345",
    refreshing: false,
    warning: "Bearer user_secret12345 failed",
  })
  assert(!status.includes("user_secret12345"), "status output redacts credentials")
  assert(status.includes("model count: 3"), "status includes model count")

  const redacted = redactDiagnosticText("Authorization: Bearer user_abcdef123 failed at https://api.commandcode.ai/x?key=user_abcdef123")
  assert(!redacted.includes("user_abcdef123"), "redaction strips user_ keys and bearer tokens")
}

console.log("test-runtime: all assertions passed")
