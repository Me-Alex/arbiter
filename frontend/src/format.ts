import { useEffect, useState } from 'react';
import type { Sport } from './domain';
import { currentLang, t, tf } from './i18n';

declare global {
  interface Window {
    EventDetailModal?: {
      isEventUrl?: (url?: string | null) => boolean;
    };
  }
}

let gateLoadStarted = false;
let gateLoaded = false;
const gateListeners = new Set<() => void>();

function ensureEventUrlGateLoaded() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.EventDetailModal?.isEventUrl) {
    gateLoaded = true;
    return;
  }
  if (gateLoadStarted) return;
  gateLoadStarted = true;
  const script = document.createElement('script');
  script.src = '/js/pages/event-detail-modal.js';
  script.async = true;
  script.onload = () => {
    gateLoaded = true;
    gateListeners.forEach((fn) => fn());
  };
  document.head.appendChild(script);
}

/**
 * Uses the canonical `window.EventDetailModal.isEventUrl` gate from
 * `public/js/pages/event-detail-modal.js` so raw JSON API feed URLs are never
 * offered as bookmaker web links, without introducing a second URL denylist.
 */
export function isNavigableEventUrl(url?: string | null): boolean {
  if (!url || typeof window === 'undefined') return false;
  return Boolean(window.EventDetailModal?.isEventUrl?.(url));
}

export function useNavigableUrlGate(): (url?: string | null) => boolean {
  const [, setReady] = useState(() => gateLoaded);
  useEffect(() => {
    ensureEventUrlGateLoaded();
    if (gateLoaded) return undefined;
    const onReady = () => setReady(true);
    gateListeners.add(onReady);
    return () => {
      gateListeners.delete(onReady);
    };
  }, []);
  return isNavigableEventUrl;
}

export function uiLocale(): string {
  return currentLang() === 'ro' ? 'ro-RO' : 'en-GB';
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(uiLocale(), { hour: '2-digit', minute: '2-digit' }).format(d);
}

export function formatClock(value: number): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(uiLocale(), { hour: '2-digit', minute: '2-digit' }).format(d);
}

export function formatMoney(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toLocaleString(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} RON`;
}

export function formatNum(value: number, digits = 0): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toLocaleString(uiLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPercent(value: number, digits = 2): string {
  return `${formatNum(value, digits)}%`;
}

export function formatKickoff(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const time = new Intl.DateTimeFormat(uiLocale(), { hour: '2-digit', minute: '2-digit' }).format(date);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? tf('appTodayTime', { time })
    : `${new Intl.DateTimeFormat(uiLocale(), { day: '2-digit', month: 'short' }).format(date)}, ${time}`;
}

const SPORT_LABEL_KEYS: Record<Sport, string> = {
  football: 'appSportFootball',
  tennis: 'appSportTennis',
  basketball: 'appSportBasketball',
  hockey: 'appSportHockey',
  handball: 'appSportHandball',
  volleyball: 'appSportVolleyball',
  'american-football': 'appSportAmericanFootball',
  boxing: 'appSportBoxing',
  mma: 'appSportMma',
  baseball: 'appSportBaseball',
  'table-tennis': 'appSportTableTennis',
  esports: 'appSportEsports',
  darts: 'appSportDarts',
  rugby: 'appSportRugby',
  snooker: 'appSportSnooker',
  futsal: 'appSportFutsal',
  cricket: 'appSportCricket',
  'water-polo': 'appSportWaterPolo',
  badminton: 'appSportBadminton',
  other: 'appSportOther',
};

export function sportLabel(sport: Sport): string {
  return t(SPORT_LABEL_KEYS[sport] ?? 'appSportOther');
}

export async function copyTextWithFeedback(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // ignore clipboard errors
  }
  return false;
}
