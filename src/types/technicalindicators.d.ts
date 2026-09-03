declare module "technicalindicators" {
  // ---------------------------------------------------------------------------
  // Base classes
  // ---------------------------------------------------------------------------
  export class IndicatorInput {
    format?: (v: number) => number;
    reversedInput?: boolean;
  }

  export class Indicator {
    constructor(input: IndicatorInput);
    result: any;
    format: (v: number) => number;
    getResult(): any;
    static reverseInputs(input: any): void;
  }

  // ---------------------------------------------------------------------------
  // Moving Averages
  // ---------------------------------------------------------------------------
  export class SMA extends Indicator {
    constructor(input: { period: number; values: number[]; format?: (v: number) => number });
    static calculate(input: { period: number; values: number[] }): number[];
    nextValue(value: number): number | undefined;
  }

  export class EMA extends Indicator {
    constructor(input: { period: number; values: number[]; format?: (v: number) => number });
    static calculate(input: { period: number; values: number[] }): number[];
    nextValue(value: number): number | undefined;
  }

  export class MACD extends Indicator {
    constructor(input: {
      fastPeriod: number;
      slowPeriod: number;
      signalPeriod: number;
      values: number[];
      SimpleMAOscillator?: boolean;
      SimpleMASignal?: boolean;
      format?: (v: number) => number;
    });
    static calculate(input: {
      fastPeriod: number;
      slowPeriod: number;
      signalPeriod: number;
      values: number[];
    }): Array<{ MACD: number; signal: number; histogram: number }>;
    nextValue(price: number): { MACD: number; signal: number; histogram: number } | undefined;
  }

  // ---------------------------------------------------------------------------
  // Oscillators
  // ---------------------------------------------------------------------------
  export class RSI extends Indicator {
    constructor(input: { period: number; values: number[]; format?: (v: number) => number });
    static calculate(input: { period: number; values: number[] }): number[];
    nextValue(value: number): number | undefined;
  }

  export class Stochastic extends Indicator {
    constructor(input: {
      period: number;
      signalPeriod: number;
      high: number[];
      low: number[];
      close: number[];
      format?: (v: number) => number;
    });
    static calculate(input: {
      period: number;
      signalPeriod: number;
      high: number[];
      low: number[];
      close: number[];
    }): Array<{ k: number; d: number }>;
    nextValue(price: number): { k: number; d: number } | undefined;
  }

  // ---------------------------------------------------------------------------
  // Volatility
  // ---------------------------------------------------------------------------
  export class BollingerBands extends Indicator {
    constructor(input: {
      period: number;
      stdDev: number;
      values: number[];
      format?: (v: number) => number;
    });
    static calculate(input: {
      period: number;
      stdDev: number;
      values: number[];
    }): Array<{ upper: number; middle: number; lower: number }>;
    nextValue(value: number): { upper: number; middle: number; lower: number } | undefined;
  }

  // ---------------------------------------------------------------------------
  // Directional Movement
  // ---------------------------------------------------------------------------
  export class ADX extends Indicator {
    constructor(input: {
      period: number;
      high: number[];
      low: number[];
      close: number[];
      format?: (v: number) => number;
    });
    static calculate(input: {
      period: number;
      high: number[];
      low: number[];
      close: number[];
    }): Array<{ adx: number; pdi: number; mdi: number }>;
    nextValue(price: {
      high: number;
      low: number;
      close: number;
    }): { adx: number; pdi: number; mdi: number } | undefined;
  }

  export class ATR extends Indicator {
    constructor(input: {
      period: number;
      high: number[];
      low: number[];
      close: number[];
      format?: (v: number) => number;
    });
    static calculate(input: {
      period: number;
      high: number[];
      low: number[];
      close: number[];
    }): number[];
    nextValue(price: { high: number; low: number; close: number }): number | undefined;
  }

  // ---------------------------------------------------------------------------
  // Ichimoku Cloud
  // ---------------------------------------------------------------------------
  export class IchimokuCloud extends Indicator {
    constructor(input: {
      conversionPeriod?: number;
      basePeriod?: number;
      spanPeriod?: number;
      displacement?: number;
      high: number[];
      low: number[];
      format?: (v: number) => number;
    });
    static calculate(input: {
      conversionPeriod?: number;
      basePeriod?: number;
      spanPeriod?: number;
      displacement?: number;
      high: number[];
      low: number[];
    }): Array<{ conversion: number; base: number; spanA: number; spanB: number }>;
    nextValue(price: { high: number; low: number }): {
      conversion: number;
      base: number;
      spanA: number;
      spanB: number;
    } | undefined;
  }
}
