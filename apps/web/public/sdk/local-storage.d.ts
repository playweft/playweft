/** Async string storage scoped to the validated game origin by the platform. */
export interface LocalStorageClient {
  getItem(key: unknown): Promise<string | null>;
  setItem(key: unknown, value: unknown): Promise<void>;
  removeItem(key: unknown): Promise<void>;
  clear(): Promise<void>;
  key(index: number): Promise<string | null>;
  length(): Promise<number>;
  /** Reject outstanding requests and release this client's port listener. */
  destroy(): void;
}

export declare function createLocalStorageClient(
  port: MessagePort,
  options?: { timeoutMs?: number },
): LocalStorageClient;
