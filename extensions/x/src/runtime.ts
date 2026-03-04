/**
 * X Channel Runtime
 *
 * Holds a reference to the OpenClaw PluginRuntime, set during plugin
 * registration. This is the bridge between the X channel and the
 * OpenClaw core message pipeline.
 *
 * Follows the same pattern as the nostr plugin's runtime.ts.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setXRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getXRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("X channel runtime not initialized");
  }
  return runtime;
}
