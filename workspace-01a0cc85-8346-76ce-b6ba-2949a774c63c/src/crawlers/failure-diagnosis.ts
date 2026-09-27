import { MirrorResolutionError } from './mirrors.js';
import { describeError } from './support.js';

export type FailureKind = 'dns' | 'network' | 'blocked' | 'layout' | 'empty' | 'timeout' | 'download' | 'unknown';

/** Operational next steps, not promises that a domain or an extraction method works. */
const sourceHints: Record<string, string> = {
  leech1337x: 'Verify a reachable 1337x mirror with LEECH1337X_MIRRORS; then inspect search and /torrent/ pages.',
  pelispanda: 'Check the wpreact WordPress API response and PELISPANDA_MIRRORS before changing movie/season parsing.',
  torrentgalaxy: 'Verify TORRENTGALAXY_MIRRORS serves tgxtable rows and check /torrents.php pagination.',
  elitetorrent: 'Check ELITETORRENT_MIRRORS and public /peliculas or /series listings; protected downloads cannot be assumed usable.',
  limetorrents: 'Verify LIMETORRENTS_MIRRORS exposes /latest100 or /top100 table2 rows; compare search POST/GET.',
  wolftorrent: 'Verify WOLFTORRENT_MIRRORS serves /peliculas; inspect detail download buttons without persisting blob URLs.',
  dontorrent: 'Verify DONTORRENT_MIRRORS; proof-of-work and time-gated downloads are intentionally skipped, not bypassed.',
  magnetdl: 'Verify MAGNETDL_MIRRORS serves /download/movies/ and /single/:id magnets.',
  rarbg: 'Verify RARBG_MIRRORS is a compatible clone serving /movies/; the original RARBG cannot be assumed available.',
  grantorrent: 'Verify GRANTORRENT_MIRRORS serves movie cards; external shorteners are counted as gated, never used as torrent URLs.'
};

export function diagnoseFailure(source: string, error: unknown): { kind: FailureKind; advice: string } {
  const message = describeError(error);
  const attempts = error instanceof MirrorResolutionError ? error.attempts.map(a => a.reason) : [];
  const reasons = attempts.length ? attempts : [message];
  const all = (pattern: RegExp) => reasons.every(reason => pattern.test(reason));
  const any = (pattern: RegExp) => reasons.some(reason => pattern.test(reason));
  // Classify mirror attempts individually: a single timed-out probe must not
  // turn an otherwise DNS/TLS failure into an overall timeout.
  let kind: FailureKind = 'unknown';
  if (all(/ENOTFOUND|EAI_AGAIN|DNS/i)) kind = 'dns';
  else if (all(/time(?:d)?\s*out|deadline|ETIMEDOUT/i)) kind = 'timeout';
  else if (all(/403|429|captcha|cloudflare|blocked|challenge/i)) kind = 'blocked';
  else if (all(/unexpected payload|layout|invalid json|parse/i)) kind = 'layout';
  else if (attempts.length && any(/ENOTFOUND|EAI_AGAIN|socket|TLS|ECONN|network|ETIMEDOUT/i)) kind = 'network';
  else if (/proof.of.work|gated|hourly limit|No verified infohash/i.test(message)) kind = 'download';
  else if (/time(?:d)?\s*out|deadline|ETIMEDOUT/i.test(message)) kind = 'timeout';
  else if (/403|429|captcha|cloudflare|blocked|challenge/i.test(message)) kind = 'blocked';
  else if (/unexpected payload|layout|invalid json|parse/i.test(message)) kind = 'layout';
  else if (/zero extracted|no usable releases|no records/i.test(message)) kind = 'empty';
  else if (/ENOTFOUND|EAI_AGAIN|socket|TLS|ECONN|network/i.test(message)) kind = 'network';

  const action: Record<FailureKind, string> = {
    dns: 'All probes failed DNS: check DNS from the runner and configure an authorized reachable mirror.',
    network: 'Mirror connectivity failed or was mixed: test DNS/TLS from the runner; do not rewrite parsers yet.',
    blocked: 'The site refused access: stop repeated requests; check site policy and do not automate interactive challenges.',
    layout: 'A response arrived but did not match the expected site: inspect a permitted response fixture before changing selectors.',
    empty: 'No usable infohash was extracted: inspect listing, detail and download metrics; an empty run is not success.',
    timeout: 'The execution budget expired: inspect which probe/request stalled before increasing timeouts.',
    download: 'Downloads were gated or missing: do not manufacture hashes or bypass site restrictions.',
    unknown: 'Inspect the fatal error and per-crawler metrics.'
  };
  return { kind, advice: `${action[kind]} ${sourceHints[source] ?? ''}`.trim() };
}

/** Bound multi-mirror errors in summary logs while keeping the full error in debug logs. */
export function summarizeFailure(error: unknown, maxLength = 600): string {
  const text = describeError(error).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}
