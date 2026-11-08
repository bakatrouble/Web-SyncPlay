import { MEDIA_TEXT_TRACK_CATALOG_LIMIT } from "@/contracts/types"
import type { PlaylistTextTrack } from "@/contracts/types"
import { resolveWithYtDlp } from "@/server/media/providers/yt-dlp-provider"
import { createProxyUrl, PROXY_DEFAULT_UA } from "@/server/media/proxy-token"

function isRemoteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function isEnglishTrack(track: { language?: string }): boolean {
  const lang = track.language?.trim().toLowerCase() ?? ""
  return lang === "en" || lang.startsWith("en-") || lang.startsWith("en_")
}

/**
 * Order caption candidates before the catalog cap: English first (exact,
 * then regional variants), dump order otherwise. Auto-caption dumps list
 * 100+ languages alphabetically, so without this the cap keeps Abkhazian
 * through Bulgarian and drops the track anyone will actually enable.
 * Exported for tests.
 */
export function orderCaptionCandidates<T extends { language?: string }>(
  tracks: T[],
): T[] {
  return [...tracks].sort((a, b) => {
    const rank = (track: { language?: string }) =>
      track.language?.trim().toLowerCase() === "en"
        ? 0
        : isEnglishTrack(track)
          ? 1
          : 2
    return rank(a) - rank(b)
  })
}

/**
 * Caption enrichment for URLs that took the native fast path (YouTube/Vimeo
 * play without yt-dlp, so their catalogs carry no caption tracks).
 *
 * Runs a full yt-dlp extract, keeps the parsed caption tracks (same merge +
 * VTT preference as the normal path, English-first, then the catalog cap),
 * and relays each track URL through the media proxy so browsers can load
 * them (timedtext hosts do not send CORS headers). Playback is untouched —
 * tracks only.
 *
 * Returns null when the extract fails or yields nothing usable. Per-track
 * relay failures are skipped, never fatal.
 */
export async function resolveCaptionTracks(input: {
  url: string
  roomId?: string
  mediaId?: string
}): Promise<PlaylistTextTrack[] | null> {
  const resolved = await resolveWithYtDlp(input.url)
  if (!resolved.extractOk || resolved.textTracks.length === 0) {
    return null
  }

  const meta = {
    roomId: input.roomId,
    mediaId: input.mediaId,
    referer: input.url,
    userAgent: PROXY_DEFAULT_UA,
  }

  const relayed: PlaylistTextTrack[] = []
  for (const track of orderCaptionCandidates(resolved.textTracks).slice(
    0,
    MEDIA_TEXT_TRACK_CATALOG_LIMIT,
  )) {
    if (!isRemoteHttpUrl(track.src)) continue
    try {
      relayed.push({ ...track, src: await createProxyUrl(track.src, meta) })
    } catch {
      continue
    }
  }
  if (relayed.length === 0) return null
  // Deterministic default: the first surviving track (English when present).
  return relayed.map((track, index) => ({
    ...track,
    isDefault: index === 0,
  }))
}
