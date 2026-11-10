/**
 * API keys kept in the OS credential store (the macOS Keychain, the Linux Secret Service) by the
 * desktop extension that uses them: the voice extension's Deepgram and ElevenLabs keys, the hub's
 * Anthropic key for the companion's API key brain. Each extension reaches its own namespace of
 * Denext's secure store (`ctx.secureStore` / `host.secureStore`, stored under
 * `<app identifier>/ext/<extension>`), which no page and no other extension can read.
 *
 * The page never holds a key after it typed one: it can set a key, clear it and ask whether one
 * is set ({@linkcode KeyPresence}); only the extension reads it back, when it calls the service.
 *
 * Pure apart from the injected store.
 *
 * @module
 */

/** The store an extension gets (structurally Denext's `DesktopSecureStore`). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The longest key accepted (real ones are well under 200 characters). */
export const API_KEY_MAX = 512;

/**
 * `raw` as a key to store: trimmed, at most {@linkcode API_KEY_MAX} characters, with no space or
 * control character inside (a pasted key with a line break is refused rather than stored broken).
 * Throws a message the page can show.
 */
export function checkApiKey(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("the key must be text");
  const key = raw.trim();
  if (!key) throw new Error("the key is empty");
  if (key.length > API_KEY_MAX) {
    throw new Error(`the key is longer than ${API_KEY_MAX} characters`);
  }
  // deno-lint-ignore no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(key)) {
    throw new Error("the key has a space or a line break in it");
  }
  return key;
}

/** Which services have a key set: what the page may know. */
export type KeyPresence<S extends string> = Record<S, boolean>;

/** One extension's API keys, one per service, in its own secure-store namespace. */
export class ApiKeys<S extends string> {
  #store: () => SecretStore | undefined;
  #services: readonly S[];
  #name: (service: S) => string;

  /**
   * @param store The extension's secure store (`undefined` while it is not there yet: the
   *   extension is not set up, or a test without one).
   * @param services The services a key can be kept for.
   * @param name The store key of a service's API key.
   */
  constructor(
    store: () => SecretStore | undefined,
    services: readonly S[],
    name: (service: S) => string,
  ) {
    this.#store = store;
    this.#services = services;
    this.#name = name;
  }

  #need(): SecretStore {
    const store = this.#store();
    if (!store) throw new Error("the OS keychain is not available");
    return store;
  }

  #check(service: S): S {
    if (!this.#services.includes(service)) {
      throw new Error(`no key is kept for ${String(service)}`);
    }
    return service;
  }

  /** The key for `service`, or `null` (the extension's side only: never sent to the page). */
  async get(service: S): Promise<string | null> {
    const key = await this.#need().get(this.#name(this.#check(service)));
    return key ? key : null;
  }

  /** Which services have a key. */
  async presence(): Promise<KeyPresence<S>> {
    const out = {} as KeyPresence<S>;
    for (const s of this.#services) out[s] = (await this.get(s)) !== null;
    return out;
  }

  /** Keep `raw` (checked by {@linkcode checkApiKey}) as `service`'s key, replacing any. */
  async set(service: S, raw: unknown): Promise<void> {
    const key = checkApiKey(raw);
    await this.#need().set(this.#name(this.#check(service)), key);
  }

  /** Remove `service`'s key (nothing to do when there is none). */
  async clear(service: S): Promise<void> {
    await this.#need().delete(this.#name(this.#check(service)));
  }
}

/** An in-memory store: the browser demo's stand-in for the OS keychain, and the tests'. */
export function memorySecretStore(
  seed: Record<string, string> = {},
): SecretStore & { items: Map<string, string> } {
  const items = new Map(Object.entries(seed));
  return {
    items,
    get: (key) => Promise.resolve(items.get(key) ?? null),
    set(key, value) {
      items.set(key, value);
      return Promise.resolve();
    },
    delete(key) {
      items.delete(key);
      return Promise.resolve();
    },
  };
}
