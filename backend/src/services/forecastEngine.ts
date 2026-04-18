// ---------------------------------------------------------------------------
// Forecast Engine — pure JavaScript statistical forecasting
// Supports linear regression and moving average methods.
// No external dependencies required.
// ---------------------------------------------------------------------------

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export interface ForecastPoint {
  date: string;
  value: number;
  lower: number;
  upper: number;
}

export interface ForecastResult {
  historical: TimeSeriesPoint[];
  forecast: ForecastPoint[];
  method: 'linear_regression' | 'moving_average';
  confidence: number;
  r2: number;
}

// ---------------------------------------------------------------------------
// Date arithmetic — advances a date string by N periods
// ---------------------------------------------------------------------------

function parseDate(dateStr: string): Date {
  // Handle various formats: YYYY-MM, YYYY-MM-DD, YYYY-Qn, YYYY-Wnn, YYYY
  const s = dateStr.trim();

  // YYYY-Qn  (e.g. "2026-Q1")
  const qMatch = s.match(/^(\d{4})-Q([1-4])$/i);
  if (qMatch) {
    const year = parseInt(qMatch[1], 10);
    const quarter = parseInt(qMatch[2], 10);
    return new Date(year, (quarter - 1) * 3, 1);
  }

  // YYYY-Wnn (e.g. "2026-W03")
  const wMatch = s.match(/^(\d{4})-W(\d{1,2})$/i);
  if (wMatch) {
    const year = parseInt(wMatch[1], 10);
    const week = parseInt(wMatch[2], 10);
    const jan1 = new Date(year, 0, 1);
    const dayOffset = (week - 1) * 7;
    return new Date(jan1.getTime() + dayOffset * 86400000);
  }

  // YYYY only
  if (/^\d{4}$/.test(s)) {
    return new Date(parseInt(s, 10), 0, 1);
  }

  // YYYY-MM
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number);
    return new Date(y, m - 1, 1);
  }

  // Default: let Date parse it (handles YYYY-MM-DD etc.)
  return new Date(s);
}

function formatDateForUnit(d: Date, unit: string): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  switch (unit) {
    case 'year':
      return `${y}`;
    case 'quarter': {
      const q = Math.floor(d.getMonth() / 3) + 1;
      return `${y}-Q${q}`;
    }
    case 'month':
      return `${y}-${m}`;
    case 'week': {
      // ISO week approximation
      const jan1 = new Date(y, 0, 1);
      const wk = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
      return `${y}-W${String(wk).padStart(2, '0')}`;
    }
    case 'day':
    default:
      return `${y}-${m}-${dd}`;
  }
}

function advanceDate(d: Date, unit: string, periods: number): Date {
  const result = new Date(d);
  switch (unit) {
    case 'day':
      result.setDate(result.getDate() + periods);
      break;
    case 'week':
      result.setDate(result.getDate() + periods * 7);
      break;
    case 'month':
      result.setMonth(result.getMonth() + periods);
      break;
    case 'quarter':
      result.setMonth(result.getMonth() + periods * 3);
      break;
    case 'year':
      result.setFullYear(result.getFullYear() + periods);
      break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Linear regression — ordinary least squares
// ---------------------------------------------------------------------------

interface RegressionResult {
  slope: number;
  intercept: number;
  r2: number;
  standardError: number;
}

function linearRegression(values: number[]): RegressionResult {
  const n = values.length;
  if (n < 2) {
    return { slope: 0, intercept: values[0] ?? 0, r2: 0, standardError: 0 };
  }

  // x = 0, 1, 2, ... (index as time proxy)
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const meanX = sumX / n;
  const meanY = sumY / n;
  const denom = sumX2 - n * meanX * meanX;

  const slope = denom !== 0 ? (sumXY - n * meanX * meanY) / denom : 0;
  const intercept = meanY - slope * meanX;

  // R-squared
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    ssRes += (values[i] - predicted) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Standard error of the regression
  const se = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;

  return { slope, intercept, r2, standardError: se };
}

// ---------------------------------------------------------------------------
// Moving average forecast
// ---------------------------------------------------------------------------

function movingAverageForecast(values: number[], windowSize: number): { avg: number; stdDev: number } {
  const window = values.slice(-windowSize);
  const avg = window.reduce((s, v) => s + v, 0) / window.length;
  const variance = window.reduce((s, v) => s + (v - avg) ** 2, 0) / window.length;
  return { avg, stdDev: Math.sqrt(variance) };
}

// ---------------------------------------------------------------------------
// Main forecast function
// ---------------------------------------------------------------------------

export function computeForecast(
  data: TimeSeriesPoint[],
  periods: number,
  periodUnit: 'day' | 'week' | 'month' | 'quarter' | 'year',
): ForecastResult {
  if (data.length < 2) {
    return {
      historical: data,
      forecast: [],
      method: 'moving_average',
      confidence: 0,
      r2: 0,
    };
  }

  const values = data.map((d) => d.value);
  const reg = linearRegression(values);

  // Pick method: use regression if R^2 > 0.5, else moving average
  const useRegression = reg.r2 > 0.5;
  const method: 'linear_regression' | 'moving_average' = useRegression
    ? 'linear_regression'
    : 'moving_average';

  // Parse the last date to project forward
  const lastDate = parseDate(data[data.length - 1].date);
  const n = data.length;

  const forecast: ForecastPoint[] = [];

  if (useRegression) {
    // Project the regression line forward
    // 95% CI: prediction +/- 1.96 * SE * sqrt(1 + 1/n + (x-xbar)^2 / sum((xi-xbar)^2))
    const meanX = (n - 1) / 2;
    let sumXDevSq = 0;
    for (let i = 0; i < n; i++) {
      sumXDevSq += (i - meanX) ** 2;
    }

    for (let p = 1; p <= periods; p++) {
      const x = n - 1 + p;
      const predicted = reg.intercept + reg.slope * x;
      // Prediction interval factor
      const xDev = (x - meanX) ** 2;
      const factor = Math.sqrt(1 + 1 / n + (sumXDevSq > 0 ? xDev / sumXDevSq : 0));
      const margin = 1.96 * reg.standardError * factor;

      const futureDate = advanceDate(lastDate, periodUnit, p);
      forecast.push({
        date: formatDateForUnit(futureDate, periodUnit),
        value: Math.round(predicted * 100) / 100,
        lower: Math.round((predicted - margin) * 100) / 100,
        upper: Math.round((predicted + margin) * 100) / 100,
      });
    }
  } else {
    // Moving average: use last min(6, n) periods
    const windowSize = Math.min(6, n);
    const { avg, stdDev } = movingAverageForecast(values, windowSize);

    for (let p = 1; p <= periods; p++) {
      const futureDate = advanceDate(lastDate, periodUnit, p);
      // Widen confidence interval as we go further out
      const widening = 1 + (p - 1) * 0.15;
      const margin = 1.96 * stdDev * widening;

      forecast.push({
        date: formatDateForUnit(futureDate, periodUnit),
        value: Math.round(avg * 100) / 100,
        lower: Math.round((avg - margin) * 100) / 100,
        upper: Math.round((avg + margin) * 100) / 100,
      });
    }
  }

  // Confidence: based on R^2 and data volume
  const dataConfidence = Math.min(1, data.length / 12); // more data = more confident
  const modelConfidence = useRegression ? reg.r2 : 0.5;
  const confidence = Math.round(dataConfidence * modelConfidence * 100) / 100;

  return {
    historical: data,
    forecast,
    method,
    confidence: Math.max(0.1, Math.min(0.95, confidence)),
    r2: Math.round(reg.r2 * 1000) / 1000,
  };
}
