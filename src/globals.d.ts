// The build targets ES2017 without DOM or Node typings, so the few host
// globals the library touches are declared here. Every one of them is read
// defensively at runtime.
declare const console: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;

// Metro provides CommonJS `require` in every module.
declare function require(id: string): any;

// React Native 0.60+ and every current browser and Node provide it; it is
// checked with `typeof` before use.
declare const AbortController: {
  new (): { readonly signal: import('./types').AbortSignalLike; abort(): void };
};
