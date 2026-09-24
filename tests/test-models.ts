import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  apiForModelId,
  baseUrlForModel,
  commandCodeModelsFromApiResponse,
  commandCodeModelsFromCache,
  displayName,
  fetchCommandCodeModels,
  loadCachedCommandCodeModels,
  loadCommandCodeModels,
  serializeCommandCodeModelsCache,
  thinkingLevelMapForEfforts,
} from "../src/models.ts"
import { assert, assertDeepEqual, assertEqual, jsonResponse } from "./helpers.ts"

const LIVE_RESPONSE = {
  object: "list",
  data: [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      object: "model",
      owned_by: "command-code",
      context_length: 1000000,
      created: 1790244429,
      supported_endpoints: ["/messages"],
    },
    {
      id: "deepseek/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      object: "model",
      owned_by: "command-code",
      context_length: 1000000,
      created: 1790244429,
      supported_endpoints: ["/chat/completions", "/responses"],
    },
    {
      id: "new-brand-model",
      name: "Unseen Model",
      object: "model",
      owned_by: "command-code",
      context_length: 200000,
      created: 1790244429,
      supported_endpoints: ["/chat/completions"],
    },
  ],
}

const models = commandCodeModelsFromApiResponse(LIVE_RESPONSE)
assertEqual(models.length, 3, "parses all live models")

const claude = models[0]!
assertEqual(claude.api, "anthropic-messages", "supported_endpoints /messages maps to anthropic-messages")
assertEqual(claude.reasoning, true, "claude-sonnet-5 is reasoning-capable")
assert(claude.input.includes("image"), "claude-sonnet-5 accepts images from catalog meta")
assertEqual(claude.minPlan, "Pro and above", "minPlan comes from catalog meta")
assert(claude.name.includes("Pro+"), "plan-gated models show a Pro+ suffix")

const deepseek = models[1]!
assertEqual(deepseek.api, "openai-completions", "chat completions models use openai-completions")
assertEqual(deepseek.reasoning, true, "deepseek-v4.1-flash is reasoning-capable")
assert(deepseek.efforts.includes("high"), "deepseek efforts come from catalog meta")
assertEqual(deepseek.minPlan, "Go and above", "deepseek min plan is Go")
assert(deepseek.name.endsWith("(CC)"), "plan-free models get a plain CC suffix")
assert(deepseek.input.includes("image"), "deepseek-v4.1-flash accepts images")

const unseen = models[2]!
assertEqual(unseen.api, "openai-completions", "unknown chat-completions model still gets an api")
assertEqual(unseen.reasoning, false, "unknown model defaults to non-reasoning")
assertDeepEqual(unseen.input, ["text"], "unknown model defaults to text-only")
assertEqual(unseen.maxTokens, 65536, "unknown model caps output at default max")

assertEqual(apiForModelId("claude-opus-5"), "anthropic-messages", "claude- prefix fallback")
assertEqual(apiForModelId("gpt-6-luna"), "openai-completions", "non-claude fallback")
assertEqual(
  baseUrlForModel("https://api.commandcode.ai/provider/v1", "anthropic-messages"),
  "https://api.commandcode.ai/provider",
  "anthropic base strips /v1",
)
assertEqual(
  baseUrlForModel("https://api.commandcode.ai/provider/v1", "openai-completions"),
  "https://api.commandcode.ai/provider/v1",
  "openai base keeps /v1",
)
assertEqual(displayName("X", "Max"), "X (CC · Max)", "Max plan suffix")
assertEqual(displayName("X", "GOAT and above"), "X (CC)", "GOAT needs no suffix")
assertEqual(displayName("X", undefined), "X (CC)", "missing plan needs no suffix")

const effortMap = thinkingLevelMapForEfforts(["low", "high", "max"])
assertEqual(effortMap.low, "low", "supported effort maps through")
assertEqual(effortMap.high, "high", "supported effort maps through")
assertEqual(effortMap.max, "max", "supported effort maps through")
assertEqual(effortMap.medium, null, "unsupported effort maps to null")
assertEqual(effortMap.xhigh, null, "unsupported effort maps to null")

