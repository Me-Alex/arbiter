/**
 * Notification tones are synthesised rather than shipped as assets: two short
 * oscillator envelopes, no network, no licence, no decoded audio to load before
 * the first alert can fire.
 */

let context: AudioContext | undefined;

/**
 * Whether the page has seen a real user gesture.
 *
 * Browsers refuse to start an AudioContext before one, and the refusal is a
 * console warning on every load: the first scan can land while the page is
 * still unprimed, and the alert path would then construct a context the
 * browser immediately suspends. Rather than ask for a context that cannot
 * sound, the no-gesture case stays silent until the reader clicks or types.
 */
let unlocked =
  typeof navigator !== 'undefined'
  && (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } })
    .userActivation?.hasBeenActive === true;

function unlock() {
  unlocked = true;
  // A context created under an earlier attempt may still be suspended; the
  // gesture is the moment the browser will let it run.
  if (context?.state === 'suspended') void context.resume();
}

if (typeof window !== 'undefined' && !unlocked) {
  const options = { once: true, passive: true } as const;
  window.addEventListener('pointerdown', unlock, options);
  window.addEventListener('keydown', unlock, options);
}

function audioContext(): AudioContext | undefined {
  if (typeof window === 'undefined' || !unlocked) return undefined;
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return undefined;
    context = new Ctor();
  }
  // Browsers start the context suspended until a gesture; a click that never
  // produces sound is worse than no sound, so it is resumed opportunistically.
  if (context.state === 'suspended') void context.resume();
  return context;
}

function tone(frequency: number, durationMs: number, gainPeak: number, delayMs = 0) {
  const ctx = audioContext();
  if (!ctx) return;
  const start = ctx.currentTime + delayMs / 1000;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationMs / 1000);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + durationMs / 1000 + 0.02);
}

/** Loud enough to pull attention to a wide surebet. */
export function playHighValueChime() { tone(1180, 220, 0.16); tone(1560, 260, 0.09, 70); }

/** Quiet tick for an ordinary new signal. */
export function playStandardClick() { tone(720, 90, 0.05); }