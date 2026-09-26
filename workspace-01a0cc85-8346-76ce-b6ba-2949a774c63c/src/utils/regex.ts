/**
 * Advanced Regex-based BitTorrent Title and Metadata Parsing Engine.
 * Extracts title, year, season, episode, absolute episode, quality, source, codec,
 * HDR format, audio channels, release group, and categorizes content type.
 */

import { ContentType } from '../types/torrent.js';

export interface ParsedMetadata {
  cleanTitle: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  absoluteEpisode?: number | null;
  resolution?: string | null;  // 1080p, 4K (Renombrado de quality para más claridad)
  source?: string | null;      // WEB-DL, BluRay (Separado de resolución)
  codec?: string | null;
  hdrFormat?: string | null;
  channels?: string | null;
  releaseGroup?: string | null;
  type: ContentType;
}

// ============================================================================
// PRE-COMPILED REGULAR EXPRESSIONS (For extreme performance)
// ============================================================================

// Seasons & Episodes
const REGEX_SXX_EXX = /\b[sS](\d{1,2})[\s._-]*[eE](\d{1,3})\b/;
const REGEX_SEASON_WORD = /\b(?:Season|Temporada|Temp)[\s._-]*(\d{1,2})\b/i;
const REGEX_EPISODE_WORD = /\b(?:Episode|Cap[ií]tulo|Cap|Ep|Episodio)[\s._-]*(\d{1,4})\b/i;
const REGEX_ABS_EP = /(?:[\s._\-]|\b)(?:#|-)\s*(\d{2,4})(?:[\s._\-\[v]|$)/;

// Year (Fixed to support 1900 - 2099)
const REGEX_YEAR = /(?:[\s._\-\(\[]|^)(19\d{2}|20\d{2})(?:[\s._\-\)\]]|$)/;

// Resolution & Source
const REGEX_RES_2160 = /\b(2160p|4k|uhd)\b/i;
const REGEX_RES_1080 = /\b(1080p|fhd)\b/i;
const REGEX_RES_720 = /\b(720p|hd)\b/i;
const REGEX_RES_480 = /\b(480p|sd|576p)\b/i;
const REGEX_SOURCE = /\b(web-?dl|bluray|bdrip|webrip|dvdrip|hdtv|cam|ts|tc)\b/i;

// Codec
const REGEX_CODEC_HEVC = /\b(x265|h265|hevc)\b/i;
const REGEX_CODEC_AVC = /\b(x264|h264|avc)\b/i;
const REGEX_CODEC_AV1 = /\b(av1)\b/i;
const REGEX_CODEC_XVID = /\b(xvid|divx)\b/i;

// HDR
const REGEX_HDR_DV = /\b(dv|dovi|dolby[\s._-]*vision)\b/i;
const REGEX_HDR_10PLUS = /\b(hdr10\+|hdr10plus)\b/i;
const REGEX_HDR_10 = /\b(hdr10|hdr)\b/i;
const REGEX_HDR_HLG = /\b(hlg)\b/i;
const REGEX_HDR_SDR = /\b(sdr)\b/i;

// Audio Channels
const REGEX_CH_71 = /\b(7\.1)\b/;
const REGEX_CH_51 = /\b(5\.1|ddp5\.1|dd5\.1|ac3[\s._-]*5\.1)\b/i;
const REGEX_CH_20 = /\b(2\.0|stereo|aac[\s._-]*2\.0)\b/i;
const REGEX_CH_ATMOS = /\b(atmos)\b/i;

// Release Groups
const REGEX_GROUP_END = /-([A-Za-z0-9_]{2,20})(?:\[.*?\]|\(.*?\)|(?:\.mkv|\.mp4|\.avi)?)$/i;
const REGEX_GROUP_START = /^\[([A-Za-z0-9_]{2,20})\]/;

// Classification Rules
const REGEX_ANIME_KEYWORDS = /\b(anime|subsplease|horriblesubs|erai-raws|judas|kametsu)\b/i;
const REGEX_ANIME_BRACKETS = /^\[[^\]]+\]\s*[^-\n]+-\s*\d+/;
const REGEX_SERIES_KEYWORDS = /\b(s\d{1,2}|season|temporada|capitulo|complete[\s._-]*series)\b/i;

