import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

import { ContabilAgentClient } from "./http-client.js";
import {
  EventListener,
  type PaperclipSideEffects,
} from "./event-listener.js";
// NB: PaperclipAdminClient vive em scripts/_admin-client.ts (fora do rootDir
// `src/`), portanto nao pode ser importado direto pelo worker. Para T18,
// inlineamos um POST minimo aqui — mesmo contrato (`POST /api/companies/
// :companyId/cost-events`) e mesmo body schema (createCostEventSchema em
// packages/shared/src/validators/cost.ts).
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
const DEFAULT_PAPERCLIP_URL = "http://localhost:3000";

/**
 * Converte um custo em USD (float) para centavos inteiros, como o servidor
 * Paperclip exige (`costCents: z.number().int().nonnegative()`). Usa USD-cents
 * por compatibilidade ate haver currency conversion no pipeline.
 */
function usdToCents(usd: number | undefined): number {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return 0;
  return Math.round(usd * 100);
}

/**
 * POST /api/companies/:companyId/cost-events — espelha o body do
 * `createCostEventSchema` em packages/shared/src/validators/cost.ts.
 */
async function postCostEventToPaperclip(
  paperclipBaseUrl: string,
  companyId: string,
  body: {
    agentId: string;
    issueId?: string | null;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    occurredAt: string;
  },
  authToken?: string,
): Promise<void> {
  const url = `${paperclipBaseUrl.replace(/\/+$/, "")}/api/companies/${encodeURIComponent(companyId)}/cost-events`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${url} -> ${res.status} ${text}`);
  }
}

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

    // T18: configuracao do POST cost-events no Paperclip server.
    const paperclipUrl =
      process.env.PAPERCLIP_API_URL ?? DEFAULT_PAPERCLIP_URL;
    const paperclipToken = process.env.PAPERCLIP_AUTH_TOKEN;

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
      // T18: cost events. Filtra `dados.tipo === 'llm_call'` ja eh feito no
      // listener; aqui apenas posta no Paperclip server via admin client.
      // Falhas NAO derrubam o pipeline (log + continue).
      async recordCostEvent(taskRunId, payload, context) {
        const companyId =
          context?.companyId ?? process.env.CONTABIL_AGENT_COMPANY_ID;
        const agentId =
          context?.agentId ?? process.env.CONTABIL_AGENT_AGENT_ID;

        if (!companyId || !agentId) {
          // Sem contexto suficiente para postar no Paperclip — apenas loga.
          ctx.logger.info(
            `[${PLUGIN_NAME}] cost-event task=${taskRunId} modelo=${String(payload.modelo ?? "?")} custo_usd=${String(payload.custo_usd ?? 0)} ` +
              `(NAO postado: ${!companyId ? "companyId" : "agentId"} ausente; ` +
              `defina CONTABIL_AGENT_COMPANY_ID/CONTABIL_AGENT_AGENT_ID ou passe context em attach())`,
          );
          return;
        }

        try {
          await postCostEventToPaperclip(
            paperclipUrl,
            companyId,
            {
              agentId,
              issueId: taskRunId, // task/run id do Paperclip
              provider: "contabil-agent",
              model: String(payload.modelo ?? "unknown"),
              inputTokens:
                typeof payload.tokens_input === "number"
                  ? payload.tokens_input
                  : 0,
              outputTokens:
                typeof payload.tokens_output === "number"
                  ? payload.tokens_output
                  : 0,
              costCents: usdToCents(payload.custo_usd),
              occurredAt: new Date().toISOString(),
            },
            paperclipToken,
          );
          ctx.logger.debug(
            `[${PLUGIN_NAME}] cost-event registrado task=${taskRunId} modelo=${String(payload.modelo ?? "?")}`,
          );
        } catch (err) {
          ctx.logger.warn(
            `[${PLUGIN_NAME}] falha ao registrar cost-event task=${taskRunId}: ${String(err)} (ignorando — listener segue)`,
          );
        }
      },
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
