import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { xPlugin } from "./src/channel.js";
import { XChannelConfigSchema } from "./src/config-schema.js";
import { setXRuntime } from "./src/runtime.js";

/**
 * Wrap the Zod schema in the OpenClawPluginConfigSchema interface so the
 * runtime can call safeParse/parse for validation and generate JSON Schema
 * for the UI config tooling.
 */
const xConfigSchema = {
  safeParse: (value: unknown) => XChannelConfigSchema.safeParse(value),
  parse: (value: unknown) => XChannelConfigSchema.parse(value),
  jsonSchema: XChannelConfigSchema.toJSONSchema({
    target: "draft-07",
    unrepresentable: "any",
  }) as Record<string, unknown>,
};

const plugin = {
  id: "x",
  name: "X (Twitter)",
  description: "OpenClaw X channel plugin for mention-driven AI agent interactions",
  configSchema: xConfigSchema,

  register(api: OpenClawPluginApi) {
    // Store the runtime reference so the channel can dispatch inbound messages
    // via runtime.channel.reply.handleInboundMessage()
    setXRuntime(api.runtime);

    // Register the X channel with OpenClaw
    api.registerChannel({ plugin: xPlugin });

    api.logger?.info?.("X (Twitter) channel plugin registered.");
  },
};

export default plugin;