// Title Cleaning
const REGEX_EXTENSIONS = /\.(mkv|mp4|avi|ts)$/i;
const REGEX_PREFIX_BRACKETS = /^\[[^\]]+\]\s*/;
const REGEX_BOUNDARY = /(?:[\s._\-])(?:19\d{2}|20\d{2}|[sS]\d{1,2}|season|temporada|2160p|1080p|720p|480p|bluray|web-?dl|hdtv|dvdrip|latino|castellano|spanish|vose)\b/i;
const REGEX_CLEAN_PUNCTUATION = /[._]/g;
const REGEX_MULTIPLE_SPACES = /\s+/g;
const REGEX_FILE_SIZE = /^(\d+(?:[.,]\d+)?)\s*([KMGT]?(?:i?B)?)$/i;

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

  let season: number | null = null;
  let episode: number | null = null;
  let absoluteEpisode: number | null = null;

  // 1. Detect Season and Episode
  const sxxExxMatch = rawTitle.match(REGEX_SXX_EXX) || rawTitle.match(/\b(\d{1,2})[x×](\d{1,3})\b/i);
  if (sxxExxMatch) {
    season = parseInt(sxxExxMatch[1], 10);
    episode = parseInt(sxxExxMatch[2], 10);
  } else {
    const seasonMatch = rawTitle.match(REGEX_SEASON_WORD) || rawTitle.match(/\b(\d{1,2})[ªºa]?\s*Temporada\b/i) || rawTitle.match(/\b[ST](\d{1,2})\b/i);
    if (seasonMatch) season = parseInt(seasonMatch[1], 10);

    const epMatch = rawTitle.match(REGEX_EPISODE_WORD);
    if (epMatch) episode = parseInt(epMatch[1], 10);
  }

  const absEpMatch = rawTitle.match(REGEX_ABS_EP);
  if (absEpMatch && !episode) {
    absoluteEpisode = parseInt(absEpMatch[1], 10);
  }

  // 2. Detect Year (1900 - 2099)
  let year: number | null = null;
  const yearMatch = rawTitle.match(REGEX_YEAR);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }

  // 3A. Detect Resolution (Previously "Quality")
  let resolution: string | null = null;
  if (REGEX_RES_2160.test(rawTitle)) resolution = '2160p';
  else if (REGEX_RES_1080.test(rawTitle)) resolution = '1080p';
  else if (REGEX_RES_720.test(rawTitle)) resolution = '720p';
  else if (REGEX_RES_480.test(rawTitle)) resolution = '480p';

  // 3B. Detect Source Independent of Resolution
  let source: string | null = null;
  const srcMatch = rawTitle.match(REGEX_SOURCE);
  if (srcMatch) source = srcMatch[1].toUpperCase();

  // 4. Detect Codec
  let codec: string | null = null;
  if (REGEX_CODEC_HEVC.test(rawTitle)) codec = 'HEVC/x265';
  else if (REGEX_CODEC_AVC.test(rawTitle)) codec = 'AVC/x264';
  else if (REGEX_CODEC_AV1.test(rawTitle)) codec = 'AV1';
  else if (REGEX_CODEC_XVID.test(rawTitle)) codec = 'XviD';

  // 5. Detect HDR Format
  let hdrFormat: string | null = null;
  if (REGEX_HDR_DV.test(rawTitle)) hdrFormat = 'Dolby Vision';
  else if (REGEX_HDR_10PLUS.test(rawTitle)) hdrFormat = 'HDR10+';
  else if (REGEX_HDR_10.test(rawTitle)) hdrFormat = 'HDR10';
  else if (REGEX_HDR_HLG.test(rawTitle)) hdrFormat = 'HLG';
  else if (REGEX_HDR_SDR.test(rawTitle)) hdrFormat = 'SDR';

  // 6. Detect Audio Channels
  let channels: string | null = null;
  if (REGEX_CH_71.test(rawTitle)) channels = '7.1';
  else if (REGEX_CH_51.test(rawTitle)) channels = '5.1';
  else if (REGEX_CH_20.test(rawTitle)) channels = '2.0';
  else if (REGEX_CH_ATMOS.test(rawTitle)) channels = 'Dolby Atmos';

  // 7. Detect Release Group
  let releaseGroup: string | null = null;
  const groupEndMatch = rawTitle.match(REGEX_GROUP_END);
  if (groupEndMatch) {
    releaseGroup = groupEndMatch[1];
  } else {
    const groupStartMatch = rawTitle.match(REGEX_GROUP_START);
    if (groupStartMatch) releaseGroup = groupStartMatch[1];
  }

  // 8. Classify Content Type ('movie', 'series', 'anime')
  let type: ContentType = defaultType || 'movie';
  const isAnimeTitle = (
    REGEX_ANIME_KEYWORDS.test(rawTitle) ||
    absoluteEpisode !== null ||
    REGEX_ANIME_BRACKETS.test(rawTitle)
  );

  const isSeriesTitle = (
    season !== null ||
    episode !== null ||
    REGEX_SERIES_KEYWORDS.test(rawTitle)
  );

  if (defaultType) {
    type = defaultType;
  } else if (isAnimeTitle) {
    type = 'anime';
  } else if (isSeriesTitle) {
    type = 'series';
  }

  // 9. Clean Title Extraction
  let cleanTitle = rawTitle;
  cleanTitle = cleanTitle.replace(REGEX_EXTENSIONS, '');
  cleanTitle = cleanTitle.replace(REGEX_PREFIX_BRACKETS, '');

  const boundaryIndex = cleanTitle.search(REGEX_BOUNDARY);
  if (boundaryIndex > 3) {
    cleanTitle = cleanTitle.substring(0, boundaryIndex);
  }

  cleanTitle = cleanTitle.replace(REGEX_CLEAN_PUNCTUATION, ' ').replace(REGEX_MULTIPLE_SPACES, ' ').trim();

  return {
    cleanTitle: cleanTitle || rawTitle,
    year,
    season,
    episode,
    absoluteEpisode,
    resolution, // Was 'quality'
    source,     // New field
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
  const match = sizeStr.trim().match(REGEX_FILE_SIZE);
  if (!match) return null;

  const value = Number(match[1].replace(',', '.'));
  if (isNaN(value)) return null;

  const unit = match[2].toUpperCase().replace('IB', 'B');
  switch (unit) {
    case 'TB':
    case 'T': return Math.round(value * 1099511627776); // 1024^4 (Exact math is slightly faster)
    case 'GB':
    case 'G': return Math.round(value * 1073741824); // 1024^3
    case 'MB':
    case 'M': return Math.round(value * 1048576); // 1024^2
    case 'KB':
    case 'K': return Math.round(value * 1024);
    case 'B':
    default: return Math.round(value);
  }
}
