import { TorrentRecord } from '../types/torrent.js';
import { ResilientHttpClient } from '../utils/http.js';
import { normalizeInfoHash } from '../utils/magnet.js';
import { hasValidSpanishRelease } from '../utils/language.js';

export abstract class BaseCrawler {
  public abstract readonly name: string;
  
  // Lo hacemos opcional (?). Muchos crawlers modernos usan un array de mirrors
  // internamente (Ej: EliteTorrent, TGX) en lugar de una única URL base fija.
  public baseUrl?: string;
  
  protected httpClient: ResilientHttpClient;

  constructor() {
    this.httpClient = new ResilientHttpClient();
  }

  /**
   * Main crawl execution method to be implemented by each dedicated target site module.
   */
  public abstract crawl(maxPages: number): Promise<TorrentRecord[]>;

  /**
   * UTILIDAD COMPARTIDA: Elimina torrents duplicados basándose en el info_hash.
   * Centralizamos esto aquí para que cualquier Crawler pueda limpiar sus arrays
   * antes de retornarlos a la base de datos.
   */
  public deduplicateRecords(records: TorrentRecord[]): TorrentRecord[] {
    const uniqueHashes = new Set<string>();
    const deduplicated: TorrentRecord[] = [];

    for (const record of records) {
      if (!record.info_hash) continue;
      
      const hash = normalizeInfoHash(record.info_hash);
      if (!hash || /^0{40}$/.test(hash)) continue;
      if (!uniqueHashes.has(hash)) {
        uniqueHashes.add(hash);
        deduplicated.push({ ...record, info_hash: hash });
      }
    }
    
    return deduplicated;
  }

  /**
   * Filters discovered torrents strictly enforcing Spanish-language availability:
   * Requires Spanish audio (Castellano or Latino) OR Spanish subtitles.
   */
  public filterSpanishReleases(records: TorrentRecord[]): {
    accepted: TorrentRecord[];
    discarded: TorrentRecord[];
  } {
    const accepted: TorrentRecord[] = [];
    const discarded: TorrentRecord[] = [];

    for (const record of records) {
      if (hasValidSpanishRelease(record.audio, record.subtitles)) {
        accepted.push(record);
      } else {
        discarded.push(record);
      }
    }

    // En lugar de hacer "spam" en la consola 1000 veces, mostramos un resumen analítico.
    // Esto salva el Event Loop de Node.js y hace los logs mucho más legibles.
    if (discarded.length > 0) {
      console.log(
        `[${this.name}] Language Filter: Accepted ${accepted.length} Spanish valid records. Discarded ${discarded.length} foreign records.`
      );
    } else if (accepted.length > 0) {
      console.log(`[${this.name}] Language Filter: All ${accepted.length} records passed the Spanish filter.`);
    }

    return { accepted, discarded };
  }
}
