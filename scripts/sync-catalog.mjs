#!/usr/bin/env node
/**
 * Regenerate src/catalog-meta.ts from the published `command-code` CLI package.
 *
 * The official CLI bundles a model registry (input modalities, reasoning,
 * reasoningEfforts, contextWindow) in dist/cli.mjs and a docs catalog
 * (min plan, rates) in dist/bundled/command-code-knowledge/reference/models.md.
 * This script snapshots both so the extension can decorate the live Provider
 * API catalog without shipping the whole CLI.
 *
 * Usage:
 *   node scripts/sync-catalog.mjs            # latest published CLI
 *   node scripts/sync-catalog.mjs 1.65.0     # pinned CLI version
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const version = process.argv[2] ?? "latest"

function npmView(spec, field) {
  const out = execFileSync("npm", ["view", spec, field, "--json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const parsed = JSON.parse(out)
  return typeof parsed === "string" ? parsed : parsed[field]
}

const meta = JSON.parse(
  execFileSync("npm", ["view", `command-code@${version}`, "version", "dist.tarball", "--json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
)
const cliVersion = meta.version
const tarballUrl = meta.dist?.tarball ?? meta["dist.tarball"]

const work = mkdtempSync(join(tmpdir(), "pi-omp-cc-catalog-"))
try {
  const tgz = join(work, "command-code.tgz")
  execFileSync("curl", ["-fsSL", tarballUrl, "-o", tgz])
  execFileSync("tar", ["-xzf", tgz, "-C", work, "package/dist/cli.mjs", "package/dist/bundled/command-code-knowledge/reference/models.md"])

  const cliSource = readFileSync(join(work, "package/dist/cli.mjs"), "utf-8")
  const docsSource = readFileSync(
    join(work, "package/dist/bundled/command-code-knowledge/reference/models.md"),
    "utf-8",
  )

  const models = parseCliRegistry(cliSource)
  const docs = parseDocsCatalog(docsSource)
  for (const model of models) {
    const doc = docs.get(model.id)
    if (doc) {
      model.minPlan = doc.minPlan
      model.cost = doc.cost
    }
  }

  const matched = models.filter((m) => m.minPlan).length
  console.log(`command-code@${cliVersion}: ${models.length} registry models, ${matched} with docs min plan/pricing`)

  writeFileSync(join(root, "src", "catalog-meta.ts"), renderCatalogMeta(models, cliVersion))
  console.log(`wrote src/catalog-meta.ts`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

function parseCliRegistry(source) {
  const blocks = source.match(/\{[^{}]{0,900}?inputModalities:\[[^\]]*\][^{}]{0,900}?\}/g) ?? []
  const models = []
  const seen = new Set()
  for (const block of blocks) {
    const id = matchField(block, /id:"([^"]+)"/)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const modalities = matchField(block, /inputModalities:\[([^\]]*)\]/)
    const efforts = splitStringList(matchField(block, /reasoningEfforts:\[([^\]]*)\]/))
    // `reasoning:!0` marks adaptive-depth reasoning; `reasoningEfforts` alone
    // still means the model accepts explicit effort levels (e.g. sonnet-4-6).
    const reasoningFlag = matchField(block, /reasoning:(!0|!1)/)
    const contextWindow = matchField(block, /contextWindow:([0-9e.]+)/)
    const maxOutputTokens = matchField(block, /maxOutputTokens:([0-9e.]+)/)
    models.push({
      id,
      input: splitStringList(modalities),
      reasoning: reasoningFlag === "!0" || efforts.length > 0,
      adaptive: reasoningFlag === "!0" && efforts.length === 0,
      efforts,
      contextWindow: contextWindow ? Number(contextWindow) : undefined,
      maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : undefined,
    })
  }
  return models
}

function parseDocsCatalog(source) {
  // | `id` | Name | Context | Efforts | $in/$out · cache $r (write $w) | Min plan | Best for |
  const rows = new Map()
  for (const line of source.split("\n")) {
    if (!line.startsWith("| `")) continue
    const cells = line.split("|").map((cell) => cell.trim())
    const id = cells[1]?.replace(/`/g, "")
    const effortsCell = cells[4] ?? ""
    const priceCell = cells[5] ?? ""
    const minPlan = cells[6] ?? ""
    if (!id || !minPlan) continue
    const price = priceCell.match(/\$([0-9.]+)\s*\/\s*\$([0-9.]+)/)
    const cacheRead = priceCell.match(/cache\s*\$([0-9.]+)/)
    const cacheWrite = priceCell.match(/write\s*\$([0-9.]+)/)
    const docsEfforts =
      effortsCell === "—" || !effortsCell
        ? []
        : effortsCell.split(",").map((e) => e.trim()).filter(Boolean)
    rows.set(id, {
      minPlan,
      docsEfforts,
      cost: {
        input: price ? Number(price[1]) : 0,
        output: price ? Number(price[2]) : 0,
        cacheRead: cacheRead ? Number(cacheRead[1]) : 0,
        cacheWrite: cacheWrite ? Number(cacheWrite[1]) : 0,
      },
    })
  }
  return rows
}

function matchField(source, pattern) {
  const match = source.match(pattern)
  return match ? match[1] : undefined
}

function splitStringList(value) {
  if (!value) return []
  return value
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
}

function renderCatalogMeta(models, cliVersion) {
  const entries = models
    .map((m) => {
      const cost = m.cost
      const lines = [
        `    input: ${JSON.stringify(m.input)},`,
        `    reasoning: ${m.reasoning},`,
        `    adaptive: ${m.adaptive},`,
        `    efforts: ${JSON.stringify(m.efforts)},`,
      ]
      if (m.contextWindow) lines.push(`    contextWindow: ${m.contextWindow},`)
      if (m.maxOutputTokens) lines.push(`    maxOutputTokens: ${m.maxOutputTokens},`)
      if (m.minPlan) lines.push(`    minPlan: ${JSON.stringify(m.minPlan)},`)
      if (cost) {
        lines.push(
          `    cost: { input: ${cost.input}, output: ${cost.output}, cacheRead: ${cost.cacheRead}, cacheWrite: ${cost.cacheWrite} },`,
        )
      }
      return `  ${JSON.stringify(m.id)}: {\n${lines.join("\n")}\n  },`
    })
    .join("\n")

  return `// GENERATED FILE - do not edit by hand.
// Regenerate with: npm run sync:catalog
// Source: npm package command-code@${cliVersion} (dist/cli.mjs model registry
// + dist/bundled/command-code-knowledge/reference/models.md).
// Generated: ${new Date().toISOString()}

export interface CatalogMeta {
  input: readonly ("text" | "image")[]
  /** true when the model is reasoning-capable (explicit efforts or adaptive depth). */
  reasoning: boolean
  /** true when reasoning is on but the model decides its own depth. */
  adaptive: boolean
  /** Selectable reasoning efforts; empty when the model decides depth itself. */
  efforts: readonly string[]
  contextWindow?: number
  maxOutputTokens?: number
  /** Cheapest public plan that serves the model, e.g. "Go and above", "Max". */
  minPlan?: string
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export const CATALOG_META: Readonly<Record<string, CatalogMeta>> = {
${entries}
}
`
}
