declare module '@libs/fetch' {
  export function fetchApi(url: string, init?: RequestInit): Promise<Response>;
}

declare module '@libs/storage' {
  type StorageItem<T> = { created: Date; value: T; expires?: number };

  export const storage: {
    get<T = unknown>(key: string, raw: true): StorageItem<T> | undefined;
    get<T = unknown>(key: string): T | undefined;
    set<T>(key: string, value: T, expires?: number): void;
    delete(key: string): void;
    getAllKeys(): string[];
  };
}
