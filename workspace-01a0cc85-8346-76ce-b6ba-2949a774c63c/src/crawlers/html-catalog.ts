import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { BaseCrawler } from './base.js';
import { ContentType, TorrentRecord } from '../types/torrent.js';
import { parseTorrentBuffer } from '../utils/bencode2.js';
import { buildMagnetUri, parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';

export interface DownloadLink {
  url: string;
  title: string;
  hints?: string[];
  buffer?: Buffer;
}
export interface CatalogDetail {
  title: string;
  type: ContentType;
  downloads: DownloadLink[];
}

/** Shared transport only; selectors, routes and link decoding belong to each site. */
export abstract class HtmlCatalogCrawler extends BaseCrawler {
  public abstract readonly baseUrl: string;
  protected abstract readonly sections: string[];
  public abstract parseListing(html: string, url: string): string[];
  public abstract parseDetail(html: string, url: string): CatalogDetail;

  protected async discoverDownloads(html: string, url: string): Promise<CatalogDetail> {
    return this.parseDetail(html, url);
  }

  public nextPage(html: string, current: string): string | null {
    const $ = cheerio.load(html);
    const currentUrl = new URL(current);
    for (const el of $('a[rel="next"], .pagination a, .navigation a, .pages a, .pagi a').toArray()) {
      const a = $(el);
      if (a.attr('rel') !== 'next' && !/siguiente|next|[»›→]/i.test(a.text())) continue;
      const next = httpUrl(a.attr('href'), current);
      if (next && new URL(next).origin === currentUrl.origin && next !== current) return next;
    }
    return null;
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) return [];
    const results: TorrentRecord[] = [];
    const seenDetails = new Set<string>();
    const seenListings = new Set<string>();
    const limit = pLimit(2);
    let listingsRead = 0;
    for (const section of this.sections) {
      let listUrl: string | null = new URL(section, this.baseUrl).href;
      for (let page = 0; listUrl && page < maxPages; page++) {
        if (seenListings.has(listUrl)) break;
        seenListings.add(listUrl);
        try {
          const response = await this.httpClient.get<string>(listUrl);
          if (typeof response.data !== 'string') throw new Error('Expected HTML catalog');
          listingsRead++;
          const details = this.parseListing(response.data, listUrl).filter(url => {
            if (seenDetails.has(url)) return false;
            seenDetails.add(url);
            return true;
          });
          const batches = await Promise.all(details.map(url => limit(async () => {
            try {
              const response = await this.httpClient.get<string>(url, { headers: { Referer: this.baseUrl } });
              const detail = await this.discoverDownloads(response.data, url);
              const records: TorrentRecord[] = [];
              const seenDownloads = new Set<string>();
              for (const download of detail.downloads) {
                if (seenDownloads.has(download.url)) continue;
                seenDownloads.add(download.url);
                try {
                  const record = await this.buildDownload(download, detail, url);
                  if (record) records.push(record);
                } catch (error) {
                  console.warn(`[${this.name}] Invalid/unavailable download ${download.url}: ${String(error)}`);
                }
              }
              if (!records.length) console.warn(`[${this.name}] No valid torrent in ${url} (layout, login or download unavailable).`);
              return records;
            } catch (error) {
              console.warn(`[${this.name}] Detail failed ${url}: ${String(error)}`);
              return [];
            }
          })));
          results.push(...batches.flat());
          // Follow real pagination links, not guessed routes; visited URLs break loops.
          listUrl = this.nextPage(response.data, listUrl);
        } catch (error) {
          console.warn(`[${this.name}] Catalog failed ${listUrl}: ${String(error)}`);
          break;
        }
      }
    }
    if (!listingsRead || !seenDetails.size || !results.length) {
      throw new Error(`[${this.name}] No usable releases: catalogs=${listingsRead}, details=${seenDetails.size}. Check connectivity, layout and public downloads.`);
    }
    return this.deduplicateRecords(results);
  }

  private async buildDownload(download: DownloadLink, detail: CatalogDetail, sourceUrl: string): Promise<TorrentRecord | null> {
    const magnet = parseMagnetUri(download.url);
    let torrent = null;
    if (!magnet) {
      if (!download.buffer && !httpUrl(download.url, sourceUrl)) return null;
      const buffer = download.buffer ?? await this.httpClient.getBuffer(download.url, {
        maxContentLength: 10 * 1024 * 1024,
        headers: { Referer: sourceUrl, Accept: 'application/x-bittorrent,application/octet-stream;q=0.9,*/*;q=0.5' }
      });
      torrent = parseTorrentBuffer(buffer);
      if (!torrent) throw new Error('Response is not valid v1/hybrid torrent metainfo');
    }
    const hash = magnet?.infoHash || torrent?.infoHash;
    if (!hash) return null;
    const title = magnet?.displayName || download.title || torrent?.name || detail.title;
    const context = [title, torrent?.name || '', ...(download.hints || [])].join(' ');
    const meta = parseTorrentTitle(context, detail.type);
    const languages = detectLanguages(context, [], false);
    const trackers = magnet?.trackers || torrent?.trackers || [];
    return {
      title, type: meta.type, info_hash: hash,
      magnet_url: magnet ? download.url : buildMagnetUri(hash, title, trackers),
      torrent_file_url: magnet ? null : httpUrl(download.url, sourceUrl), source_url: sourceUrl,
      season: meta.season, episode: meta.episode, absolute_episode: meta.absoluteEpisode,
      quality: meta.resolution || meta.source, codec: meta.codec, hdr_format: meta.hdrFormat,
      release_group: meta.releaseGroup, channels: meta.channels,
      audio: languages.audio, subtitles: languages.subtitles,
      size_bytes: torrent?.sizeBytes ?? null, seeders: null, leechers: null,
      source_tracker: trackers[0] || null
    };
  }
}

export function httpUrl(value: string | undefined, base: string): string | null {
  if (!value || value.startsWith('#')) return null;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}
