import type { PlaylistTextTrack } from "@/contracts/types"
import { type ResolvedMedia, resolveMediaSource } from "@/server/media/resolve"
import { resolveCaptionTracks } from "@/server/media/resolve/caption-tracks"
import { invalidateYtDlpExtractCache } from "@/server/media/yt-dlp"
import { beginResolveLease } from "@/server/media/yt-dlp/resolve-lease"

export type { ResolvedMedia }

/**
 * Playlist media resolve surface for realtime services.
 *
 * Production adapter wraps yt-dlp extract cache / resolve leases and
 * {@link resolveMediaSource}. Handlers/services should use
 * {@link getMediaResolvePort} instead of deep-importing those modules.
 */
export interface MediaResolvePort {
  resolveMediaSource(input: {
    url: string
    name?: string
    roomId?: string
    mediaId?: string
    /** When false, skip minting proxy tokens (playability probes). Default true. */
    mintRelay?: boolean
  }): Promise<ResolvedMedia>

  beginResolveLease(input: {
    roomId: string
    itemId: string
    sourceUrl: string
    title?: string
  }): Promise<{ stop: () => void } | null>

  invalidateYtDlpExtractCache(url: string): Promise<void>

  /**
   * Caption-only enrichment for native fast-path items (YouTube/Vimeo resolve
   * without yt-dlp, so their catalogs carry no tracks). Returns relayed
   * tracks or null when the extract fails / yields nothing usable.
   */
  resolveCaptionTracks(input: {
    url: string
    roomId?: string
    mediaId?: string
  }): Promise<PlaylistTextTrack[] | null>
}

/** Production adapter — process-local wrappers around media resolve modules. */
export function createMediaResolvePort(): MediaResolvePort {
  return {
    resolveMediaSource,
    beginResolveLease,
    invalidateYtDlpExtractCache,
    resolveCaptionTracks,
  }
}
