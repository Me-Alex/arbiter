import { chromium } from 'playwright';
import { createBrowserSession, withTinyfishSlot } from './client.mjs';

const DEFAULT_EVENT_PATTERN = /(?:-vs-|\/event(?:s)?\/|\/match(?:es)?\/|\/meci(?:uri)?\/)/i;
const DEFAULT_TOURNAMENT_PATTERN = /(?:competit|tournament|league|liga|campionat)/i;

/**
 * Discover tournament and match links directly from a TinyFish remote browser.
 * This is deterministic and much cheaper than asking an automation agent to
 * reason over a landing page. Agents are reserved for extracting odds from
 * the resulting match URLs.
 */
export async function discoverLinksViaBrowser(args) {
  return await withTinyfishSlot(() => discoverLinksInSlot(args), { signal: args.signal });
}

async function discoverLinksInSlot({
  baseUrl,
  browserProfile,
  eventUrlPattern,
  tournamentUrlPattern,
  eventElementSelector,
  eventIdSelector,
  eventIdAttribute,
  eventIdPattern,
  eventUrlTemplate,
  teamSelector,
  leagueSelector,
  stripEventQuery = false,
  maxMatches = 30,
  maxTournaments = 12,
  tournamentNavigation = true,
  settleMs = 12_000,
  onProgress = () => {},
  signal,
  live = false,
}) {
  if (signal?.aborted) throw new Error('TinyFish browser discovery aborted');
  const session = await createBrowserSession({ url: baseUrl, browserProfile });
  let browser;
  const onAbort = () => void browser?.close().catch(() => {});
  try {
    browser = await chromium.connectOverCDP(session.cdpUrl);
    signal?.addEventListener('abort', onAbort, { once: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error('TinyFish browser returned no context');
    const page = context.pages()[0] || await context.newPage();
    await settlePage(page, settleMs);

    const landingLinks = await readAnchors(page);
    const landing = classifyLinks(landingLinks, {
      baseUrl,
      eventUrlPattern,
      tournamentUrlPattern,
      stripEventQuery,
      live,
    });
    const domMatches = await readEventElements(page, {
      baseUrl,
      eventElementSelector,
      eventIdSelector,
      eventIdAttribute,
      eventIdPattern,
      eventUrlTemplate,
      teamSelector,
      leagueSelector,
      live,
    });
    const matches = new Map(
      [...landing.matches, ...domMatches].map((match) => [match.url, match]),
    );
    const tournaments = landing.tournaments.slice(0, maxTournaments);
    onProgress({ phase: 'landing', matches: matches.size, tournaments: tournaments.length });

    if (tournamentNavigation) {
      for (let index = 0; index < tournaments.length && matches.size < maxMatches; index++) {
        if (signal?.aborted) throw new Error('TinyFish browser discovery aborted');
        const tournament = tournaments[index];
        try {
          await page.goto(tournament.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await settlePage(page, settleMs);
          await scrollUntilStable(page, 4);
          const found = classifyLinks(await readAnchors(page), {
            baseUrl,
            eventUrlPattern,
              tournamentUrlPattern,
              stripEventQuery,
            live,
          });
          const foundDom = await readEventElements(page, {
            baseUrl,
            eventElementSelector,
            eventIdSelector,
            eventIdAttribute,
            eventIdPattern,
            eventUrlTemplate,
            teamSelector,
            leagueSelector,
            live,
          });
          for (const match of [...found.matches, ...foundDom]) {
            if (matches.size >= maxMatches) break;
            matches.set(match.url, { ...match, tournamentUrl: tournament.url });
          }
          onProgress({
            phase: 'tournament',
            index: index + 1,
            total: tournaments.length,
            url: tournament.url,
            matches: matches.size,
          });
        } catch (err) {
          onProgress({ phase: 'tournament-error', url: tournament.url, error: err.message });
        }
      }
    }

    return {
      strategy: 'browser',
      sessionId: session.sessionId,
      capturedAt: new Date().toISOString(),
      tournaments,
        matches: [...matches.values()].slice(0, maxMatches),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Browser.close terminates the remote CDP session, so it does not remain
    // billable after discovery.
    if (browser) await browser.close().catch(() => {});
  }
}

export function classifyLinks(links, {
  baseUrl,
  eventUrlPattern,
  tournamentUrlPattern,
  stripEventQuery = false,
  live = false,
} = {}) {
  const origin = baseUrl ? new URL(baseUrl).origin : null;
  const eventRe = toRegex(eventUrlPattern) || DEFAULT_EVENT_PATTERN;
  const tournamentRe = toRegex(tournamentUrlPattern) || DEFAULT_TOURNAMENT_PATTERN;
  const matches = new Map();
  const tournaments = new Map();

  for (const link of links || []) {
    if (!link?.href) continue;
    let url;
    try { url = new URL(link.href, baseUrl); } catch { continue; }
    if (origin && url.origin !== origin) continue;
    url.hash = '';
    const normalized = url.toString();
    const searchable = `${url.pathname}${url.search}`;

if (eventRe.test(searchable)) {
        if (stripEventQuery) url.search = '';
        const eventUrl = url.toString();
        const teams = inferTeamsFromUrl(eventUrl) || inferTeamsFromText(cleanText(link.text));
        const league = inferLeagueFromUrl(eventUrl) || inferLeagueFromText(cleanText(link.text));
        matches.set(eventUrl, {
          url: eventUrl,
          text: cleanText(link.text),
          homeTeam: teams.homeTeam,
          awayTeam: teams.awayTeam,
          league,
        kickoff: null,
        sport: 'Unknown',
        live: Boolean(live),
      });
      continue;
    }
    if (tournamentRe.test(searchable)) {
      tournaments.set(normalized, {
        url: normalized,
        name: cleanText(link.text) || url.pathname.split('/').filter(Boolean).at(-2) || 'Unknown',
        live: Boolean(live),
      });
    }
  }

  return { matches: [...matches.values()], tournaments: [...tournaments.values()] };
}

export function inferTeamsFromUrl(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const segment = [...segments].reverse().find((part) => /-vs-/i.test(part)) || '';
    const withoutId = segment.replace(/_\d.*$/, '').replace(/-\d{5,}$/, '');
    const parts = withoutId.split(/-vs-/i);
    if (parts.length !== 2) return { homeTeam: '', awayTeam: '' };
    return {
      homeTeam: fromSlug(parts[0]),
      awayTeam: fromSlug(parts[1]),
    };
  } catch {
    return { homeTeam: '', awayTeam: '' };
  }
}

export function inferTeamsFromText(text) {
  if (!text) return { homeTeam: '', awayTeam: '' };
  let cleaned = text
    .replace(/\d{2}[/:.]\d{2}(?:[/:.]\d{2,4})?/g, '')
    .replace(/\+\d+/g, '')
    .replace(/\b\d+\.\d{2,}\b/g, '')
    .replace(/\bR\d\b/g, '')
    .replace(/\b\d+\s*(?:R|P|HT|FT)\b/g, '')
    .replace(/[·|]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (/FOTBAL/i.test(cleaned)) {
    const segments = cleaned.split(/\s*FOTBAL\s*/i);
    const last = segments[segments.length - 1].trim();
    cleaned = last.replace(/^FOTBAL/, '').replace(/^[A-Za-z][\w'-]+\s+-\s+/, '').trim();
  } else {
    cleaned = cleaned.replace(/\b(?:TENIS|BASCHET|HANDBAL|VOLEI)\b/gi, '');
  }
  cleaned = cleaned.replace(/^Live\s*-\s*/i, '');
  const dashMatch = cleaned.match(/([A-Za-z][A-Za-z 0-9.'-]{2,40})\s+-\s+([A-Za-z][A-Za-z 0-9.'-]{2,40})\b/);
  if (!dashMatch) return { homeTeam: '', awayTeam: '' };
  const trailing = dashMatch[2].split(/\s+/).filter(Boolean);
  if (!trailing.length || /^(final|repriza|pariu|cote|repriz)/i.test(trailing[0])) {
    return { homeTeam: '', awayTeam: '' };
  }
  return {
    homeTeam: capitalize(dashMatch[1].trim()),
    awayTeam: capitalize(dashMatch[2].trim()),
  };
}

function capitalize(value) {
  return value
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function inferLeagueFromUrl(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const eventIndex = segments.findIndex((part) => /-vs-/i.test(part));
    if (eventIndex < 1) return null;
    const league = fromSlug(segments[eventIndex - 1].replace(/_\d.*$/, ''));
    return /^(fotbal|football|event|match|meci)$/i.test(league) ? null : league;
  } catch {
    return null;
  }
}

function inferLeagueFromText(text) {
  if (!text) return null;
  const leagueMatch = text.match(/(?:FOTBAL|TENIS|BASCHET|HANDBAL|VOLEI)\s*[-·]\s*([A-Za-z][A-Za-z' ]+?)\s*[-·]\s*FOTBAL\s*[-·]/i);
  return leagueMatch ? capitalize(leagueMatch[1].trim()) : null;
}

async function settlePage(page, settleMs) {
  await page.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => {});
  const initialWait = Math.min(2_000, settleMs);
  await page.waitForTimeout(initialWait);
  await dismissCookies(page);
  await page.waitForTimeout(Math.max(0, settleMs - initialWait));
  await dismissCookies(page);
}

async function dismissCookies(page) {
  const selectors = [
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '[data-testid="cookie-policy-dialog-accept-button"]',
    '[data-testid="accept-all-cookies"]',
  ];
  const labels = [
    /accept/i,
    /acceptă/i,
    /accepta/i,
    /allow all/i,
    /permite toate/i,
    /sunt de acord/i,
    /de acord/i,
    /continuă/i,
    /continua/i,
    /respinge/i,
  ];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const button = frame.locator(selector).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 2_000 }).catch(() => {});
        return;
      }
    }
    for (const label of labels) {
      const button = frame.getByRole('button', { name: label }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 2_000 }).catch(() => {});
        return;
      }
    }
  }
}

async function scrollUntilStable(page, iterations) {
  let previous = 0;
  for (let index = 0; index < iterations; index++) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height === previous) break;
    previous = height;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(1_500);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function readAnchors(page) {
  const anchors = [];
  for (const frame of page.frames()) {
    const found = await frame.evaluate(() => Array.from(document.querySelectorAll('a[href]'), (anchor) => ({
      href: anchor.href,
      text: anchor.textContent?.trim().replace(/\s+/g, ' ').slice(0, 500) || '',
    }))).catch(() => []);
    anchors.push(...found);
  }
  return anchors;
}

export async function readEventElements(page, {
  baseUrl,
  eventElementSelector,
  eventIdSelector,
  eventIdAttribute,
  eventIdPattern,
  eventUrlTemplate,
  teamSelector = '[title]',
  leagueSelector = '.tournament-name',
  live = false,
}) {
  if (!eventElementSelector || !eventUrlTemplate) return [];
  const idRe = toRegex(eventIdPattern) || /event-(\d+)/i;
  const matches = [];
  for (const frame of page.frames()) {
    const elements = await frame.evaluate(({ selector, idSelector, idAttribute, teams, league }) => {
      return Array.from(document.querySelectorAll(selector), (element) => {
        let teamNames = Array.from(element.querySelectorAll(teams), (team) => (
          team.getAttribute('title') || team.textContent || ''
        ).trim()).filter(Boolean);
        if (teamNames.length === 1 && /\s+-\s+/.test(teamNames[0])) {
          teamNames = teamNames[0].split(/\s+-\s+/, 2).map((name) => name.trim());
        }
        const idElement = idSelector
          ? (element.matches(idSelector) ? element : element.querySelector(idSelector))
          : element;
        const tournament = element.closest('tournament, [data-tournament], [id^="tournament-"], .tournament');
        return {
          id: (idAttribute ? idElement?.getAttribute(idAttribute) : idElement?.id)
            || element.id
            || element.getAttribute('data-event-id')
            || '',
          text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 500) || '',
          homeTeam: teamNames[0] || '',
          awayTeam: teamNames[1] || '',
          league: tournament?.querySelector(league)?.textContent?.trim().replace(/\s+/g, ' ') || null,
        };
      });
    }, {
      selector: eventElementSelector,
      idSelector: eventIdSelector,
      idAttribute: eventIdAttribute,
      teams: teamSelector,
      league: leagueSelector,
    }).catch(() => []);

    for (const element of elements) {
      const id = element.id.match(idRe)?.[1];
      if (!id) continue;
      let url;
      try { url = new URL(eventUrlTemplate.replace('{id}', encodeURIComponent(id)), baseUrl).toString(); } catch { continue; }
      const fallback = inferTeamsFromText(element.text);
      matches.push({
        url,
        text: element.text,
        homeTeam: element.homeTeam || fallback.homeTeam,
        awayTeam: element.awayTeam || fallback.awayTeam,
        league: element.league || inferLeagueFromText(element.text),
        kickoff: null,
        sport: 'Unknown',
        live: Boolean(live),
      });
    }
  }
  return matches;
}

function toRegex(value) {
  if (!value) return null;
  if (value instanceof RegExp) return value;
  return new RegExp(value, 'i');
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function fromSlug(value) {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
