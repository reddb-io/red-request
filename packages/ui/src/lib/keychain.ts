import { invoke } from "@tauri-apps/api/core";
import { brand } from "./brand.generated";

/** Keychain service id is brand- and collection-scoped so rebrands stay isolated. */
export function secretService(collectionId: string): string {
  return `${brand.identifier}:${collectionId}`;
}

export const setSecret = (
  collectionId: string,
  key: string,
  value: string
): Promise<void> =>
  invoke<void>("keychain_set", {
    service: secretService(collectionId),
    key,
    value,
  });

export const getSecret = (
  collectionId: string,
  key: string
): Promise<string | null> =>
  invoke<string | null>("keychain_get", {
    service: secretService(collectionId),
    key,
  });

export const deleteSecret = (
  collectionId: string,
  key: string
): Promise<void> =>
  invoke<void>("keychain_delete", {
    service: secretService(collectionId),
    key,
  });
