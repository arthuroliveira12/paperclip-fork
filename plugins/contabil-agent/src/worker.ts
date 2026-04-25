import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

import { ContabilAgentClient } from "./http-client.js";
import {
  EventListener,
  type PaperclipSideEffects,
} from "./event-listener.js";
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

    // T13: side effects do Paperclip ainda nao sao expostos ao plugin worker
    // pelo SDK (ToolRunContext = {agentId,runId,companyId,projectId} apenas).
    // Por ora, registramos uma implementacao stub baseada em logger para
    // observabilidade; T-future ira religar isto a `ctx.approvals`,
    // `ctx.workProducts`, `ctx.tasks` quando o SDK expor essas APIs.
    const effects: PaperclipSideEffects = {
      async updateTaskProgress(taskRunId, payload) {
        ctx.logger.info(
          `[${PLUGIN_NAME}] task=${taskRunId} estagio=${payload.estagio}${payload.descricao ? ` (${payload.descricao})` : ""}`,
        );
      },
      async createApproval(taskRunId, payload) {
        ctx.logger.info(
          `[${PLUGIN_NAME}] task=${taskRunId} approval pendente=${payload.approval_id} titulo="${payload.titulo}"`,
        );
      },
      async uploadWorkProduct(taskRunId, payload) {
        ctx.logger.info(
          `[${PLUGIN_NAME}] task=${taskRunId} work-product nome=${payload.nome} mime=${payload.mime}`,
        );
      },
      async markTaskComplete(taskRunId, payload) {
        ctx.logger.info(
          `[${PLUGIN_NAME}] task=${taskRunId} concluida (artifacts=${payload?.artifacts?.length ?? 0})`,
        );
      },
      async markTaskFailed(taskRunId, payload) {
        ctx.logger.error(
          `[${PLUGIN_NAME}] task=${taskRunId} FAILED: ${payload.erro}`,
        );
      },
      // recordCostEvent fica indefinido ate T18 plugar o handler real.
    };

    const eventListener = new EventListener({
      client,
      effects,
      logger: ctx.logger,
    });

    ctx.tools.register(
      PROCESSAR_FECHAMENTO_NAME,
      processarFechamentoDeclaration,
      makeProcessarFechamentoHandler(client, eventListener),
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
