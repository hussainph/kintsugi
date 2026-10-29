import { invoke } from "@tauri-apps/api/core";

/** Mirrors `phone::PhoneStatus` in src-tauri/src/phone/mod.rs. */
export type PhoneStatus = {
  enabled: boolean;
  listening: boolean;
  tailscale: "missing" | "down" | "no_https" | "not_serving" | "ready";
  url: string | null;
  pair: string | null;
  devPair: string | null;
  problem: string | null;
};

/** Mirrors `phone::server::Changed`: a document the phone changed. */
export type Changed = { path: string; text: string | null };

export const phone = {
  status: () => invoke<PhoneStatus>("phone_status"),
  enable: (enabled: boolean) => invoke<PhoneStatus>("phone_enable", { enabled }),
  reset: () => invoke<PhoneStatus>("phone_reset"),
};
