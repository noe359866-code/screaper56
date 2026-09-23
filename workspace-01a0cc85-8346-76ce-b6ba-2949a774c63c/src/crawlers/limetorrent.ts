import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { BaseCrawler } from './base.js';
import { TorrentRecord, ContentType } from '../types/torrent.js';
import { buildMagnetUri, parseMagnetUri } from '../utils/magnet.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle, parseSizeToBytes } from '../utils/regex.js';

interface LimeCandidate {
  title: string;
  detailUrl: string;
  sizeBytes?: number | null;
  seeders?: number;
  leechers?: number;
  type: ContentType;
}

export class LimeTorrentsCrawler extends BaseCrawler {
  public readonly name = 'limetorrents';
  public readonly baseUrl: string;

  private readonly defaultMirrors = [
    'https://limetorrent.store',
    'https://www.limetorrents.fun',
    'https://limetorrents.asia',
    'https://limetorrent.net'
  ];

  constructor() {
    super();
    this.baseUrl = process.env.LIMETORRENTS_BASE_URL || 'https://limetorrent.store';
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting crawl across catalogs and searches (maxPages=${maxPages})...`);
    const results: TorrentRecord[] = [];
    const limit = pLimit(3);

    const mirrorsToTry = [
      this.baseUrl,
      ...this.defaultMirrors.filter(m => m !== this.baseUrl)
    ];

    let workingMirror = 'https://limetorrent.store';
    for (const mirror of mirrorsToTry) {
      try {
        console.log(`[${this.name}] Testing connectivity to ${mirror}...`);
        const resp = await this.httpClient.get<string>(`${mirror}/latest100`, {
          timeout: 6000,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
          }
        });

        if (resp.status === 200 && resp.data && resp.data.length > 500) {
          workingMirror = mirror;
          console.log(`[${this.name}] Connected to active mirror: ${mirror}`);
          break;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.name}] Mirror ${mirror} unreachable: ${msg}. Trying next...`);
      }
    }

    const candidateMap = new Map<string, LimeCandidate>();

    // 1. Explorar listados populares / novedades
    const categories: Array<{ path: string; type: ContentType }> = [
      { path: '/latest100', type: 'movie' },
      { path: '/top100', type: 'movie' },
      { path: '/browse-torrents/Movies/', type: 'movie' },
      { path: '/browse-torrents/TV/', type: 'series' }
    ];

    for (const cat of categories) {
      for (let page = 1; page <= maxPages; page++) {
        let listUrl = `${workingMirror}${cat.path}`;
        if (page > 1) {
          if (cat.path.includes('browse-torrents')) {
            listUrl = `${workingMirror}${cat.path}${page}/`;
          } else {
            break;
          }
        }

        try {
          console.log(`[${this.name}] Fetching catalog listing: ${listUrl}`);
          const resp = await this.httpClient.get<string>(listUrl);
          const html = resp.data;
          if (!html || typeof html !== 'string') continue;

          const $ = cheerio.load(html);
          $('table.table2 tr').each((i, tr) => {
            if (i === 0) return;
            const tds = $(tr).find('td');
            if (tds.length < 2) return;

            const nameAnchor = tds.eq(0).find('div.tt-name a, a').last();
            const href = nameAnchor.attr('href');
            const title = nameAnchor.text().trim();
            if (!href || !title || !href.endsWith('.html')) return;

            // Filtrar contenidos inapropiados / XXX
            if (/\b(xxx|porn|onlyfans|sexo|hentai)\b/i.test(title)) return;

            const fullUrl = href.startsWith('http') ? href : `${workingMirror}${href.startsWith('/') ? '' : '/'}${href}`;
            if (candidateMap.has(fullUrl)) return;

            const sizeText = tds.eq(1).text().trim().includes('ago') ? tds.eq(2).text().trim() : tds.eq(1).text().trim();
            const seedsText = tds.eq(2).text().trim().includes('ago') ? tds.eq(3).text().trim() : tds.eq(2).text().trim();
            const leechesText = tds.eq(3).text().trim().includes('ago') ? tds.eq(4).text().trim() : tds.eq(3).text().trim();

            candidateMap.set(fullUrl, {
              title,
              detailUrl: fullUrl,
              sizeBytes: parseSizeToBytes(sizeText),
              seeders: parseInt(seedsText.replace(/,/g, ''), 10) || 0,
              leechers: parseInt(leechesText.replace(/,/g, ''), 10) || 0,
              type: cat.type
            });
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Failed fetching listing ${listUrl}: ${msg}`);
          break;
        }
      }
    }

    // 2. Búsquedas dedicadas en español (Castellano / Latino / Spanish)
    const spanishQueries = ['spanish', 'castellano', 'latino'];
    for (const q of spanishQueries) {
      try {
        console.log(`[${this.name}] Querying search for "${q}"...`);
        const searchResp = await this.httpClient.request<string>({
          method: 'POST',
          url: `${workingMirror}/search`,
          data: new URLSearchParams({ q }).toString(),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });

        const html = searchResp.data;
        if (html && typeof html === 'string') {
          const $ = cheerio.load(html);
          $('table.table2 tr').each((i, tr) => {
            if (i === 0) return;
            const tds = $(tr).find('td');
            const nameAnchor = tds.eq(0).find('div.tt-name a, a').last();
            const href = nameAnchor.attr('href');
            const title = nameAnchor.text().trim();
            if (!href || !title || !href.endsWith('.html')) return;

            // Filtrar contenidos inapropiados / XXX
            if (/\b(xxx|porn|onlyfans|sexo|hentai)\b/i.test(title)) return;

            const fullUrl = href.startsWith('http') ? href : `${workingMirror}${href.startsWith('/') ? '' : '/'}${href}`;
            if (candidateMap.has(fullUrl)) return;

            candidateMap.set(fullUrl, {
              title,
              detailUrl: fullUrl,
              type: /s\d{1,2}|season|temporada/i.test(title) ? 'series' : 'movie'
            });
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.name}] Search error for "${q}": ${msg}`);
      }
    }

    console.log(`[${this.name}] Discovered ${candidateMap.size} candidates. Extracting release details...`);

    const maxCandidates = Math.max(30, maxPages * 25);
    const candidateList = Array.from(candidateMap.values()).slice(0, maxCandidates);

    const tasks = candidateList.map(item =>
      limit(async () => {
        try {
          await new Promise(r => setTimeout(r, 100));
          const record = await this.parseLimeDetail(item, workingMirror);
          if (record) {
            results.push(record);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.name}] Error parsing ${item.detailUrl}: ${msg}`);
        }
      })
    );

    await Promise.all(tasks);
    console.log(`[${this.name}] Crawl completed. Total records extracted: ${results.length}`);
    return results;
  }

  private async parseLimeDetail(item: LimeCandidate, mirror: string): Promise<TorrentRecord | null> {
    const resp = await this.httpClient.get<string>(item.detailUrl);
    const html = resp.data;
    if (!html || typeof html !== 'string') return null;

    const $ = cheerio.load(html);

    const h1Title = $('h1').first().text().trim();
    const effectiveTitle = h1Title || item.title;
    if (!effectiveTitle) return null;

    let infoHash: string | null = null;
    let magnetUri: string | null = null;
    let sizeBytes = item.sizeBytes || null;
    let seeders = item.seeders || 0;
    let leechers = item.leechers || 0;
    const trackers: string[] = [];

    // 1. Extraer magnet si está disponible directamente en los enlaces
    $('a[href^="magnet:?xt="]').each((_, a) => {
      const h = $(a).attr('href');
      if (h && !magnetUri) {
        magnetUri = h;
      }
    });

    if (magnetUri) {
      const parsedMag = parseMagnetUri(magnetUri);
      if (parsedMag?.infoHash) {
        infoHash = parsedMag.infoHash.toLowerCase();
        if (parsedMag.trackers.length > 0) {
          trackers.push(...parsedMag.trackers);
        }
      }
    }

    // 2. Extraer campos estructurados de la tabla de detalles
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 2) {
        const k = tds.eq(0).text().trim();
        const v = tds.eq(1).text().trim();

        if (k.includes('Torrent Hash') && !infoHash) {
          const hashMatch = v.match(/([0-9a-fA-F]{40})/);
          if (hashMatch) {
            infoHash = hashMatch[1].toLowerCase();
          }
        }

        if (k.includes('Torrent Size') && !sizeBytes) {
          sizeBytes = parseSizeToBytes(v);
        }

        if (k.startsWith('udp://') || k.startsWith('http://')) {
          if (!trackers.includes(k)) {
            trackers.push(k);
          }
        }
      }
    });

    // 3. Extraer seeders y leechers del texto si no se capturaron en el listado
    if (seeders === 0 && leechers === 0) {
      const text = $.text();
      const seedMatch = text.match(/Seeders\s*:\s*(\d+)/i);
      if (seedMatch) seeders = parseInt(seedMatch[1], 10);
      const leechMatch = text.match(/Leechers\s*:\s*(\d+)/i);
      if (leechMatch) leechers = parseInt(leechMatch[1], 10);
    }

    if (!infoHash) {
      return null;
    }

    // Trackers predeterminados de alta disponibilidad
    if (trackers.length === 0) {
      trackers.push(
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://open.stealth.si:80/announce',
        'udp://open.demonii.com:1337/announce'
      );
    }

    if (!magnetUri) {
      magnetUri = buildMagnetUri(infoHash, effectiveTitle, trackers);
    }

    const parsedMeta = parseTorrentTitle(effectiveTitle, item.type);
    const langs = detectLanguages(effectiveTitle, ['limetorrents']);

    return {
      imdb_id: null,
      tmdb_id: null,
      kitsu_id: null,
      anilist_id: null,
      mal_id: null,
      type: parsedMeta.type,
      season: parsedMeta.season,
      episode: parsedMeta.episode,
      absolute_episode: parsedMeta.absoluteEpisode,
      file_index: null,
      info_hash: infoHash,
      magnet_url: magnetUri,
      torrent_file_url: null,
      source_url: item.detailUrl,
      title: effectiveTitle,
      release_group: parsedMeta.releaseGroup,
      quality: parsedMeta.quality,
      codec: parsedMeta.codec,
      hdr_format: parsedMeta.hdrFormat,
      audio: langs.audio,
      subtitles: langs.subtitles,
      channels: parsedMeta.channels,
      size_bytes: sizeBytes,
      seeders,
      leechers,
      source_tracker: trackers[0] || 'udp://tracker.opentrackr.org:1337/announce'
    };
  }
}

export default LimeTorrentsCrawler;
