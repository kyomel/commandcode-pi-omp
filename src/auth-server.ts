import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"

export interface AuthServerResult {
  port: number
  server: Server
  waitForCallback: Promise<{ apiKey: string; state: string }>
}

const SUCCESS_PAGE = `<!doctype html><html><body style="font-family:sans-serif">
<h2>Command Code login complete</h2><p>You can close this tab and return to the terminal.</p>
</body></html>`

const FAILURE_PAGE = `<!doctype html><html><body style="font-family:sans-serif">
<h2>Command Code login failed</h2><p>State mismatch. Retry /login in the terminal.</p>
</body></html>`

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

interface CallbackPayload {
  apiKey?: string | undefined
  state?: string | undefined
}

function parseCallbackPayload(body: string, contentType: string): CallbackPayload {
  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>
        return {
          apiKey: typeof record.apiKey === "string" ? record.apiKey : undefined,
          state: typeof record.state === "string" ? record.state : undefined,
        }
      }
    } catch {
      return {}
    }
    return {}
  }
  const params = new URLSearchParams(body)
  return {
    apiKey: params.get("apiKey") ?? params.get("api_key") ?? params.get("key") ?? undefined,
    state: params.get("state") ?? undefined,
  }
}

/**
 * Local callback server for Command Code Studio's CLI auth handoff. The studio
 * page POSTs `{apiKey, state}` to `http://localhost:<port>/callback`.
 */
export async function startAuthServer(options: {
  expectedState: string
}): Promise<AuthServerResult> {
  let resolveCallback: (value: { apiKey: string; state: string }) => void
  let rejectCallback: (error: Error) => void
  const waitForCallback = new Promise<{ apiKey: string; state: string }>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost")
      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, { "content-type": "text/plain" }).end("ok")
        return
      }
      if (request.method !== "POST" || url.pathname !== "/callback") {
        response.writeHead(404).end()
        return
      }
      try {
        const body = await readBody(request)
        const payload = parseCallbackPayload(body, request.headers["content-type"] ?? "")
        if (!payload.apiKey || payload.state !== options.expectedState) {
          response.writeHead(400, { "content-type": "text/html" }).end(FAILURE_PAGE)
          return
        }
        response.writeHead(200, { "content-type": "text/html" }).end(SUCCESS_PAGE)
        resolveCallback({ apiKey: payload.apiKey, state: payload.state })
      } catch (error) {
        response.writeHead(500).end()
        rejectCallback(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address() as AddressInfo
  return { port: address.port, server, waitForCallback }
}
