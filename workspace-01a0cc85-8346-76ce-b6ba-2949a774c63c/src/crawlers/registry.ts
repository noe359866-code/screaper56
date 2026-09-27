import type { BaseCrawler } from './base.js';

// Type mapping para la carga perezosa (Lazy Dynamic Import)
type CrawlerFactory = () => Promise<BaseCrawler>;

/**
 * Mapeo de crawlers con Dynamic Imports.
 * Solo carga en memoria el código JS de los crawlers activos en la ejecución.
 */
export const CRAWLER_REGISTRY: Record<string, CrawlerFactory> = {
  pelispanda: async () => new (await import('./pelispanda.js')).PelispandaCrawler(),
  leech1337x: async () => new (await import('./leech1337x.js')).Leech1337xCrawler(),
  torrentgalaxy: async () => new (await import('./torrentgalaxy.js')).TorrentGalaxyCrawler(),
  yts: async () => new (await import('./yts.js')).YtsCrawler(),
  eztv: async () => new (await import('./eztv.js')).EztvCrawler(),
  thepiratebay: async () => new (await import('./thepiratebay.js')).ThePirateBayCrawler(),
  mejortorrent: async () => new (await import('./mejortorrent.js')).MejorTorrentCrawler(),
  elitetorrent: async () => new (await import('./elitetorrent.js')).EliteTorrentCrawler(),
  limetorrents: async () => new (await import('./limetorrent.js')).LimeTorrentsCrawler(),
  nyaa: async () => new (await import('./nyaa.js')).NyaaCrawler(),
  wolftorrent: async () => new (await import('./wolftorrent.js')).WolftorrentCrawler(),
  sinsitio: async () => new (await import('./sinsitio.js')).SinsitioCrawler(),
  dontorrent: async () => new (await import('./dontorrent.js')).DonTorrentCrawler(),
  rarbg: async () => new (await import('./rarbg.js')).RarbgCrawler(),
  magnetdl: async () => new (await import('./magnetdl.js')).MagnetDlCrawler(),
  grantorrent: async () => new (await import('./grantorrent.js')).GranTorrentCrawler(),
  tokyotosho: async () => new (await import('./tokyotosho.js')).TokyoToshoCrawler(),
  rutracker: async () => new (await import('./rutracker.js')).RutrackerCrawler()
};

