import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import {
  PROCESSAR_FECHAMENTO_NAME,
  processarFechamentoDeclaration,
} from "./tools/processar-fechamento.js";
import {
  APROVAR_CLASSIFICACAO_NAME,
  aprovarClassificacaoDeclaration,
} from "./tools/aprovar-classificacao.js";
import {
  OBTER_STATUS_NAME,
  obterStatusDeclaration,
} from "./tools/obter-status.js";

/**
 * Stable plugin ID used by host registration and namespacing.
 */
const PLUGIN_ID = "central-do-contador.contabil-agent";
const PLUGIN_VERSION = "0.1.0";

/**
 * Manifest do plugin contabil-agent.
 *
 * Tools (T10–T12) sao declaradas aqui e registradas em runtime no worker
 * via `ctx.tools.register`. A capability `agent.tools.register` autoriza
 * a registracao; `http.outbound` autoriza chamadas ao backend Python.
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
  capabilities: ["agent.tools.register", "http.outbound"],
  tools: [
    {
      name: PROCESSAR_FECHAMENTO_NAME,
      ...processarFechamentoDeclaration,
    },
    {
      name: APROVAR_CLASSIFICACAO_NAME,
      ...aprovarClassificacaoDeclaration,
    },
    {
      name: OBTER_STATUS_NAME,
      ...obterStatusDeclaration,
    },
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
