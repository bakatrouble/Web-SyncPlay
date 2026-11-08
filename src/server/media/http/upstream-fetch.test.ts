import { afterEach, describe, expect, mock, test } from "bun:test"

const seen: Array<{ url: string; init: Record<string, unknown> }> = []
let agentInstances = 0

mock.module("undici", () => ({
  fetch: async (url: string, init: Record<string, unknown> = {}) => {
    seen.push({ url, init })
    return new Response("ok")
  },
  ProxyAgent: class {
    constructor(public options: Record<string, unknown>) {
      agentInstances += 1
    }
  },
}))

const PROXY = "http://10.0.0.3:2080"
const prevHttpProxy = process.env.HTTP_PROXY
const prevHttpsProxy = process.env.HTTPS_PROXY
const prevNoProxy = process.env.NO_PROXY

function setEnv(http?: string, https?: string, noProxy?: string) {
  if (http === undefined) delete process.env.HTTP_PROXY
  else process.env.HTTP_PROXY = http
  if (https === undefined) delete process.env.HTTPS_PROXY
  else process.env.HTTPS_PROXY = https
  if (noProxy === undefined) delete process.env.NO_PROXY
  else process.env.NO_PROXY = noProxy
}

afterEach(() => {
  if (prevHttpProxy === undefined) delete process.env.HTTP_PROXY
  else process.env.HTTP_PROXY = prevHttpProxy
  if (prevHttpsProxy === undefined) delete process.env.HTTPS_PROXY
  else process.env.HTTPS_PROXY = prevHttpsProxy
  if (prevNoProxy === undefined) delete process.env.NO_PROXY
  else process.env.NO_PROXY = prevNoProxy
  seen.length = 0
  mock.restore()
})

describe("fetchUpstream", () => {
  test("routes through the proxy dispatcher when configured", async () => {
    setEnv(PROXY)
    const { fetchUpstream } = await import("./upstream-fetch")

    await fetchUpstream("https://www.youtube.com/api/timedtext?v=x")

    expect(seen).toHaveLength(1)
    expect(seen[0]?.init.dispatcher).toBeDefined()
    expect(agentInstances).toBeGreaterThan(0)
  })

  test("skips the proxy with no proxy env", async () => {
    setEnv()
    const { fetchUpstream } = await import("./upstream-fetch")

    await fetchUpstream("https://cdn.example/a.vtt")

    expect(seen).toHaveLength(1)
    expect(seen[0]?.init.dispatcher).toBeUndefined()
  })

  test("honors NO_PROXY bypass", async () => {
    setEnv(PROXY, undefined, "localhost,127.0.0.1")
    const { fetchUpstream } = await import("./upstream-fetch")

    await fetchUpstream("http://localhost:3000/x")

    expect(seen).toHaveLength(1)
    expect(seen[0]?.init.dispatcher).toBeUndefined()
  })

  test("forwards method and headers", async () => {
    setEnv(PROXY)
    const { fetchUpstream } = await import("./upstream-fetch")

    await fetchUpstream("https://cdn.example/a.vtt", {
      method: "HEAD",
      headers: { "user-agent": "test" },
      redirect: "manual",
    })

    expect(seen[0]?.init.method).toBe("HEAD")
    expect(seen[0]?.init.redirect).toBe("manual")
  })
})
