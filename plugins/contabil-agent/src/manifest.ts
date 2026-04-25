import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Stable plugin ID used by host registration and namespacing.
 */
const PLUGIN_ID = "central-do-contador.contabil-agent";
const PLUGIN_VERSION = "0.1.0";

/**
 * Skeleton manifest for the contabil-agent plugin.
 *
 * Future versions will add tools (processar_fechamento, aprovar_classificacao,
 * obter_status) and event subscriptions to the Contabil-Agent backend.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Contabil-Agent",
  description:
    "Bridges Paperclip with the Contabil-Agent Python backend (api.py) for accounting workflows.",
  author: "Central do Contador",
  categories: ["automation"],
  capabilities: [],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
