/**
 * Advanced Regex-based BitTorrent Title and Metadata Parsing Engine.
 * Extracts title, year, season, episode, absolute episode, quality, codec,
 * HDR format, audio channels, release group, and categorizes content type.
 */

import { ContentType } from '../types/torrent.js';

export interface ParsedMetadata {
  cleanTitle: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  absoluteEpisode?: number | null;
  quality?: string | null;
  codec?: string | null;
  hdrFormat?: string | null;
  channels?: string | null;
  releaseGroup?: string | null;
  type: ContentType;
}

/**
 * Parses release title string and extracts structured metadata.
 */
export function parseTorrentTitle(rawTitle: string, defaultType?: ContentType): ParsedMetadata {
  if (!rawTitle) {
    return {
      cleanTitle: 'Unknown Title',
      type: defaultType || 'movie'
    };
  }

  // 1. Detect Season and Episode
  let season: number | null = null;
  let episode: number | null = null;
  let absoluteEpisode: number | null = null;

  // Pattern S01E05 or S1E5
  const sxxExxMatch = rawTitle.match(/\b[sS](\d{1,2})[\s._-]*[eE](\d{1,3})\b/);
  if (sxxExxMatch) {
    season = parseInt(sxxExxMatch[1], 10);
    episode = parseInt(sxxExxMatch[2], 10);
  } else {
    // Pattern Season 1 / Temporada 1
    const seasonMatch = rawTitle.match(/\b(?:Season|Temporada|Temp)[\s._-]*(\d{1,2})\b/i);
    if (seasonMatch) {
      season = parseInt(seasonMatch[1], 10);
    }
    // Pattern Episode 5 / Capitulo 5 / Ep 5
    const epMatch = rawTitle.match(/\b(?:Episode|Capitulo|Cap|Ep|Episodio)[\s._-]*(\d{1,4})\b/i);
    if (epMatch) {
      episode = parseInt(epMatch[1], 10);
    }
  }

  // Absolute episode (typically used for anime, e.g., "One Piece - 1089" or "Bleach #366")
  const absEpMatch = rawTitle.match(/(?:[\s._\-]|\b)(?:#|-)\s*(\d{2,4})(?:[\s._\-\[v]|$)/);
  if (absEpMatch && !episode) {
    absoluteEpisode = parseInt(absEpMatch[1], 10);
  }

  // 2. Detect Year (1920 - 2030)
  let year: number | null = null;
  const yearMatch = rawTitle.match(/(?:[\s._\-\(\[]|^)(19\d{2}|20[2-3]\d)(?:[\s._\-\)\]]|$)/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }

  // 3. Detect Quality / Resolution
  let quality: string | null = null;
  if (/\b(2160p|4k|uhd)\b/i.test(rawTitle)) {
    quality = '2160p';
  } else if (/\b(1080p|fhd)\b/i.test(rawTitle)) {
    quality = '1080p';
  } else if (/\b(720p|hd)\b/i.test(rawTitle)) {
    quality = '720p';
  } else if (/\b(480p|sd|576p)\b/i.test(rawTitle)) {
    quality = '480p';
  } else if (/\b(web-?dl|bluray|bdrip|webrip|dvdrip|hdtv)\b/i.test(rawTitle)) {
    const srcMatch = rawTitle.match(/\b(web-?dl|bluray|bdrip|webrip|dvdrip|hdtv)\b/i);
    quality = srcMatch ? srcMatch[0].toUpperCase() : 'HD';
  }

  // 4. Detect Codec
  let codec: string | null = null;
  if (/\b(x265|h265|hevc)\b/i.test(rawTitle)) {
    codec = 'HEVC/x265';
  } else if (/\b(x264|h264|avc)\b/i.test(rawTitle)) {
    codec = 'AVC/x264';
  } else if (/\b(av1)\b/i.test(rawTitle)) {
    codec = 'AV1';
  } else if (/\b(xvid|divx)\b/i.test(rawTitle)) {
    codec = 'XviD';
  }

  // 5. Detect HDR Format
  let hdrFormat: string | null = null;
  if (/\b(dv|dovi|dolby[\s._-]*vision)\b/i.test(rawTitle)) {
    hdrFormat = 'Dolby Vision';
  } else if (/\b(hdr10\+|hdr10plus)\b/i.test(rawTitle)) {
    hdrFormat = 'HDR10+';
  } else if (/\b(hdr10|hdr)\b/i.test(rawTitle)) {
    hdrFormat = 'HDR10';
  } else if (/\b(hlg)\b/i.test(rawTitle)) {
    hdrFormat = 'HLG';
  } else if (/\b(sdr)\b/i.test(rawTitle)) {
    hdrFormat = 'SDR';
  }

  // 6. Detect Audio Channels
  let channels: string | null = null;
  if (/\b(7\.1)\b/.test(rawTitle)) {
    channels = '7.1';
  } else if (/\b(5\.1|ddp5\.1|dd5\.1|ac3[\s._-]*5\.1)\b/i.test(rawTitle)) {
    channels = '5.1';
  } else if (/\b(2\.0|stereo|aac[\s._-]*2\.0)\b/i.test(rawTitle)) {
    channels = '2.0';
  } else if (/\b(atmos)\b/i.test(rawTitle)) {
    channels = 'Dolby Atmos';
  }

  // 7. Detect Release Group
  let releaseGroup: string | null = null;
  // Common pattern: -GROUP at end of filename or [GROUP] at start
  const groupEndMatch = rawTitle.match(/-([A-Za-z0-9_]{2,20})(?:\[.*?\]|\(.*?\)|(?:\.mkv|\.mp4|\.avi)?)$/i);
  if (groupEndMatch) {
    releaseGroup = groupEndMatch[1];
  } else {
    const groupStartMatch = rawTitle.match(/^\[([A-Za-z0-9_]{2,20})\]/);
    if (groupStartMatch) {
      releaseGroup = groupStartMatch[1];
    }
  }

  // 8. Classify Content Type ('movie', 'series', 'anime')
  let type: ContentType = defaultType || 'movie';
  const isAnimeTitle = (
    /\b(anime|subsplease|horriblesubs|erai-raws|judas|kametsu)\b/i.test(rawTitle) ||
    absoluteEpisode !== null ||
    /^\[[^\]]+\]\s*[^-\n]+-\s*\d+/.test(rawTitle)
  );

  const isSeriesTitle = (
    season !== null ||
    episode !== null ||
    /\b(s\d{1,2}|season|temporada|capitulo|complete[\s._-]*series)\b/i.test(rawTitle)
  );

  if (defaultType) {
    type = defaultType;
  } else if (isAnimeTitle) {
    type = 'anime';
  } else if (isSeriesTitle) {
    type = 'series';
  } else {
    type = 'movie';
  }

  // 9. Clean Title Extraction
  let cleanTitle = rawTitle;
  // Remove file extension
  cleanTitle = cleanTitle.replace(/\.(mkv|mp4|avi|ts)$/i, '');
  // Remove bracketed uploader prefixes e.g. [YTS.MX], [HorribleSubs]
  cleanTitle = cleanTitle.replace(/^\[[^\]]+\]\s*/, '');

  // Truncate at year, season, or resolution boundary
  const boundaryRegex = /(?:[\s._\-])(?:19\d{2}|20[2-3]\d|[sS]\d{1,2}|season|temporada|2160p|1080p|720p|480p|bluray|web-?dl|hdtv|dvdrip|latino|castellano|spanish|vose)\b/i;
  const boundaryIndex = cleanTitle.search(boundaryRegex);
  if (boundaryIndex > 3) {
    cleanTitle = cleanTitle.substring(0, boundaryIndex);
  }

  // Replace dots, underscores, dashes with space
  cleanTitle = cleanTitle.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    cleanTitle: cleanTitle || rawTitle,
    year,
    season,
    episode,
    absoluteEpisode,
    quality,
    codec,
    hdrFormat,
    channels,
    releaseGroup,
    type
  };
}

/**
 * Parses human-readable file sizes (e.g. "3.19 GB", "650 MB", "1.2 TB") to raw bytes.
 */
export function parseSizeToBytes(sizeStr: string): number | null {
  if (!sizeStr) return null;
  const match = sizeStr.trim().match(/^([\d.]+)\s*([KkMmGgTt]?[Bb]?)$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  if (isNaN(value)) return null;

  const unit = match[2].toUpperCase();
  switch (unit) {
    case 'TB':
    case 'T':
      return Math.round(value * 1024 * 1024 * 1024 * 1024);
    case 'GB':
    case 'G':
      return Math.round(value * 1024 * 1024 * 1024);
    case 'MB':
    case 'M':
      return Math.round(value * 1024 * 1024);
    case 'KB':
    case 'K':
      return Math.round(value * 1024);
    case 'B':
    default:
      return Math.round(value);
  }
}
