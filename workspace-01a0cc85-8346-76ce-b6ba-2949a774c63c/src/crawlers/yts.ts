import { normalizeInfoHash } from '../utils/magnet.js';
import { BaseCrawler } from './base.js';
import { TorrentRecord } from '../types/torrent.js';
import { detectLanguages } from '../utils/language.js';
import { parseTorrentTitle } from '../utils/regex.js';

// Interfaces para la oficial de YTS (yts.mx/api/v2)
interface YtsApiTorrent {
  url: string;
  hash: string;
  quality: string;
  type: string;
  is_repack: string;
  video_codec: string;
  bit_depth: string;
  audio_channels: string;
  seeds: number;
  peers: number;
  size_bytes: number;
}

interface YtsApiMovie {
  id: number;
  url: string;
  slug?: string;
  imdb_code: string;
  title: string;
  title_english: string;
  year: number;
  rating: number;
  language: string;
  torrents?: YtsApiTorrent[];
}

export class YtsCrawler extends BaseCrawler {
  public readonly name = 'yts';
  
  // Usamos el dominio oficial primario y algunos espejos oficiales/conocidos
  private readonly domains = [
    'https://yts.mx',
    'https://yts.do',
    'https://yts.rs'
  ];

  // Trackers estándar que usa YTS en sus magnets
  private readonly defaultTrackers = [
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:80',
    'udp://tracker.coppersurfer.tk:6969',
    'udp://glotorrents.pw:6969/announce',
    'udp://tracker.opentrackr.org:1337/announce'
  ];

  /**
   * Construye un magnet URI estándar inyectando los trackers
   */
  private buildMagnet(infoHash: string, title: string): string {
    let magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
    for (const tr of this.defaultTrackers) {
      magnet += `&tr=${encodeURIComponent(tr)}`;
    }
    return magnet;
  }

  /**
   * Busca un dominio de YTS que esté activo y responda a la API
   */
  private async getWorkingDomain(): Promise<string | null> {
    for (const domain of this.domains) {
      try {
        console.log(`[${this.name}] Testing domain: ${domain}...`);
        const resp = await this.httpClient.get<any>(`${domain}/api/v2/list_movies.json?limit=1`, {
          timeout: 5000
        });
        
        if (resp.status === 200 && resp.data?.status === 'ok' && resp.data?.data && (Array.isArray(resp.data.data.movies) || resp.data.data.movie_count === 0)) {
          console.log(`[${this.name}] Active domain found: ${domain}`);
          return domain;
        }
      } catch (err) {
        console.warn(`[${this.name}] Domain ${domain} unreachable.`);
      }
    }
    return null;
  }

  public async crawl(maxPages: number): Promise<TorrentRecord[]> {
    console.log(`[${this.name}] Starting YTS crawl (maxPages=${maxPages})...`);
    
    const activeDomain = await this.getWorkingDomain();
    if (!activeDomain) {
      throw new Error(`[${this.name}] No compatible mirror available.`);
    }

    const results: TorrentRecord[] = [];
    const uniqueHashes = new Set<string>();

    // 'download_count' equivale a Popular, 'date_added' equivale a Recientes/Trending
    const sortModes = ['download_count', 'date_added'];

    for (const sortMode of sortModes) {
      for (let page = 1; page <= maxPages; page++) {
        try {
          // La magia de V2: Trae las películas Y sus torrents en la misma petición
          const listUrl = `${activeDomain}/api/v2/list_movies.json?sort_by=${sortMode}&limit=50&page=${page}`;
          console.log(`[${this.name}] Fetching ${sortMode} movies: ${listUrl}`);
          
          const resp = await this.httpClient.get<any>(listUrl);
          if (resp.data?.status !== 'ok' || !resp.data?.data) throw new Error('Invalid YTS API payload');
          const movies: YtsApiMovie[] = resp.data.data.movies || [];
          if (!Array.isArray(movies)) throw new Error('Invalid YTS movies array');

          if (movies.length === 0) {
            console.log(`[${this.name}] No more movies found on page ${page}.`);
            break;
          }

          for (const movie of movies) {
            if (!movie.torrents || movie.torrents.length === 0) continue;

            for (const torrent of movie.torrents) {
              const infoHash = normalizeInfoHash(torrent.hash);
              if (!infoHash) continue;
              
              // Deduplicación: Si una película es "Popular" y "Reciente", no la insertamos dos veces
              if (uniqueHashes.has(infoHash)) continue;
              uniqueHashes.add(infoHash);

              // Formateamos el título del torrent (Ej: "Movie Name 2023 1080p BluRay YTS")
              const torrentTitle = `${movie.title_english || movie.title} ${movie.year} ${torrent.quality} ${torrent.type === 'bluray' ? 'BluRay' : torrent.type} YTS`;
              
              const parsedMeta = parseTorrentTitle(torrentTitle, 'movie');
              const metaAny = parsedMeta as any;
              
              // Lógica de idiomas usando el campo nativo de la API de YTS
              const nativeLanguage = (movie.language || '').toLowerCase();
              const langHints = nativeLanguage === 'es' || nativeLanguage === 'es-es'
                ? ['spanish'] : /^es[-_](mx|ar|419)$/.test(nativeLanguage)
                ? ['latino'] : nativeLanguage === 'en' ? ['english'] : [];
              const langs = detectLanguages(torrentTitle, langHints);
              // Do not turn a French/Japanese API release into English by default.
              if (nativeLanguage && !langHints.length) langs.audio = [];

              // Normalizamos IMDB ID
              let imdbId: string | null = null;
              if (movie.imdb_code && /^tt[0-9]{7,8}$/.test(movie.imdb_code)) {
                imdbId = movie.imdb_code;
              }

              const sourceUrl = movie.url || (movie.slug ? `${activeDomain}/movies/${movie.slug}` : `${activeDomain}/movie/${movie.id}`);

              results.push({
                imdb_id: imdbId,
                tmdb_id: null,
                kitsu_id: null,
                anilist_id: null,
                mal_id: null,
                type: 'movie', // YTS es exclusivo de películas
                season: null,
                episode: null,
                absolute_episode: null,
                file_index: null,
                info_hash: infoHash,
                magnet_url: this.buildMagnet(infoHash, torrentTitle),
                torrent_file_url: torrent.url || null,
                source_url: sourceUrl,
                title: torrentTitle,
                release_group: 'YTS',
                quality: torrent.quality || metaAny.quality || metaAny.resolution || null,
                codec: torrent.video_codec || metaAny.codec || null,
                hdr_format: metaAny.hdrFormat || null,
                audio: langs.audio,
                subtitles: langs.subtitles,
                channels: torrent.audio_channels || parsedMeta.channels || null,
                size_bytes: torrent.size_bytes || 0,
                seeders: torrent.seeds || 0,
                leechers: torrent.peers || 0,
                source_tracker: this.defaultTrackers[0]
              });
            }
          }
        } catch (err: any) {
          console.warn(`[${this.name}] Error reading YTS ${sortMode} page ${page}: ${err.message}`);
          break; // Si falla la página, saltamos al siguiente modo de ordenamiento
        }
      }
    }

    console.log(`[${this.name}] Crawl completed. Total unique records retrieved: ${results.length}`);
    return results;
  }
}
