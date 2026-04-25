import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const PLUGIN_NAME = "contabil-agent";

/**
 * Worker entrypoint for the contabil-agent plugin.
 *
 * Skeleton only — T8. The real bridge to Contabil-Agent (HTTP client +
 * processar_fechamento / aprovar_classificacao / obter_status tools) lands
 * in T9–T12.
 */
const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`[${PLUGIN_NAME}] plugin registrado (skeleton T8)`);
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} skeleton ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
