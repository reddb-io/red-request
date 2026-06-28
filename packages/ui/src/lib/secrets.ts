import { invoke } from "@tauri-apps/api/core";
import type { SealedSecret } from "@reddb-io/request-core";

/** Seal a plaintext secret via the Rust bridge (AES-256-GCM, key in OS keychain). */
export const seal = (plaintext: string): Promise<SealedSecret> =>
  invoke<SealedSecret>("secret_seal", { plaintext });

/** Open a sealed secret back to plaintext. */
export const open = (s: SealedSecret): Promise<string> =>
  invoke<string>("secret_open", { iv: s.iv, ct: s.ct });
