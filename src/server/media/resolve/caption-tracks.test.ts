import { afterEach, describe, expect, mock, test } from "bun:test"

afterEach(() => {
  mock.restore()
})

type TextTrack = {
  id: string
  src: string
  label: string
  language?: string
  kind?: "captions" | "subtitles"
  type?: string
  isDefault?: boolean
}

function track(
  overrides: Partial<TextTrack> & Pick<TextTrack, "id" | "src">,
): TextTrack {
  return {
    label: overrides.id,
    kind: "subtitles",
    type: "text/vtt",
    ...overrides,
  }
}

function mockDeps(options: {
  extractOk: boolean
  tracks?: TextTrack[]
  proxy?: (url: string) => Promise<string>
}) {
  mock.module("@/server/media/providers/yt-dlp-provider", () => ({
    resolveWithYtDlp: async () =>
      options.extractOk
        ? {
            extractOk: true as const,
            title: "t",
            durationSeconds: 10,
            playableUrl: "https://youtu.be/x",
            streams: [],
            textTracks: options.tracks ?? [],
            isLive: false,
            videoVariants: [],
            audioVariants: [],
          }
        : {
            extractOk: false as const,
            title: null,
            durationSeconds: null,
            playableUrl: null,
            streams: [],
            textTracks: [],
            isLive: null,
            videoVariants: [],
            audioVariants: [],
            userMessage: "nope",
            classification: "not_found" as const,
          },
  }))
  mock.module("@/server/media/proxy-token", () => ({
    PROXY_DEFAULT_UA: "test-ua",
    createProxyUrl:
      options.proxy ??
      (async (url: string) => `/proxy/${encodeURIComponent(url)}`),
  }))
}

describe("resolveCaptionTracks", () => {
  test("relays remote tracks, skips non-remote src and relay failures", async () => {
    mockDeps({
      extractOk: true,
      tracks: [
        track({
          id: "en-1",
          src: "https://yt.example/timedtext?lang=en",
          language: "en",
        }),
        track({
          id: "de-2",
          src: "https://yt.example/timedtext?lang=de",
          language: "de",
        }),
        track({ id: "bad-3", src: "not-a-url", language: "xx" }),
        track({
          id: "es-4",
          src: "https://yt.example/timedtext?lang=es",
          language: "es",
        }),
      ],
      proxy: async (url: string) => {
        if (url.includes("lang=de")) throw new Error("refused")
        return `/proxy/${encodeURIComponent(url)}`
      },
    })

    const { resolveCaptionTracks } = await import("./caption-tracks")
    const tracks = await resolveCaptionTracks({ url: "https://youtu.be/x" })

    expect(tracks?.map((entry) => entry.id)).toEqual(["en-1", "es-4"])
    expect(tracks?.[0]?.src).toStartWith("/proxy/")
    expect(tracks?.[0]?.language).toBe("en")
  })

  test("returns null on failed extract", async () => {
    mockDeps({ extractOk: false })

    const { resolveCaptionTracks } = await import("./caption-tracks")
    expect(await resolveCaptionTracks({ url: "https://youtu.be/x" })).toBeNull()
  })

  test("returns null when the extract yields no tracks", async () => {
    mockDeps({ extractOk: true, tracks: [] })

    const { resolveCaptionTracks } = await import("./caption-tracks")
    expect(await resolveCaptionTracks({ url: "https://youtu.be/x" })).toBeNull()
  })

  test("returns null when every relay mint fails", async () => {
    mockDeps({
      extractOk: true,
      tracks: [track({ id: "en-1", src: "https://yt.example/a" })],
      proxy: async () => {
        throw new Error("denied")
      },
    })

    const { resolveCaptionTracks } = await import("./caption-tracks")
    expect(await resolveCaptionTracks({ url: "https://youtu.be/x" })).toBeNull()
  })

  test("relays the full list uncapped, English first", async () => {
    mockDeps({
      extractOk: true,
      tracks: [
        ...Array.from({ length: 25 }, (_, index) =>
          track({
            id: `t-${index + 1}`,
            src: `https://yt.example/${index + 1}`,
          }),
        ),
        track({ id: "en-x", src: "https://yt.example/en", language: "en" }),
      ],
    })

    const { resolveCaptionTracks } = await import("./caption-tracks")
    const tracks = await resolveCaptionTracks({ url: "https://youtu.be/x" })

    expect(tracks?.length).toBe(26)
    expect(tracks?.[0]?.id).toBe("en-x")
    expect(tracks?.[0]?.isDefault).toBe(true)
  })

  test("orders English first and defaults to it", async () => {
    mockDeps({
      extractOk: true,
      tracks: [
        track({ id: "ab-1", src: "https://yt.example/ab", language: "ab" }),
        track({ id: "de-2", src: "https://yt.example/de", language: "de" }),
        track({
          id: "en-gb-3",
          src: "https://yt.example/en-GB",
          language: "en-GB",
        }),
        track({ id: "en-4", src: "https://yt.example/en", language: "en" }),
      ],
    })

    const { resolveCaptionTracks } = await import("./caption-tracks")
    const tracks = await resolveCaptionTracks({ url: "https://youtu.be/x" })

    expect(tracks?.map((entry) => entry.id)).toEqual([
      "en-4",
      "en-gb-3",
      "ab-1",
      "de-2",
    ])
    expect(tracks?.[0]?.isDefault).toBe(true)
    expect(tracks?.slice(1).every((entry) => entry.isDefault === false)).toBe(
      true,
    )
  })
})

describe("orderCaptionCandidates", () => {
  test("exact English first, regional second, dump order otherwise", async () => {
    const { orderCaptionCandidates } = await import("./caption-tracks")
    const ids = orderCaptionCandidates([
      { language: "de" },
      { language: "en-US" },
      { language: "ab" },
      { language: "en" },
      { language: undefined },
    ]).map((entry) => entry.language)

    expect(ids).toEqual(["en", "en-US", "de", "ab", undefined])
  })
})
