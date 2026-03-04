import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xPlugin } from "./src/channel.js";
import { setXRuntime } from "./src/runtime.js";

const plugin = {
  id: "x",
  name: "X (Twitter)",
  description: "OpenClaw X channel plugin for mention-driven AI agent interactions",
  configSchema: emptyPluginConfigSchema(),

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