// Docs-only models (in the Provider API, absent from the CLI registry) still
// carry their documented thinking levels and GOAT plan gating.
const docsOnly = commandCodeModelsFromApiResponse({
  object: "list",
  data: [
    {
      id: "meta/muse-spark-1.2",
      name: "Muse Spark 1.2",
      object: "model",
      owned_by: "command-code",
      context_length: 1050000,
      created: 1790244429,
      supported_endpoints: ["/chat/completions"],
    },
  ],
})
const muse = docsOnly[0]!
assertEqual(muse.reasoning, true, "docs-only model is reasoning-capable")
assertDeepEqual(
  [...muse.efforts],
  ["low", "medium", "high", "xhigh"],
  "docs-only model keeps documented efforts",
)
assertEqual(muse.minPlan, "GOAT and above", "docs-only model keeps its GOAT plan gate")
assert(muse.name.includes("(CC)"), "GOAT models need no plan suffix")

// Cache roundtrip: serialize -> parse
const serialized = serializeCommandCodeModelsCache(models)
const roundtripped = commandCodeModelsFromCache(JSON.parse(serialized))
assertEqual(roundtripped.length, 3, "cache roundtrip keeps all models")
assertEqual(roundtripped[0]!.api, "anthropic-messages", "cache roundtrip keeps api")
assertEqual(roundtripped[0]!.reasoning, true, "cache redecorates reasoning from meta")
assert(roundtripped[1]!.name.endsWith("(CC)"), "cache redecorates the display suffix")
assert(roundtripped[1]!.efforts.length > 0, "cache redecorates efforts from meta")

// Legacy v1 cache read
const legacyCache = {
  version: 1,
  models: [
    {
      id: "deepseek/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash (CC)",
      reasoning: true,
      contextWindow: 1000000,
      maxTokens: 65536,
    },
  ],
}
const legacy = commandCodeModelsFromCache(legacyCache)
assertEqual(legacy.length, 1, "legacy v1 cache parses")
assertEqual(legacy[0]!.api, "openai-completions", "legacy cache derives api")
assert(legacy[0]!.efforts.includes("high"), "legacy cache redecorates efforts")
assert(legacy[0]!.input.includes("image"), "legacy cache redecorates vision")

// loadCommandCodeModels: live success writes cache; live failure falls back
const dir = mkdtempSync(join(tmpdir(), "pi-omp-cc-models-"))
try {
  const cachePath = join(dir, "commandcode-models.json")
  const fetchOk = async () => jsonResponse(LIVE_RESPONSE)
  const live = await loadCommandCodeModels({ cachePath, fetchImpl: fetchOk as typeof fetch })
  assertEqual(live.source, "live", "live load reports live source")
  assertEqual(live.models.length, 3, "live load returns models")
  const onDisk = JSON.parse(readFileSync(cachePath, "utf-8"))
  assertEqual(onDisk.version, 2, "cache file is version 2")
  assertEqual(onDisk.models.length, 3, "cache file stores all models")
  assertEqual(onDisk.models[0].api, "anthropic-messages", "cache stores api")

  const cached = await loadCachedCommandCodeModels(cachePath)
  assertEqual(cached.length, 3, "cached load returns models without network")

  const fetchFail = async () => jsonResponse({ error: "down" }, { status: 500 })
  const fallback = await loadCommandCodeModels({ cachePath, fetchImpl: fetchFail as typeof fetch })
  assertEqual(fallback.source, "cache", "failed live load falls back to cache")
  assert(fallback.warning?.includes("Could not refresh"), "fallback carries a warning")

  const emptyDir = mkdtempSync(join(tmpdir(), "pi-omp-cc-empty-"))
  try {
    const empty = await loadCommandCodeModels({
      cachePath: join(emptyDir, "commandcode-models.json"),
      fetchImpl: fetchFail as typeof fetch,
    })
    assertEqual(empty.source, "empty", "no cache and failed fetch reports empty")
    assertEqual(empty.models.length, 0, "empty result carries no models")
  } finally {
    rmSync(emptyDir, { recursive: true, force: true })
  }

  const fetched = await fetchCommandCodeModels({ fetchImpl: fetchOk as typeof fetch })
  assertEqual(fetched.length, 3, "fetchCommandCodeModels parses live catalog")

  // GOAT scoping: an apiKey option authenticates the catalog request.
  let seenAuth: string | undefined
  const fetchSpy = async (_url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seenAuth = headers.get("authorization") ?? undefined
    return jsonResponse(LIVE_RESPONSE)
  }
  await fetchCommandCodeModels({ fetchImpl: fetchSpy as typeof fetch, apiKey: "cc_test_key" })
  assertEqual(seenAuth, "Bearer cc_test_key", "apiKey option sends the bearer header")
  await fetchCommandCodeModels({ fetchImpl: fetchSpy as typeof fetch })
  assertEqual(seenAuth, undefined, "anonymous fetch sends no bearer header")
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log("test-models: all assertions passed")
