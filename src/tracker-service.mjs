import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './shared/atomic-write.mjs';
import { csvRow, parseCsvLine } from './shared/csv.mjs';

import { ALERT_SCHEMA, normalizeAlertPreferences } from './alert-engine.mjs';

/**
 * tracker-service.mjs — bet tracker + alert preferences + CSV import/export.
 *
 * Persists two files:
 *   data/bet-tracker.json
 *   data/alert-preferences.json
 *
 * Schema versioning lets us migrate without crashing older dashboards.
 *
 * The alert defaults used to be written out here as a second copy of what
 * alert-engine.mjs needs, and the two had already drifted — this one said 1%
 * and 25% while the scanner computed from 0% and 20%, and nothing read either.
 * They are read from the engine now, and normalized on the way in and out, so
 * a hand-edited settings file is repaired rather than passed through: a
 * threshold that arrived as NaN would compare false against everything and
 * quietly alert on nothing.
 */

const TRACKER_SCHEMA = 1;

export class TrackerService {
  constructor({ dataDir, logger = () => {} }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.trackerPath = join(dataDir, 'bet-tracker.json');
    this.alertsPath = join(dataDir, 'alert-preferences.json');
  }

  async loadTracker() {
    return await readJson(this.trackerPath, { schemaVersion: TRACKER_SCHEMA, updatedAt: null, items: [] });
  }

  /**
   * The stored alert settings, normalized on the way out.
   *
   * The file is hand-editable and outlives schema changes, so whatever is on
   * disk is treated as a suggestion: a field that is missing, null, NaN or
   * "23h00" comes back as its default while the fields the user did set are
   * kept. Returning the raw object instead would hand a `minRoiPercent` of
   * undefined straight to the engine, where it compares false against every
   * number and the page raises no alerts at all — silently, with no error.
   */
  async loadAlerts() {
    const stored = await readJson(this.alertsPath, null);
    return {
      schemaVersion: ALERT_SCHEMA,
      preferences: normalizeAlertPreferences(stored?.preferences),
    };
  }

  async saveTracker(t) {
    const out = {
      schemaVersion: TRACKER_SCHEMA,
      updatedAt: new Date().toISOString(),
      items: Array.isArray(t.items) ? t.items : [],
    };
    await writeJsonAtomic(this.trackerPath, out);
    return out;
  }

