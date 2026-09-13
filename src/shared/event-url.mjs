// shared/event-url.mjs — single source of truth for per-event bookmaker URLs.
//
// The event-detail modal renders a link icon next to each bookmaker row IF the
// event has a browseable (non-API) URL. This module centralizes the denylist
// and the `isEventUrl` predicate so scrapers, the modal, and tests all agree
// on what counts as a browseable event page.

// API/CDN/backend endpoints that are operationally not browseable event pages.
// Keeping it here (module scope) means it is built once instead of per render,
// and a reviewer can see at a glance why these URLs are rejected.
export const API_URL_PATTERNS = [
  /nsoftcdn\.com/,      // exalogic CDN (excelbet, las-vegas, winboss, magnumbet)
  /nsoft\.com/,
  /\/api\//,
  /\/api2\//,
  /getPalinsestoDelGiorno/,   // exalogic scrapers
  /\?companyUuid=/,
  /offerTemplate=/,
  /dataFormat=/,
  /freetls\.fastly\.net/,     // superbet CDN API
  /efortuna\.ro\/offer/,      // fortuna API
  /sportify\.bet/,            // netbet API
  /gambling-solutions\.ro/,   // winner API
  /service\/lineout/,         // favbet API
];

/**
 * True when `url` is a browseable event page (https/http and not a
 * scraper API/CDN endpoint). The denylist is API_URL_PATTERNS above.
 * @param {string} url
 * @returns {boolean}
 */
export function isEventUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.length > 2048) return false; // reject unbounded input before regex
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  return !API_URL_PATTERNS.some((re) => re.test(url));
}
