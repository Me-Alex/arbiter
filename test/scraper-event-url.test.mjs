// Contract test: every scraper's extractEvents output must carry a per-event
// browseable sourceUrl so the event-detail modal can render a link icon.
// See the event-link feature in public/js/pages/event-detail-modal.js.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(import.meta.dirname, '..');
const SCRAPERS_DIR = join(ROOT, 'src/scrapers');

// Denylist of scraper IDs that legitimately have no browseable event page.
const EXCLUDED_FROM_EVENT_URL = new Set([
  'tennis', 'basketball', 'ice-hockey', 'volleyball', 'handball', // generic sport scrapers
  'contibet', 'getsbet', // EveryMatrix WAMP — WebSocket-only
  'mozzartbet', // extractEvents returns [] until odds endpoint validated
]);

// Patterns the frontend isEventUrl() rejects
const API_PATTERNS = [
  /nsoftcdn\.com/, /nsoft\.com/, /\/api\//, /\/api2\//,
  /getPalinsestoDelGiorno/, /\?companyUuid=/, /offerTemplate=/, /dataFormat=/,
  /freetls\.fastly\.net/, /efortuna\.ro\/offer/, /sportify\.bet/,
  /gambling-solutions\.ro/, /service\/lineout/,
];

function isBrowseableEventUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  return !API_PATTERNS.some((re) => re.test(url));
}

// Only test actual scraper files (skip base, helpers, index)
const scraperFiles = readdirSync(SCRAPERS_DIR)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && !['base.mjs', 'index.mjs', 'provider-contract.mjs'].includes(f))
  .map((f) => ({ id: f.replace('.mjs', ''), src: readFileSync(join(SCRAPERS_DIR, f), 'utf8') }));

describe('scraper per-event sourceUrl contract', () => {
  for (const { id, src } of scraperFiles) {
    it(`${id}: emits browseable per-event sourceUrl`, { skip: EXCLUDED_FROM_EVENT_URL.has(id) ? `${id} excluded (generic/WAMP/placeholder)` : undefined }, () => {
      // Find extractEvents or _serializable function and verify sourceUrl is set
      const hasExtractEvents = /extractEvents\s*\(/.test(src);
      const hasSerializable = /_serializable\s*\(/.test(src);

      if (!hasExtractEvents && !hasSerializable) return; // skip pure helpers

      // Extract function bodies that push events
      let fnBody = '';
      if (hasExtractEvents) {
        const fnStart = src.indexOf('extractEvents(');
        if (fnStart !== -1) {
          let depth = 0;
          let fnEnd = src.indexOf('{', fnStart);
          for (let i = fnEnd; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
          }
          fnBody += src.slice(fnStart, fnEnd);
        }
      }
      if (hasSerializable) {
        const fnStart = src.indexOf('_serializable(');
        if (fnStart !== -1) {
          let depth = 0;
          let fnEnd = src.indexOf('{', fnStart);
          for (let i = fnEnd; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
          }
          fnBody += src.slice(fnStart, fnEnd);
        }
      }

      // Verify sourceUrl is assigned somewhere
      const hasSourceUrl = /\bsourceUrl\s*:/.test(fnBody);
      assert.ok(
        hasSourceUrl,
        `${id} must set sourceUrl on event objects in extractEvents or _serializable`,
      );
    });
  }
});

describe('all hardcoded event URLs are browseable', () => {
  it('static analysis: per-event URLs in extractEvents pass isEventUrl', () => {
    for (const { id, src } of scraperFiles) {
      if (EXCLUDED_FROM_EVENT_URL.has(id)) continue;

      // Find extractEvents function body
      const fnStart = src.indexOf('extractEvents(');
      if (fnStart === -1) continue;
      let depth = 0;
      let fnEnd = src.indexOf('{', fnStart);
      for (let i = fnEnd; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
      }
      const fnBody = src.slice(fnStart, fnEnd);

      // Find all hardcoded https URLs (not in template literals for directUrl construction)
      const urlRegex = /https?:\/\/[^\s'"`,)]+/g;
      let match;
      while ((match = urlRegex.exec(fnBody)) !== null) {
        const url = match[0];
        // Skip URLs used to construct dynamic URLs (e.g., `https://${domain}/...`)
        const lineStart = fnBody.lastIndexOf('\n', match.index);
        const line = fnBody.slice(lineStart, fnBody.indexOf('\n', match.index));
        assert.ok(
          isBrowseableEventUrl(url),
          `${id} URL "${url}" must be a browseable event page`,
        );
      }
    }
  });
});
