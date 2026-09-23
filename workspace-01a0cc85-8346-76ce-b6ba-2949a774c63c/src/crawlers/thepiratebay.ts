import * as cheerio from 'cheerio';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';
import pLimit from 'p-limit';

interface ApibayItem {
  id: string;
  name: string;
  info_hash: string;
  leechers: string | number;
  seeders: string | number;
  size: string | number;
  category: string | number;
  imdb?: string;
}

export class ThePirateBayCrawler extends BaseCrawler {
  public readonly name = 'thepiratebay';
  public readonly baseUrl = 'https://thepiratebay.org';

  private readonly apibayBase = 'https://apibay.org';
  private readonly webMirrors = [
    'https://thepiratebay10.org',
    'https://tpb.party',
    'https://pirate-bays.net'
  ];

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting The Pirate Bay crawl (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];

    // 1. Ingesta ultrarrápida vía API oficial de The Pirate Bay (Top 100 por categorías)
    const apiEndpoints = [
      '/precompiled/data_top100_200.json', // Video General
      '/precompiled/data_top100_201.json', // Películas
      '/precompiled/data_top100_207.json', // Películas HD
      '/precompiled/data_top100_205.json', // Series TV
      '/precompiled/data_top100_208.json'  // Series TV HD
    ];

    for (const ep of apiEndpoints) {
      try {
        const apiUrl = `${this.apibayBase}${ep}`;
        console.log(`[${this.name}] Querying Apibay: ${apiUrl}`);
        const resp = await this.httpClient.get<ApibayItem[]>(apiUrl);
        const items = resp.data || [];

        if (Array.isArray(items)) {
          for (const item of items) {
            const rec = this.mapApibayItem(item);
            if (rec) results.push(rec);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.name}] Apibay ${ep} warning: ${msg}`);
      }
    }

    // 2. Búsquedas específicas de contenido en español en espejos de The Pirate Bay
    const searchTerms = ['spanish', 'castellano', 'latino'];
    const limit = pLimit(2);

    for (const term of searchTerms) {
      for (let page = 1; page <= maxPages; page++) {
        const searchTasks = this.webMirrors.map(mirror => limit(async () => {
          const searchUrl = `${mirror}/search/${term}/${page}/99/200`;
          try {
            const resp = await this.httpClient.get<string>(searchUrl);
            const $ = cheerio.load(resp.data);
            const pageRecords: TorrentRecord[] = [];

            $('#searchResult tr, table#searchResult tbody tr').each((_, el) => {
              const titleEl = $(el).find('.detName a, a.detLink');
              const magnetEl = $(el).find('a[href^="magnet:?xt="]');
              if (!titleEl.length || !magnetEl.length) return;

              const title = titleEl.text().trim();
              const magnetUrl = magnetEl.attr('href') || '';
              const parsedMagnet = parseMagnetUri(magnetUrl);
              if (!parsedMagnet || !parsedMagnet.infoHash) return;

              const tds = $(el).find('td');
              const seeders = parseInt(tds.eq(tds.length - 2).text().trim(), 10) || 0;
              const leechers = parseInt(tds.eq(tds.length - 1).text().trim(), 10) || 0;

              const descText = $(el).find('font.detDesc').text();
              const sizeMatch = descText.match(/Size\s+([^,]+)/i);
              const sizeBytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0;

              const meta = parseTorrentTitle(title, 'movie');
              const langs = detectLanguages(title, ['thepiratebay', term]);

              pageRecords.push({
                imdb_id: null,
                tmdb_id: null,
                kitsu_id: null,
                anilist_id: null,
                mal_id: null,
                type: meta.type,
                season: meta.season,
                episode: meta.episode,
                absolute_episode: meta.absoluteEpisode,
                file_index: null,
                info_hash: parsedMagnet.infoHash,
                title,
                release_group: meta.releaseGroup,
                quality: meta.quality,
                codec: meta.codec,
                hdr_format: meta.hdrFormat,
                audio: langs.audio,
                subtitles: langs.subtitles,
                channels: meta.channels,
                size_bytes: sizeBytes || 0,
                seeders,
                leechers,
                source_tracker: parsedMagnet.trackers[0] || 'udp://tracker.opentrackr.org:1337/announce'
              });
            });

            return pageRecords;
          } catch {
            return [];
          }
        }));

        const nested = await Promise.all(searchTasks);
        for (const list of nested) {
          if (list.length > 0) {
            results.push(...list);
            break;
          }
        }
      }
    }

    console.log(`[${this.name}] Total records discovered: ${results.length}`);
    return results;
  }

  private mapApibayItem(item: ApibayItem): TorrentRecord | null {
    if (!item.info_hash || !/^[0-9a-fA-F]{40}$/.test(item.info_hash) || item.name === 'No results returned') {
      return null;
    }

    const catNum = Number(item.category);
    let defaultType: ContentType = 'movie';
    if (catNum === 205 || catNum === 208) {
      defaultType = 'series';
    }

    const meta = parseTorrentTitle(item.name, defaultType);
    const langs = detectLanguages(item.name, ['thepiratebay']);

    let validImdbId: string | null = null;
    if (item.imdb && /^tt[0-9]+$/.test(item.imdb.trim())) {
      validImdbId = item.imdb.trim();
    }

    return {
      imdb_id: validImdbId,
      tmdb_id: null,
      kitsu_id: null,
      anilist_id: null,
      mal_id: null,
      type: meta.type,
      season: meta.season,
      episode: meta.episode,
      absolute_episode: meta.absoluteEpisode,
      file_index: null,
      info_hash: item.info_hash.toLowerCase(),
      title: item.name,
      release_group: meta.releaseGroup,
      quality: meta.quality,
      codec: meta.codec,
      hdr_format: meta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: meta.channels,
      size_bytes: Number(item.size) || 0,
      seeders: Number(item.seeders) || 0,
      leechers: Number(item.leechers) || 0,
      source_tracker: 'udp://tracker.opentrackr.org:1337/announce'
    };
  }
}

// Alias para compatibilidad hacia atrás
export class DivxTotalCrawler extends ThePirateBayCrawler {}
