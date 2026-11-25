import { log } from './common.mjs';

// Cross-group state (TS-13 combines observations from the TS-03 and TS-09 pages).
export const shared = { ts13a: null, ts13b: null };

export function recorder() {
  const cps = [];
  const check = (step, passed, observation) => {
    cps.push({ step, passed: !!passed, observation: String(observation).slice(0, 1500) });
    log(passed ? 'PASS' : 'FAIL', step, '|', String(observation).slice(0, 300));
    return !!passed;
  };
  return { cps, check, passed: () => cps.length > 0 && cps.every((x) => x.passed) };
}
