import { fetch as undiciFetch, ProxyAgent } from "undici"

/**
 * Upstream media fetch that honors proxy env (undici ProxyAgent).
 *
 * Node's global fetch never reads HTTP(S)_PROXY, so on hosts without direct
 * WAN egress (proxy-only) every server-side upstream fetch hangs until TCP
 * timeout and surfaces as a 500. This helper routes through the configured
 * proxy and uses undici's own fetch so dispatcher versions always match.
 */

function proxyEnv(): string | null {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}

function hostBypassed(hostname: string): boolean {
  const raw =
    process.env.NO_PROXY || process.env.no_proxy || process.env.NoProxy
  if (!raw) return false
  const host = hostname.trim().toLowerCase().replace(/\.$/, "")
  if (!host) return false
  for (const entry of raw.split(",")) {
    const rule = entry.trim().toLowerCase().replace(/\.$/, "")
    if (!rule) continue
    if (rule === "*") return true
    if (rule === host) return true
    if (
      rule.startsWith(".") &&
      (host === rule.slice(1) || host.endsWith(rule))
    ) {
      return true
    }
  }
  return false
}

let cachedAgent: { proxy: string; agent: ProxyAgent } | null = null

function dispatcherFor(url: string): ProxyAgent | undefined {
  const proxy = proxyEnv()
  if (!proxy) return undefined
  let hostname = ""
  try {
    hostname = new URL(url).hostname
  } catch {
    return undefined
  }
  if (hostBypassed(hostname)) return undefined
  if (!cachedAgent || cachedAgent.proxy !== proxy) {
    cachedAgent = {
      proxy,
      agent: new ProxyAgent({
        uri: proxy,
        // Fail fast on connect; body streams are unaffected (long media OK).
        headersTimeout: 15_000,
      }),
    }
  }
  return cachedAgent.agent
}

/** Drop-in upstream fetch for media proxy paths (GET/HEAD/redirects). */
export function fetchUpstream(
  url: string,
  init?: {
    method?: string
    headers?: HeadersInit
    redirect?: RequestRedirect
  },
): Promise<Response> {
  const dispatcher = dispatcherFor(url)
  return undiciFetch(
    url,
    dispatcher ? { ...init, dispatcher } : { ...init },
  ) as unknown as Promise<Response>
}
