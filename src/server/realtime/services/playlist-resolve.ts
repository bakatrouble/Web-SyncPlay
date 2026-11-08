import type { PlaylistItem, RoomState } from "@/contracts/types"
import { env } from "@/env"
import type { ResolvedMedia } from "@/server/media/media-resolve-port"
import { getMediaResolvePort, type RoomStateStorePort } from "@/server/ports"
import { getRoomBroadcastBus } from "@/server/realtime/broadcast/room-broadcast-bus"
import { bumpRoomRevisions } from "@/server/realtime/services/timeline"
import { sanitizeMediaTitle } from "@/shared/sanitize-display"

/** Process-local dedupe so multi-kick of the same item does not pile up yt-dlp work. */
const inflightPlaylistResolves = new Set<string>()

/** Separate dedupe for caption enrichment (runs after resolve settled). */
const inflightCaptionEnriches = new Set<string>()

function resolveKey(roomId: string, itemId: string) {
  return `${roomId}:${itemId}`
}

function touchRoomStructural(state: RoomState) {
  state.updatedAt = Date.now()
  bumpRoomRevisions(state)
}

function publishRoomSnapshot(store: RoomStateStorePort, roomId: string) {
  const bus = getRoomBroadcastBus()
  bus.attachStore(store)
  bus.markSnapshotDirty(roomId)
}

function resolveDisplayName(
  item: PlaylistItem,
  resolved: ResolvedMedia,
  preferredTitle?: string,
): string {
  const preferred = preferredTitle?.trim()
  const safeTitle =
    (resolved.title ? sanitizeMediaTitle(resolved.title) : null) ?? null
  if (preferred && item.name.trim() === preferred) {
    return safeTitle || sanitizeMediaTitle(preferred) || preferred
  }
  if (item.name.trim() === item.sourceUrl.trim()) {
    return safeTitle || sanitizeMediaTitle(item.sourceUrl) || item.sourceUrl
  }
  return item.name
}

export function applyResolvedMediaToItem(
  item: PlaylistItem,
  resolved: ResolvedMedia,
  options?: { preferredTitle?: string },
) {
  item.playableUrl = resolved.playableUrl
  item.playbackMode = resolved.playbackMode
  item.mediaStreams = resolved.mediaStreams
  item.defaultStreamId = resolved.defaultStreamId
  item.textTracks = resolved.textTracks
  item.defaultTextTrackId = resolved.defaultTextTrackId
  item.durationSeconds = resolved.durationSeconds ?? undefined
  item.isLive = resolved.isLive ?? undefined
  item.ingestStatus = "ready"
  item.ingestError = undefined
  item.name = resolveDisplayName(item, resolved, options?.preferredTitle)
}

async function commitResolvingItem(
  store: RoomStateStorePort,
  roomId: string,
  itemId: string,
  mutateItem: (item: PlaylistItem) => void,
  options?: { retryUntilPresent?: boolean },
): Promise<boolean> {
  const maxAttempts = options?.retryUntilPresent ? 24 : 1
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const written = await store.updateRoom(roomId, async (state) => {
      if (!state) return null
      const item = state.playlist.find((entry) => entry.id === itemId)
      // Only settle items still waiting — drop races with rename/remove/retry.
      if (!item || item.ingestStatus !== "resolving") {
        return options?.retryUntilPresent ? state : null
      }
      mutateItem(item)
      touchRoomStructural(state)
      return state
    })
    if (written) {
      publishRoomSnapshot(store, roomId)
      return true
    }
    if (!options?.retryUntilPresent) return false
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25 * 2 ** Math.min(attempt, 4), 200)),
    )
  }
  return false
}

/**
 * Background caption enrichment for items that resolved without tracks
 * (native-provider fast path: YouTube/Vimeo play without yt-dlp).
 *
 * Opt-in via YOUTUBE_CAPTION_ENRICH (default off — each run spawns yt-dlp
 * against Google/Vimeo). Playback is untouched; on success the item's
 * textTracks/defaultTextTrackId are written back and the room re-published.
 * Never throws — failures are silent by design.
 */
export async function enrichPlaylistItemCaptions(params: {
  store: RoomStateStorePort
  roomId: string
  itemId: string
  sourceUrl: string
  /** Override for the YOUTUBE_CAPTION_ENRICH gate (tests/ops). Default: env flag. */
  captionEnrich?: boolean
}): Promise<boolean> {
  const { store, roomId, itemId, sourceUrl } = params
  const enabled = params.captionEnrich ?? env.YOUTUBE_CAPTION_ENRICH === "true"
  if (!enabled) return false
  const key = resolveKey(roomId, itemId)
  if (inflightCaptionEnriches.has(key)) return false
  inflightCaptionEnriches.add(key)
  try {
    const media = getMediaResolvePort()
    const tracks = await media.resolveCaptionTracks({
      url: sourceUrl,
      roomId,
      mediaId: itemId,
    })
    if (!tracks || tracks.length === 0) return false
    const defaultTextTrackId =
      tracks.find((track) => track.isDefault)?.id ?? tracks[0]?.id
    const written = await store.updateRoom(roomId, async (state) => {
      if (!state) return null
      const item = state.playlist.find((entry) => entry.id === itemId)
      // Only enrich the same ready item that still lacks tracks — drop races
      // with remove/retry/reresolve (which refills or resets the catalog).
      if (!item || item.sourceUrl !== sourceUrl) return null
      if (item.ingestStatus !== "ready") return null
      if ((item.textTracks ?? []).length > 0) return null
      item.textTracks = tracks
      item.defaultTextTrackId = defaultTextTrackId
      touchRoomStructural(state)
      return state
    })
    if (written) publishRoomSnapshot(store, roomId)
    return written !== null
  } catch {
    return false
  } finally {
    inflightCaptionEnriches.delete(key)
  }
}

