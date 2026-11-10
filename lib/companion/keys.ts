/**
 * The companion's API keys: the API key brain's Anthropic key, kept by the hub extension in the OS
 * keychain (its own namespace of Denext's secure store, desktop/hub.ts), or in memory by the
 * browser demo (lib/hub-demo.ts). The page sets or clears it and asks whether it is set.
 *
 * Client-safe and pure.
 *
 * @module
 */

import { ApiKeys, type SecretStore } from "../secrets/api-keys.ts";

/** The services the companion keeps a key for. */
export type CompanionKeyService = "anthropic";
/** Every such service. */
const COMPANION_KEY_SERVICES: readonly CompanionKeyService[] = [
  "anthropic",
];

/** The secure-store key of a service's API key (in the hub extension's own namespace). */
const companionKeyName = (service: CompanionKeyService) =>
  `companion.${service}.apiKey`;

/** The companion's keys in `store`. */
export function companionKeys(
  store: () => SecretStore | undefined,
): ApiKeys<CompanionKeyService> {
  return new ApiKeys(store, COMPANION_KEY_SERVICES, companionKeyName);
}