  /**
   * Add a bet. The second argument is internal — the HTTP route never passes
   * it, so a client still cannot choose its own placed-at date.
   */
  async addBet(item, { createdAt } = {}) {
    const t = await this.loadTracker();
    const entry = normalizeBet(item, {
      id: `bet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: createdAt || new Date().toISOString(),
    });
    t.items.push(entry);
    t.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.trackerPath, t);
    return entry;
  }

  async removeBet(id) {
    const t = await this.loadTracker();
    t.items = t.items.filter((b) => b.id !== id);
    t.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.trackerPath, t);
    return t;
  }

  async updateBet(id, patch) {
    const t = await this.loadTracker();
    const idx = t.items.findIndex((bet) => bet.id === id);
    if (idx === -1) return null;
    t.items[idx] = normalizeBet({ ...t.items[idx], ...allowedBetPatch(patch) }, {
      id: t.items[idx].id,
      createdAt: t.items[idx].createdAt,
      updatedAt: new Date().toISOString(),
    });
    t.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.trackerPath, t);
    return t.items[idx];
  }

  async exportCsv() {
    const t = await this.loadTracker();
    const headers = ['id', 'createdAt', 'eventKey', 'marketKey', 'selection', 'sourceId', 'odds', 'stake', 'status', 'notes'];
    const rows = [headers.join(',')];
    for (const b of t.items) {
      rows.push(csvRow(headers.map((h) => b[h])));
    }
    return rows.join('\n');
  }

  /**
   * Import rows from a pasted CSV, and say what happened to every one of them.
   *
   * Two things were wrong here and they are the same thing seen from two ends.
   *
   * The gate was a second opinion of the service's own validation, and it
   * disagreed: it required an `eventKey`, which nothing in this app ever
   * produces. Every bet typed into the add-bet form on the analytics page has
   * an empty one, so exporting your own file and importing it back dropped
   * every bet you had entered by hand — silently, since the count was
   * discarded. normalizeBet is the authority on what a usable bet is; a row it
   * rejects is skipped and counted, a row it accepts is imported.
   *
   * And `skipped` did not exist at all, so a file where most rows were
   * unusable closed the dialog and re-rendered a shorter table, which is
   * indistinguishable from a clean import.
   */
  async importCsv(csv) {
    const lines = String(csv || '').split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return { imported: 0, skipped: 0 };
    const headers = parseCsvLine(lines[0]);
    let imported = 0;
    let skipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
      // No numeric coercion here. It used to sit next to this loop, converting
      // the odds and stake cells before normalizeBet saw them — and
      // normalizeBet runs `Number()` on both itself and rejects anything not
      // finite, so the conversion changed nothing that the gate did not
      // already decide. Two lines that looked like a contract and were a copy
      // of the one below.
      //
      // `provenance` is re-labelled on purpose and is not in the export: the
      // file does not record where this app learned a bet from, only the bet.
      // The id stays fresh too — see addBet — but the placed-at date is data
      // the user can see and correct, so a re-imported bet keeps the date it
      // was placed rather than the date the import ran.
      try {
        await this.addBet({ ...row, provenance: 'import' }, { createdAt: usableTimestamp(row.createdAt) });
        imported++;
      } catch (err) {
        // Only bad input is a skip. Anything else — a disk that will not take
        // the write — is the operator's problem to hear about, not a row to
        // quietly drop and report as a clean import.
        if (err?.code !== 'EBADINPUT') throw err;
        skipped++;
      }
    }
    return { imported, skipped };
  }

  /**
   * Persist alert settings, normalized on the way in.
   *
   * Same rule as the read: a POST that omits a field resets it to the default
   * rather than inheriting whatever was on disk. The previous spread-merge
   * kept stale nested keys too — posting `channels: { desktop: false }` left
   * `sound` at whatever it was, so a client could never turn a channel back
   * off after turning it on.
   */
  async saveAlerts(prefs) {
    const merged = {
      schemaVersion: ALERT_SCHEMA,
      preferences: normalizeAlertPreferences(prefs),
    };
    await writeJsonAtomic(this.alertsPath, merged);
    return merged;
  }
}

function normalizeBet(item, { id, createdAt, updatedAt = null }) {
  const selection = cleanText(item?.selection, 160);
  const odds = Number(item?.odds);
  const stake = Number(item?.stake);
  if (!selection) {
    const err = new Error('selection is required');
    err.code = 'EBADINPUT';
    throw err;
  }
  if (!Number.isFinite(odds) || odds <= 1) {
    const err = new Error('odds must be greater than 1');
    err.code = 'EBADINPUT';
    throw err;
  }
  if (!Number.isFinite(stake) || stake <= 0) {
    const err = new Error('stake must be greater than 0');
    err.code = 'EBADINPUT';
    throw err;
  }
  const status = ['pending', 'won', 'lost', 'void'].includes(item?.status) ? item.status : 'pending';
  return {
    id,
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
    eventKey: cleanText(item?.eventKey, 300),
    marketKey: cleanText(item?.marketKey, 120),
    selection,
    sourceId: cleanText(item?.sourceId, 80) || 'manual',
    odds: Number(odds.toFixed(3)),
    stake: Number(stake.toFixed(2)),
    status,
    notes: cleanText(item?.notes, 1000),
    provenance: item?.provenance === 'scan' ? 'scan' : item?.provenance === 'import' ? 'import' : 'manual',
  };
}

function allowedBetPatch(patch) {
  const source = patch && typeof patch === 'object' ? patch : {};
  return Object.fromEntries(Object.entries(source).filter(([key]) => [
    'eventKey', 'marketKey', 'selection', 'sourceId', 'odds', 'stake', 'status', 'notes', 'provenance',
  ].includes(key)));
}

function cleanText(value, maxLength) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

/**
 * The placed-at date a CSV row carries, when it is a date at all.
 *
 * The export writes `createdAt`, so a file the user edits and re-imports is
 * meant to bring the original date back. Before this, every re-imported bet
 * claimed it had been placed at the moment of the import — a ledger rewriting
 * its own history, with the original date sitting in the file the user was
 * looking at. Anything unparseable comes back null and the caller stamps now.
 */
function usableTimestamp(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}