/**
 * Resolve a remote playlist item that is already persisted as `resolving`.
 * Safe to call after the room write that enqueued the item.
 */
export async function resolvePlaylistItem(params: {
  store: RoomStateStorePort
  roomId: string
  itemId: string
  sourceUrl: string
  title?: string
  /** Retry briefly when the room/item may not be visible yet (seed after join). */
  retryUntilPresent?: boolean
  failureMessage?: string
}): Promise<void> {
  const {
    store,
    roomId,
    itemId,
    sourceUrl,
    title,
    retryUntilPresent = false,
    failureMessage = "Failed to resolve metadata",
  } = params
  const key = resolveKey(roomId, itemId)
  if (inflightPlaylistResolves.has(key)) return
  inflightPlaylistResolves.add(key)

  const media = getMediaResolvePort()
  const lease = await media.beginResolveLease({
    roomId,
    itemId,
    sourceUrl,
    title,
  })

  try {
    const resolved = await media.resolveMediaSource({
      url: sourceUrl,
      name: title,
      roomId,
      mediaId: itemId,
    })

    if (resolved.failureReason) {
      await commitResolvingItem(
        store,
        roomId,
        itemId,
        (item) => {
          item.ingestStatus = "error"
          item.ingestError = resolved.resolveUserMessage ?? failureMessage
        },
        { retryUntilPresent },
      )
      return
    }

    await commitResolvingItem(
      store,
      roomId,
      itemId,
      (item) => {
        applyResolvedMediaToItem(item, resolved, { preferredTitle: title })
      },
      { retryUntilPresent },
    )

    // Native fast-path items resolve with no tracks; enrich captions in the
    // background (env-gated, no-op when off). Detached — never blocks settle.
    if (resolved.textTracks.length === 0) {
      void enrichPlaylistItemCaptions({ store, roomId, itemId, sourceUrl })
    }
  } catch {
    await commitResolvingItem(
      store,
      roomId,
      itemId,
      (item) => {
        item.ingestStatus = "error"
        item.ingestError = failureMessage
      },
      { retryUntilPresent },
    )
  } finally {
    lease?.stop()
    inflightPlaylistResolves.delete(key)
  }
}

/** Kick background resolve for every remote item still marked `resolving`. */
export function scheduleResolvingPlaylistItems(
  store: RoomStateStorePort,
  roomId: string,
  playlist: PlaylistItem[],
) {
  for (const item of playlist) {
    if (item.ingestStatus !== "resolving") continue
    if (item.sourceKind === "local_file") continue
    void resolvePlaylistItem({
      store,
      roomId,
      itemId: item.id,
      sourceUrl: item.sourceUrl,
      title: item.name,
      retryUntilPresent: true,
      failureMessage: "Failed to resolve default media",
    })
  }
}

/**
 * Invalidate extract cache and re-run resolve for a remote playlist item.
 * Used by explicit retry and by proxy 401/403 stale-upstream recovery.
 */
export async function reresolveRemotePlaylistItem(params: {
  store: RoomStateStorePort
  roomId: string
  itemId: string
}): Promise<boolean> {
  const { store, roomId, itemId } = params
  let sourceUrl: string | undefined
  let title: string | undefined

  const written = await store.updateRoom(roomId, async (state) => {
    if (!state) return null
    const item = state.playlist.find((entry) => entry.id === itemId)
    if (!item || item.sourceKind !== "remote_url") return null
    if (item.blockedReason === "local_owner_offline") return null
    sourceUrl = item.sourceUrl
    title = item.name
    if (item.ingestStatus === "resolving") {
      // Already in flight — still invalidate cache so the next pass is fresh.
      return null
    }
    item.ingestStatus = "resolving"
    item.ingestError = undefined
    touchRoomStructural(state)
    return state
  })

  if (!sourceUrl) return false

  await getMediaResolvePort().invalidateYtDlpExtractCache(sourceUrl)

  if (written) {
    publishRoomSnapshot(store, roomId)
  }

  await resolvePlaylistItem({
    store,
    roomId,
    itemId,
    sourceUrl,
    title,
  })
  return true
}
