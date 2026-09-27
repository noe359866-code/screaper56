import type { CheerioAPI, Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import { cleanText, dedupeStrings } from './support.js';

/** Public literal links only: no eval, remote scripts, shortener traversal or guessed hashes. */
export const DOWNLOAD_NODES = 'a[href], [data-url], [data-href], [data-torrent], [data-magnet], [data-download], [data-file], [onclick]';
export function literalDownloadCandidates(node: Cheerio<Element>): string[] {
  const values = ['href', 'data-url', 'data-href', 'data-torrent', 'data-magnet', 'data-download', 'data-file']
    .map(attr => node.attr(attr) || '').filter(Boolean);
  const onclick = node.attr('onclick') || '';
  for (const match of onclick.matchAll(/['"]([^'"\n]+)['"]/g)) values.push(match[1]);
  for (const match of onclick.matchAll(/atob\(\s*['"]([A-Za-z0-9+/=]{1,8192})['"]\s*\)/g)) {
    values.push(Buffer.from(match[1], 'base64').toString('utf8'));
  }
  return dedupeStrings(values);
}

/** Read labelled release fields, not navigation, comments, plots or related releases. */
export function spanishReleaseHints($: CheerioAPI): string[] {
  const hints: string[] = [];
  const label = /^(?:idiomas?|audio|subt[ií]tulos?|calidad|formato|resoluci[oó]n)\s*:/i;
  $('p, li, tr, dt, .ficha span, .descrip span').each((_, el) => {
    const node = $(el);
    if (node.closest('nav, header, footer, .comments, #dle-comments-list, .related, .sidebar').length) return;
    let text = cleanText(node.text());
    if (node.is('dt')) text += ` ${cleanText(node.next('dd').text())}`;
    if (text.length <= 240 && label.test(text)) {
      // Normalise subtitle labels before language detection, rather than treating them as audio.
      text = text.replace(/^subt[ií]tulos?\s*:\s*(?:espa[ñn]ol|castellano|spanish)\b/i, 'Sub_ES')
        .replace(/^subt[ií]tulos?\s*:\s*(?:ingl[eé]s|english)\b/i, 'Sub_EN');
      hints.push(text);
    }
  });
  return dedupeStrings(hints);
}
