import type { StakeCalculation } from './domain';
import type { LockedLegCap, RoundingMode, StakeOptions } from './stakes';

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, (value: StakeCalculation) => void>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; result: StakeCalculation }>) => {
      const resolve = pending.get(event.data.id);
      if (resolve) {
        pending.delete(event.data.id);
        resolve(event.data.result);
      }
    };
  }
  return worker;
}

export function calculateStakesAsync(
  odds: number[],
  bankroll: number,
  mode: RoundingMode,
  lockedLeg?: LockedLegCap | null,
  options?: StakeOptions,
): Promise<StakeCalculation> {
  return new Promise((resolve) => {
    const id = ++sequence;
    pending.set(id, resolve);
    getWorker().postMessage({ id, odds, bankroll, mode, lockedLeg, options });
  });
}
