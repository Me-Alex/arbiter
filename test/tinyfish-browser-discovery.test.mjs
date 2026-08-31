import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLinks,
  inferTeamsFromUrl,
} from '../src/tinyfish/browser-discovery.mjs';

test('inferTeamsFromUrl parses Superbet event slugs', () => {
  assert.deepEqual(
    inferTeamsFromUrl('https://superbet.ro/cote/fotbal/cagliari-vs-inter-milano-13486105'),
    { homeTeam: 'Cagliari', awayTeam: 'Inter Milano' },
  );
});

test('inferTeamsFromUrl handles nested and underscore-suffixed event URLs', () => {
  assert.deepEqual(
    inferTeamsFromUrl('https://www.unibet.ro/betting/odds/football/romania/superliga/farul-constanta-vs-botosani/65ef650d'),
    { homeTeam: 'Farul Constanta', awayTeam: 'Botosani' },
  );
  assert.deepEqual(
    inferTeamsFromUrl('https://excelbet.ro/sport/fotbal/liga-i/fcsb-vs-uta-arad_1_-387_94'),
    { homeTeam: 'Fcsb', awayTeam: 'Uta Arad' },
  );
});

test('classifyLinks separates event and tournament URLs', () => {
  const links = [
    {
      href: 'https://superbet.ro/cote/fotbal/cagliari-vs-inter-milano-13486105',
      text: 'Cagliari Inter Milano',
    },
    {
      href: 'https://superbet.ro/pariuri-sportive/fotbal/italia/serie-a/toate',
      text: 'Serie A',
    },
    {
      href: 'https://example.com/not-allowed',
      text: 'External',
    },
  ];
  const result = classifyLinks(links, {
    baseUrl: 'https://superbet.ro/pariuri-sportive/fotbal',
    eventUrlPattern: '\\/cote\\/fotbal\\/',
    tournamentUrlPattern: '\\/pariuri-sportive\\/fotbal\\/.+\\/toate',
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.tournaments.length, 1);
  assert.equal(result.matches[0].homeTeam, 'Cagliari');
  assert.equal(result.tournaments[0].name, 'Serie A');
});

test('classifyLinks strips event query strings before deduplication', () => {
  const links = [
    { href: 'https://superbet.ro/cote/fotbal/a-vs-b-1', text: 'A B' },
    { href: 'https://superbet.ro/cote/fotbal/a-vs-b-1?marketGroup=116', text: 'A B offer' },
  ];
  const result = classifyLinks(links, {
    baseUrl: 'https://superbet.ro',
    eventUrlPattern: '\\/cote\\/fotbal\\/',
    stripEventQuery: true,
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].url, 'https://superbet.ro/cote/fotbal/a-vs-b-1');
});

test('classifyLinks marks links discovered from a live route', () => {
  const result = classifyLinks([
    { href: 'https://superbet.ro/cote/fotbal/a-vs-b-1', text: 'A B' },
  ], {
    baseUrl: 'https://superbet.ro/pariuri-sportive/fotbal/live',
    eventUrlPattern: '\\/cote\\/fotbal\\/',
    live: true,
  });
  assert.equal(result.matches[0].live, true);
});
