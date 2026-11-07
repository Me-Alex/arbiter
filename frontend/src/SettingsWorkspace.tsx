import { useEffect, useState } from 'react';
import { Bell, ExternalLink, HelpCircle, Languages, Moon, RotateCcw, Save, Sun } from 'lucide-react';
import type { AlertPreferences } from './domain';
import { fetchAlerts, saveAlerts } from './api';
import { t, useLanguage } from './i18n';
import type { OddsFormat } from './odds-format';
import { CURRENCY_CODES, type CurrencyCode, type RoundingMode } from './stakes';
import { useAlertStore, useFeedStore, usePreferencesStore } from './stores';

const ODDS_FORMAT_OPTIONS: [OddsFormat, string][] = [
  ['decimal', 'appOddsDecimal'],
  ['american', 'appOddsAmerican'],
  ['fractional', 'appOddsFractional'],
  ['hongkong', 'appOddsHongKong'],
  ['malay', 'appOddsMalay'],
];

export function SettingsWorkspace() {
  const { lang, setLang } = useLanguage();
  const theme = usePreferencesStore((s) => s.theme);
  const toggleTheme = usePreferencesStore((s) => s.toggleTheme);
  const defaultBankroll = usePreferencesStore((s) => s.defaultBankroll);
  const setDefaultBankroll = usePreferencesStore((s) => s.setDefaultBankroll);
  const defaultRounding = usePreferencesStore((s) => s.defaultRounding);
  const setDefaultRounding = usePreferencesStore((s) => s.setDefaultRounding);
  const oddsFormat = usePreferencesStore((s) => s.oddsFormat);
  const setOddsFormat = usePreferencesStore((s) => s.setOddsFormat);
  const baseCurrency = usePreferencesStore((s) => s.baseCurrency);
  const setBaseCurrency = usePreferencesStore((s) => s.setBaseCurrency);
  const fxRates = usePreferencesStore((s) => s.fxRates);
  const setFxRate = usePreferencesStore((s) => s.setFxRate);
  const resetFxRates = usePreferencesStore((s) => s.resetFxRates);
  const guideOpen = usePreferencesStore((s) => s.guideOpen);
  const setGuideOpen = usePreferencesStore((s) => s.setGuideOpen);

  const alertsMuted = useAlertStore((s) => s.muted);
  const toggleAlerts = useAlertStore((s) => s.toggleMuted);
  const notify = useFeedStore((s) => s.notify);

  const [bankrollDraft, setBankrollDraft] = useState(String(defaultBankroll));
  const [alertPrefs, setAlertPrefs] = useState<AlertPreferences | null>(null);
  const [savingAlerts, setSavingAlerts] = useState(false);

  useEffect(() => {
    let active = true;
    fetchAlerts()
      .then((res) => {
        if (active && res.preferences) setAlertPrefs(res.preferences);
      })
      .catch(() => { /* ignore */ });
    return () => {
      active = false;
    };
  }, []);

  const handleSaveBankroll = () => {
    const val = Math.max(10, Number(bankrollDraft) || 1000);
    setDefaultBankroll(val);
    setBankrollDraft(String(val));
    notify(t('appToastPrefsSaved'), 'success');
  };

  const handleSaveAlerts = async () => {
    if (!alertPrefs || savingAlerts) return;
    setSavingAlerts(true);
    try {
      const updated = await saveAlerts(alertPrefs);
      setAlertPrefs(updated.preferences);
      notify(t('appToastPrefsSaved'), 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('appToastSaveFailed'), 'error');
    } finally {
      setSavingAlerts(false);
    }
  };

  return (
    <div className="workspace-stack">
      <section className="panel workspace-table">
        <div className="section-head" style={{ marginBottom: 4 }}>
          <div className="eyebrow">{t('appWorkspacePrefs')}</div>
          <span className="market-badge">{t('appAutoSavedBadge')}</span>
        </div>

        <div className="source-row setting-row">
          <strong>{t('bankroll')} ({baseCurrency})</strong>
          <span className="subtle">{t('appDefaultBankrollNote')}</span>
          <div className="inline-actions">
            <input
              type="number"
              min={10}
              step={50}
              className="select num"
              style={{ width: 110 }}
              value={bankrollDraft}
              onChange={(e) => setBankrollDraft(e.target.value)}
            />
            <button className="chip sm active" onClick={handleSaveBankroll}>
              <Save size={13} /> {t('appSaveBtn')}
            </button>
          </div>
        </div>

        <div className="source-row setting-row">
          <strong>{t('appOddsFormatLabel')}</strong>
          <span className="subtle">{t('appOddsFormatNote')}</span>
          <div className="inline-actions" style={{ flexWrap: 'wrap' }}>
            {ODDS_FORMAT_OPTIONS.map(([fmt, key]) => (
              <button
                key={fmt}
                type="button"
                className={`chip sm ${oddsFormat === fmt ? 'active' : ''}`}
                onClick={() => {
                  setOddsFormat(fmt);
                  notify(t('appToastPrefsSaved'), 'success');
                }}
              >
                {t(key)}
              </button>
            ))}
          </div>
        </div>

        <div className="source-row setting-row">
          <strong>{t('appBaseCurrencyLabel')}</strong>
          <span className="subtle">{t('appBaseCurrencyNote')}</span>
          <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
            <div className="inline-actions" style={{ flexWrap: 'wrap' }}>
              {CURRENCY_CODES.map((curr) => (
                <button
                  key={curr}
                  type="button"
                  className={`chip sm ${baseCurrency === curr ? 'active' : ''}`}
                  onClick={() => {
                    setBaseCurrency(curr);
                    notify(t('appToastPrefsSaved'), 'success');
                  }}
                >
                  {curr}
                </button>
              ))}
            </div>
            <div className="inline-actions" style={{ flexWrap: 'wrap' }}>
              {(['EUR', 'PLN', 'USD', 'GBP'] as CurrencyCode[]).map((curr) => (
                <label key={`fx-${curr}`} className="inline-odd-edit">
                  <span>1 {curr} =</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.05"
                    className="odd-mini-input num"
                    value={fxRates[curr]}
                    onChange={(e) => setFxRate(curr, Number(e.target.value) || 0)}
                  />
                  <span>RON</span>
                </label>
              ))}
              <button
                type="button"
                className="chip sm"
                onClick={() => {
                  resetFxRates();
                  notify(t('appToastPrefsSaved'), 'success');
                }}
              >
                <RotateCcw size={12} /> {t('appReset')}
              </button>
            </div>
          </div>
        </div>

        <div className="source-row setting-row">
          <strong>{t('appSmartRounding')}</strong>
          <span className="subtle">{t('appSmartRoundingNote')}</span>
          <div className="inline-actions">
            {(['raw', 'five', 'ten', 'smart'] as RoundingMode[]).map((item) => (
              <button
                key={item}
                className={`chip sm ${defaultRounding === item ? 'active' : ''}`}
                onClick={() => {
                  setDefaultRounding(item);
                  notify(t('appToastPrefsSaved'), 'success');
                }}
              >
                {item === 'raw'
                  ? t('appRoundingRaw')
                  : item === 'five'
                    ? t('appRoundingFive')
                    : item === 'ten'
                      ? t('appRoundingTen')
                      : t('appRoundingSmart')}
              </button>
            ))}
          </div>
        </div>

        <div className="source-row setting-row">
          <strong>{t('appThemeLabel')}</strong>
          <span className="subtle">{t('appThemeNote')}</span>
          <button className="chip sm active" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
            {theme === 'dark' ? t('appThemeDark') : t('appThemeLight')}
          </button>
        </div>

        <div className="source-row setting-row">
          <strong>{t('appLanguageLabel')}</strong>
          <span className="subtle">{t('appLanguageNote')}</span>
          <div className="inline-actions">
            <button
              className={`chip sm ${lang === 'ro' ? 'active' : ''}`}
              onClick={() => setLang('ro')}
            >
              <Languages size={13} /> Română
            </button>
            <button
              className={`chip sm ${lang === 'en' ? 'active' : ''}`}
              onClick={() => setLang('en')}
            >
              <Languages size={13} /> English
            </button>
          </div>
        </div>

        <div className="source-row setting-row">
          <strong>{t('appAudioAlerts')}</strong>
          <span className="subtle">{t('appAudioAlertsNote')}</span>
          <button
            className={`chip sm ${!alertsMuted ? 'active' : ''}`}
            onClick={toggleAlerts}
          >
            <Bell size={13} /> {alertsMuted ? t('appMuted') : t('appOn')}
          </button>
        </div>

        <div className="source-row setting-row">
          <strong>{t('appGuideTitle')}</strong>
          <span className="subtle">{t('appGuideSubtitle')}</span>
          <button
            className={`chip sm ${guideOpen ? 'active' : ''}`}
            onClick={() => {
              setGuideOpen(!guideOpen);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            <HelpCircle size={13} /> {guideOpen ? t('appEnabled') : t('appShowGuideBtn')}
          </button>
        </div>

        <div className="source-row setting-row">
          <strong>{t('appPlansSubs')}</strong>
          <span className="subtle">{t('appPlansNote')}</span>
          <span className="safe-tag">{t('appNotConnected')}</span>
        </div>
      </section>

      {alertPrefs && (
        <section className="panel workspace-table">
          <div className="section-head">
            <div>
              <div className="eyebrow">{t('appAlertThresholdsTitle')}</div>
              <h3>{t('appAlertThresholdsSubtitle')}</h3>
            </div>
            <button
              className="chip active"
              disabled={savingAlerts}
              onClick={() => void handleSaveAlerts()}
            >
              <Save size={14} /> {t('appSaveBtn')}
            </button>
          </div>

          <div className="scanner-controls-grid" style={{ marginTop: 10 }}>
            <div className="control-field">
              <label htmlFor="alert-min-margin">{t('alertMinMargin')}</label>
              <input
                id="alert-min-margin"
                type="number"
                step={0.5}
                min={0}
                placeholder="1"
                className="select num"
                value={alertPrefs.minMarginPercent}
                onChange={(e) =>
                  setAlertPrefs({ ...alertPrefs, minMarginPercent: Number(e.target.value) || 0 })
                }
              />
            </div>

            <div className="control-field">
              <label htmlFor="alert-min-mid">{t('alertMinMiddleRoi')}</label>
              <input
                id="alert-min-mid"
                type="number"
                step={1}
                min={0}
                placeholder="20"
                className="select num"
                value={alertPrefs.minMiddleRoiPercent}
                onChange={(e) =>
                  setAlertPrefs({ ...alertPrefs, minMiddleRoiPercent: Number(e.target.value) || 0 })
                }
              />
            </div>

            <div className="control-field">
              <label htmlFor="alert-min-ev">{t('minEv')}</label>
              <input
                id="alert-min-ev"
                type="number"
                step={0.5}
                min={0}
                placeholder="2"
                className="select num"
                value={alertPrefs.minEvPercent ?? ''}
                onChange={(e) =>
                  setAlertPrefs({ ...alertPrefs, minEvPercent: Number(e.target.value) || 0 })
                }
              />
            </div>

            <div className="control-field">
              <label>{t('appQuietHoursLabel')}</label>
              <div className="inline-actions">
                <input
                  type="time"
                  className="select num"
                  value={alertPrefs.quietHoursStart}
                  onChange={(e) => setAlertPrefs({ ...alertPrefs, quietHoursStart: e.target.value })}
                />
                <span>–</span>
                <input
                  type="time"
                  className="select num"
                  value={alertPrefs.quietHoursEnd}
                  onChange={(e) => setAlertPrefs({ ...alertPrefs, quietHoursEnd: e.target.value })}
                />
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="panel workspace-card">
        <div className="eyebrow">{t('appClassicConsoleLabel')}</div>
        <span className="subtle">{t('appClassicConsoleDesc')}</span>
        <div className="inline-actions" style={{ marginTop: 6 }}>
          <a className="chip sm" href="/admin/arbitrage.html">
            <ExternalLink size={13} /> {t('appClassicArbitrageLink')}
          </a>
          <a className="chip sm" href="/admin/scrape.html">
            <ExternalLink size={13} /> {t('scrapeControl')}
          </a>
        </div>
      </section>
    </div>
  );
}
