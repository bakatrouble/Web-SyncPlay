import { afterEach, describe, expect, test } from "bun:test"

import type { PlaylistTextTrack } from "@/contracts/types"
import { getMediaResolvePort, setMediaResolvePort } from "@/server/ports"
import { enrichPlaylistItemCaptions } from "@/server/realtime/services/playlist-resolve"
import {
  createPlaylistItem,
  createRoomState,
  InMemoryRoomStateStore,
} from "@/server/realtime/test-utils/fixtures"

const prevPort = getMediaResolvePort()

afterEach(() => {
  setMediaResolvePort(prevPort)
})

function seedStore(item: ReturnType<typeof createPlaylistItem>) {
  return new InMemoryRoomStateStore(createRoomState({ playlist: [item] }))
}

function readyItem(
  overrides?: Partial<Parameters<typeof createPlaylistItem>[0]>,
) {
  return createPlaylistItem({
    id: "item-1",
    name: "vid",
    sourceUrl: "https://youtu.be/x",
    ingestStatus: "ready",
    textTracks: [],
    ...overrides,
  })
}

/** Install a port whose caption method counts calls; returns the counter. */
function portWithCaptions(tracks: PlaylistTextTrack[] | null) {
  let calls = 0
  const base = getMediaResolvePort()
  setMediaResolvePort({
    ...base,
    async resolveCaptionTracks() {
      calls += 1
      return tracks ? [...tracks] : null
    },
  })
  return () => calls
}

function itemTracks(store: InMemoryRoomStateStore) {
  return (
    store.peek("room-1")?.playlist.find((entry) => entry.id === "item-1")
      ?.textTracks ?? []
  )
}

describe("enrichPlaylistItemCaptions", () => {
  test("writes relayed tracks to a ready item lacking them", async () => {
    const calls = portWithCaptions([
      {
        id: "en-1",
        src: "/proxy/en",
        label: "English",
        language: "en",
        kind: "subtitles",
        type: "text/vtt",
      },
      {
        id: "de-2",
        src: "/proxy/de",
        label: "German",
        language: "de",
        kind: "subtitles",
        type: "text/vtt",
        isDefault: true,
      },
    ])
    const store = seedStore(readyItem())

    const written = await enrichPlaylistItemCaptions({
      store,
      roomId: "room-1",
      itemId: "item-1",
      sourceUrl: "https://youtu.be/x",
      captionEnrich: true,
    })

    expect(calls()).toBe(1)
    expect(written).toBe(true)
    expect(itemTracks(store).map((entry) => entry.id)).toEqual(["en-1", "de-2"])
    expect(
      store.peek("room-1")?.playlist.find((entry) => entry.id === "item-1")
        ?.defaultTextTrackId,
    ).toBe("de-2")
  })

  test("no-op when the gate is off and never calls the port", async () => {
    const calls = portWithCaptions([
      { id: "en-1", src: "/proxy/en", label: "English" },
    ])
    const store = seedStore(readyItem())

    const written = await enrichPlaylistItemCaptions({
      store,
      roomId: "room-1",
      itemId: "item-1",
      sourceUrl: "https://youtu.be/x",
      captionEnrich: false,
    })

    expect(written).toBe(false)
    expect(calls()).toBe(0)
  })

  test("skips items that already carry tracks", async () => {
    const calls = portWithCaptions([
      { id: "en-1", src: "/proxy/en", label: "English" },
    ])
    const existing = [{ id: "fr-9", src: "/proxy/fr", label: "French" }]
    const store = seedStore(readyItem({ textTracks: existing }))

    const written = await enrichPlaylistItemCaptions({
      store,
      roomId: "room-1",
      itemId: "item-1",
      sourceUrl: "https://youtu.be/x",
      captionEnrich: true,
    })

    expect(written).toBe(false)
    expect(calls()).toBe(1)
    expect(itemTracks(store)).toEqual(existing)
  })

  test("returns false when the port yields nothing usable", async () => {
    portWithCaptions(null)
    const store = seedStore(readyItem())

    const written = await enrichPlaylistItemCaptions({
      store,
      roomId: "room-1",
      itemId: "item-1",
      sourceUrl: "https://youtu.be/x",
      captionEnrich: true,
    })

    expect(written).toBe(false)
    expect(itemTracks(store)).toEqual([])
  })
})
