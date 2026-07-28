import * as d3 from 'd3';

export type ClassificationMethod = 'quantile' | 'equal' | 'natural-breaks' | 'log';

export const CLASSIFICATION_METHODS: { id: ClassificationMethod; name: string; blurb: string }[] = [
  { id: 'quantile', name: 'Quantile', blurb: 'Equal count per bucket — best default for skewed data' },
  { id: 'equal', name: 'Equal interval', blurb: 'Equal-width value ranges' },
  { id: 'natural-breaks', name: 'Natural breaks', blurb: 'Jenks — clusters by natural gaps in the data' },
  { id: 'log', name: 'Logarithmic', blurb: 'Equal ratio steps — good for wide value spans' },
];

/**
 * Fisher/Jenks natural breaks, computed on a reduced histogram (not the raw
 * array) so it stays fast regardless of dataset size — a classic O(n^2)
 * Jenks on 100k raw values would be far too slow; running the same DP on a
 * ~256-bin weighted histogram gives a close approximation in a few
 * milliseconds no matter how large n is.
 */
function jenksBreaks(values: number[], numClasses: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n <= numClasses) return sorted.slice(1);

  const HIST_BINS = Math.min(256, n);
  const min = sorted[0];
  const max = sorted[n - 1];
  if (min === max) return new Array(numClasses - 1).fill(min);

  const binWidth = (max - min) / HIST_BINS;
  const weights = new Array(HIST_BINS).fill(0);
  const binValue = (i: number) => min + (i + 0.5) * binWidth;
  for (const v of sorted) {
    let bin = Math.floor((v - min) / binWidth);
    if (bin >= HIST_BINS) bin = HIST_BINS - 1;
    weights[bin]++;
  }

  // Standard Jenks DP over the (small, fixed-size) histogram.
  const lowerClassLimits: number[][] = Array.from({ length: HIST_BINS + 1 }, () => new Array(numClasses + 1).fill(0));
  const varCombinations: number[][] = Array.from({ length: HIST_BINS + 1 }, () => new Array(numClasses + 1).fill(Infinity));
  for (let j = 1; j <= numClasses; j++) {
    lowerClassLimits[1][j] = 1;
    varCombinations[1][j] = 0;
    for (let i = 2; i <= HIST_BINS; i++) varCombinations[i][j] = Infinity;
  }

  for (let l = 2; l <= HIST_BINS; l++) {
    let sumW = 0, sumWV = 0, sumWV2 = 0;
    for (let m = 1; m <= l; m++) {
      const i4 = l - m + 1;
      const w = weights[i4 - 1];
      const val = binValue(i4 - 1);
      sumW += w;
      sumWV += w * val;
      sumWV2 += w * val * val;
      const variance = sumWV2 - (sumWV * sumWV) / sumW;
      if (i4 !== 1) {
        for (let j = 2; j <= numClasses; j++) {
          if (varCombinations[l][j] >= variance + varCombinations[i4 - 1][j - 1]) {
            lowerClassLimits[l][j] = i4;
            varCombinations[l][j] = variance + varCombinations[i4 - 1][j - 1];
          }
        }
      }
    }
    lowerClassLimits[l][1] = 1;
    varCombinations[l][1] = sumWV2 - (sumWV * sumWV) / sumW;
  }

  const breaksIdx: number[] = new Array(numClasses + 1);
  breaksIdx[numClasses] = HIST_BINS;
  breaksIdx[0] = 1;
  let k = HIST_BINS;
  for (let j = numClasses; j >= 2; j--) {
    const idx = lowerClassLimits[k][j] - 1;
    breaksIdx[j - 1] = idx;
    k = idx;
  }

  return breaksIdx.slice(1, numClasses).map((idx) => binValue(Math.max(0, idx - 1)));
}

function equalBreaks(min: number, max: number, numClasses: number): number[] {
  const breaks: number[] = [];
  for (let i = 1; i < numClasses; i++) breaks.push(min + ((max - min) * i) / numClasses);
  return breaks;
}

function quantileBreaks(values: number[], numClasses: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const breaks: number[] = [];
  for (let i = 1; i < numClasses; i++) breaks.push(d3.quantileSorted(sorted, i / numClasses) ?? sorted[0]);
  return breaks;
}

function logBreaks(min: number, max: number, numClasses: number): number[] {
  const safeMin = Math.max(min, 1e-6);
  const logMin = Math.log(safeMin);
  const logMax = Math.log(Math.max(max, safeMin * 1.0001));
  const breaks: number[] = [];
  for (let i = 1; i < numClasses; i++) breaks.push(Math.exp(logMin + ((logMax - logMin) * i) / numClasses));
  return breaks;
}

/**
 * Builds a value -> color function using the given classification method.
 * Always returns a plain callable (v: number) => string so the rest of the
 * app (including the GPU color-buffer build) doesn't need to know which
 * method is active.
 */
export function buildClassifiedScale(values: number[], ramp: string[], method: ClassificationMethod): (v: number) => string {
  if (values.length === 0) return () => ramp[0];
  const [min, max] = d3.extent(values) as [number, number];
  if (min === max) return () => ramp[ramp.length - 1];

  const numClasses = ramp.length;
  let breaks: number[];
  switch (method) {
    case 'equal':
      breaks = equalBreaks(min, max, numClasses);
      break;
    case 'natural-breaks':
      breaks = jenksBreaks(values, numClasses);
      break;
    case 'log':
      breaks = logBreaks(min, max, numClasses);
      break;
    case 'quantile':
    default:
      breaks = quantileBreaks(values, numClasses);
      break;
  }
  const scale = d3.scaleThreshold<number, string>().domain(breaks).range(ramp);
  return (v: number) => scale(v);
}
