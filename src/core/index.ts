export declare interface InjectionKey<T> extends Symbol {}

export interface App {
  start(callback: Plugin): this;
  use(plugin: Plugin): this;
  provide<T>(key: InjectionKey<T> | string, value: T): this;
}

export type Plugin = (app: App) => void;

const symbols = new Map();

export function inject<T>(key: InjectionKey<T> | string): T | undefined;
export function inject<T>(key: InjectionKey<T> | string, defaultValue: T): T;
export function inject<T>(key: InjectionKey<T> | string, defaultValue?: T) {
  if (symbols.has(key)) {
    return symbols.get(key);
  }

  return defaultValue;
}

export function createApp(): App {
  const state = new Map();
  const plugins = new Map();
  const listeners = new Map();

  return {
    use(plugin) {
      plugin(this);
      return this;
    },
    provide(key, value) {
      symbols.set(key, value);
      return this;
    },
    start(callback: Plugin) {
      if (state.has("started")) return this;
      state.set("started", true);
      callback(this);
      return this;
    },
  };
}
