import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

import { ContabilAgentClient } from "./http-client.js";
import {
  PROCESSAR_FECHAMENTO_NAME,
  makeProcessarFechamentoHandler,
  processarFechamentoDeclaration,
} from "./tools/processar-fechamento.js";
import {
  APROVAR_CLASSIFICACAO_NAME,
  aprovarClassificacaoDeclaration,
  makeAprovarClassificacaoHandler,
} from "./tools/aprovar-classificacao.js";
import {
  OBTER_STATUS_NAME,
  makeObterStatusHandler,
  obterStatusDeclaration,
} from "./tools/obter-status.js";

const PLUGIN_NAME = "contabil-agent";
const DEFAULT_API_URL = "http://localhost:8000";

/**
 * Worker entrypoint para o plugin contabil-agent.
 *
 * T10–T12: registra as tools `processar_fechamento`, `aprovar_classificacao`
 * e `obter_status`, todas compartilhando uma unica instancia de
 * `ContabilAgentClient` configurada via env `CONTABIL_AGENT_API_URL`.
 */
const plugin = definePlugin({
  async setup(ctx) {
    const baseUrl = process.env.CONTABIL_AGENT_API_URL ?? DEFAULT_API_URL;
    ctx.logger.info(
      `[${PLUGIN_NAME}] inicializando com baseUrl=${baseUrl}`,
    );

    const client = new ContabilAgentClient({
      baseUrl,
      logger: ctx.logger,
    });

    ctx.tools.register(
      PROCESSAR_FECHAMENTO_NAME,
      processarFechamentoDeclaration,
      makeProcessarFechamentoHandler(client),
    );
    ctx.tools.register(
      APROVAR_CLASSIFICACAO_NAME,
      aprovarClassificacaoDeclaration,
      makeAprovarClassificacaoHandler(client),
    );
    ctx.tools.register(
      OBTER_STATUS_NAME,
      obterStatusDeclaration,
      makeObterStatusHandler(client),
    );

    ctx.logger.info(`[${PLUGIN_NAME}] 3 tools registradas`);
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
