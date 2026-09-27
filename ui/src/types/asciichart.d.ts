declare module 'asciichart' {
  interface PlotConfig {
    colors?: string[];
    format?: (value: number) => string;
    height?: number;
    max?: number;
    min?: number;
    offset?: number;
    padding?: string;
    symbols?: string[];
  }

  const asciichart: {
    green: string;
    plot(series: number[] | number[][], config?: PlotConfig): string;
    red: string;
  };

  export default asciichart;
}
