import { TorrentRecord } from '../types/torrent.js';
import { ResilientHttpClient } from '../utils/http.js';
import { hasValidSpanishRelease } from '../utils/language.js';

export abstract class BaseCrawler {
  public abstract readonly name: string;
  public abstract readonly baseUrl: string;
  protected httpClient: ResilientHttpClient;

  constructor() {
    this.httpClient = new ResilientHttpClient();
  }

  /**
   * Main crawl execution method to be implemented by each dedicated target site module.
   */
  public abstract crawl(maxPages: number): Promise<TorrentRecord[]>;

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
        console.log(
          `[FILTER] Discarded non-Spanish release: "${record.title}" ` +
          `(Audio: [${record.audio.join(', ')}], Subs: [${record.subtitles.join(', ')}])`
        );
      }
    }

    return { accepted, discarded };
  }
}
