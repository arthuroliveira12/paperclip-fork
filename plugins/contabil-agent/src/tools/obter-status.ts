/**
 * Tool `obter_status` — wrapper sobre GET /sessoes/{id}/status.
 *
 * Erros 404 (sessao inexistente) propagam como `HttpClientError` para que o
 * agent receba o erro estruturado em vez de um payload vazio.
 *
 * Ref: T12 do plano de migracao Paperclip.
 */

import type {
  PluginToolDeclaration,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";

import type { ContabilAgentClient, StatusResponse } from "../http-client.js";

export interface ObterStatusInput {
  sessao_id: string;
}

export const obterStatusDeclaration: Pick<
  PluginToolDeclaration,
  "displayName" | "description" | "parametersSchema"
> = {
  displayName: "Obter status da sessao",
  description:
    "Retorna o snapshot atual de uma sessao do Contabil-Agent (estagio, " +
    "custos LLM acumulados e aprovacoes pendentes).",
  parametersSchema: {
    type: "object",
    required: ["sessao_id"],
    properties: {
      sessao_id: { type: "string" },
    },
  },
};

export const OBTER_STATUS_NAME = "obter_status";

export function makeObterStatusHandler(client: ContabilAgentClient) {
  return async function handler(
    params: unknown,
    _runCtx: ToolRunContext,
  ): Promise<ToolResult> {
    const input = params as ObterStatusInput;
    if (!input || typeof input !== "object" || !input.sessao_id) {
      return { error: "input invalido: sessao_id obrigatorio." };
    }

    const status: StatusResponse = await client.getStatus(input.sessao_id);
    return { content: JSON.stringify(status), data: status };
  };
}
