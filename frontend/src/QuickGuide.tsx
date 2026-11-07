import { BookCheck, Calculator, CheckCircle2, HelpCircle, Layers, Radar, ShieldCheck, TrendingUp, X } from 'lucide-react';
import { t } from './i18n';
import type { WorkspaceView } from './workspace';

export function QuickGuide({
  open,
  onClose,
  onNavigate,
  onFilterSafeSurebets,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: WorkspaceView) => void;
  onFilterSafeSurebets: () => void;
}) {
  if (!open) return null;

  return (
    <section className="panel guide-card" aria-label={t('appGuideTitle')}>
      <div className="guide-head">
        <div className="guide-title-wrap">
          <span className="guide-icon"><HelpCircle size={16} /></span>
          <div>
            <strong>{t('appGuideTitle')}</strong>
            <span className="subtle">{t('appGuideSubtitle')}</span>
          </div>
        </div>
        <button className="icon-button" onClick={onClose} title={t('appGuideDismiss')} aria-label={t('appGuideDismiss')}>
          <X size={16} />
        </button>
      </div>

      <div className="guide-steps">
        <div className="guide-step">
          <div className="guide-step-num"><Radar size={14} /> 1</div>
          <strong>{t('appGuideStep1Title')}</strong>
          <p>{t('appGuideStep1Body')}</p>
          <button className="chip sm" onClick={() => onNavigate('Scanner')}>{t('appGuideOpenScanner')}</button>
        </div>

        <div className="guide-step">
          <div className="guide-step-num"><ShieldCheck size={14} /> 2</div>
          <strong>{t('appGuideStep2Title')}</strong>
          <p>{t('appGuideStep2Body')}</p>
          <button className="chip sm active" onClick={onFilterSafeSurebets}>{t('appPresetSafeSurebets')}</button>
        </div>

        <div className="guide-step">
          <div className="guide-step-num"><Calculator size={14} /> 3</div>
          <strong>{t('appGuideStep3Title')}</strong>
          <p>{t('appGuideStep3Body')}</p>
        </div>

        <div className="guide-step">
          <div className="guide-step-num"><BookCheck size={14} /> 4</div>
          <strong>{t('appGuideStep4Title')}</strong>
          <p>{t('appGuideStep4Body')}</p>
          <button className="chip sm" onClick={() => onNavigate('Analytics')}>{t('appGuideOpenTracker')}</button>
        </div>
      </div>

      <div className="guide-glossary">
        <div className="glossary-pill safe">
          <CheckCircle2 size={13} />
          <div>
            <strong>{t('surebet')} · {t('appRulesSafe')}</strong>
            <span>{t('appGlossarySurebet')}</span>
          </div>
        </div>
        <div className="glossary-pill middle">
          <Layers size={13} />
          <div>
            <strong>{t('middleChip')}</strong>
            <span>{t('appGlossaryMiddle')}</span>
          </div>
        </div>
        <div className="glossary-pill ev">
          <TrendingUp size={13} />
          <div>
            <strong>+EV</strong>
            <span>{t('appGlossaryEv')}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
