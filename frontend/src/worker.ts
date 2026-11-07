import {
  calculateStakes,
  type LockedLegCap,
  type RoundingMode,
  type StakeOptions,
} from './stakes';

export { calculateStakes, type LockedLegCap, type RoundingMode, type StakeOptions };

self.onmessage = (
  event: MessageEvent<{
    id?: number;
    odds: number[];
    bankroll: number;
    mode: RoundingMode;
    lockedLeg?: LockedLegCap | null;
    options?: StakeOptions;
  }>,
) => {
  self.postMessage({
    id: event.data.id,
    result: calculateStakes(
      event.data.odds,
      event.data.bankroll,
      event.data.mode,
      event.data.lockedLeg,
      event.data.options,
    ),
  });
};
