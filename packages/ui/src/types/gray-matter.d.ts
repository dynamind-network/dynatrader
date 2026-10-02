declare module 'gray-matter' {
  interface GrayMatterFile<T = string> {
    data: T;
    content: string;
    excerpt?: string;
    sections?: string[];
    manifest?: Record<string, unknown>;
  }

  interface GrayMatterOptions<T = Record<string, unknown>> {
    engines?: Record<string, unknown>;
    delims?: [string, string] | readonly [string, string];
    sectionDelims?: [string, string] | readonly [string, string];
    excerpt?: boolean | ((file: GrayMatterFile<T>) => string);
    excerptTrim?: boolean | false;
    dedent?: boolean | false;
    normalize?: boolean | true;
    eval?: boolean | false;
    enginesSection?: boolean | true;
    toml?: Record<string, unknown>;
    json?: Record<string, unknown>;
  }

  interface StringifyOptions {
    delims?: [string, string] | readonly [string, string];
    sectionDelims?: [string, string] | readonly [string, string];
    lang?: string;
    force?: boolean;
    dedent?: boolean | false;
  }

  function matter<T = Record<string, unknown>>(
    input: string,
    options?: GrayMatterOptions<T>
  ): GrayMatterFile<T>;

  namespace matter {
    function stringify(input: string, data: Record<string, unknown>, options?: StringifyOptions): string;
    function stringify(input: string, data: string, options?: StringifyOptions): string;
  }

  export = matter;
}

