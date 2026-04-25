/**
 * Tool `aprovar_classificacao` — persiste a decisao de classificacao
 * contabil aprovada por humano via POST /sessoes/{id}/aprovar.
 *
 * Validacao local (debito/credito inteiros, categoria nao-vazia) ocorre
 * antes da chamada ao client para evitar round-trip com payload invalido.
 *
 * Ref: T11 do plano de migracao Paperclip.
 */

import type {
  PluginToolDeclaration,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";

import type { ContabilAgentClient, Decisao } from "../http-client.js";

export interface AprovarClassificacaoInput {
  sessao_id: string;
  approval_id: string;
  decisao: Decisao;
}

export interface AprovarClassificacaoOutput {
  ok: boolean;
  contexto_id: number;
}

export const aprovarClassificacaoDeclaration: Pick<
  PluginToolDeclaration,
  "displayName" | "description" | "parametersSchema"
> = {
  displayName: "Aprovar classificacao contabil",
  description:
    "Persiste no Contabil-Agent a decisao humana de classificacao (debito, " +
    "credito, categoria) referente a uma aprovacao pendente.",
  parametersSchema: {
    type: "object",
    required: ["sessao_id", "approval_id", "decisao"],
    properties: {
      sessao_id: { type: "string" },
      approval_id: { type: "string" },
      decisao: {
        type: "object",
        required: ["debito", "credito", "categoria"],
        properties: {
          debito: { type: "integer" },
          credito: { type: "integer" },
          categoria: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

export const APROVAR_CLASSIFICACAO_NAME = "aprovar_classificacao";

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

export function makeAprovarClassificacaoHandler(client: ContabilAgentClient) {
  return async function handler(
    params: unknown,
    _runCtx: ToolRunContext,
  ): Promise<ToolResult> {
    const input = params as AprovarClassificacaoInput;
    if (!input || typeof input !== "object") {
      return { error: "input invalido: esperado objeto." };
    }
    if (!input.sessao_id || !input.approval_id) {
      return { error: "input invalido: sessao_id e approval_id obrigatorios." };
    }
    const dec = input.decisao;
    if (!dec || typeof dec !== "object") {
      return { error: "input invalido: decisao ausente." };
    }
    if (!isInt(dec.debito) || !isInt(dec.credito)) {
      return {
        error: "decisao invalida: debito e credito devem ser inteiros.",
      };
    }
    if (typeof dec.categoria !== "string" || dec.categoria.trim().length === 0) {
      return { error: "decisao invalida: categoria nao pode ser vazia." };
    }

    const resp = await client.approveSession(input.sessao_id, {
      approval_id: input.approval_id,
      decisao: dec,
    });

    const output: AprovarClassificacaoOutput = {
      ok: resp.ok,
      contexto_id: resp.contexto_id,
    };
    return { content: JSON.stringify(output), data: output };
  };
}
