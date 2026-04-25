/**
 * Tool `processar_fechamento` — cria uma sessao no Contabil-Agent e
 * gravar de volta o paperclip_task_id (runId do tool runtime) para fechar
 * o loop de correlacao entre Paperclip e api.py.
 *
 * Ref: T10 do plano de migracao Paperclip.
 */

import type {
  PluginToolDeclaration,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";

import type {
  ContabilAgentClient,
  CreateSessionInput,
} from "../http-client.js";
import type { EventListener } from "../event-listener.js";

/**
 * Arquivo de extrato a ser enviado ao backend.
 *
 * TODO(T13+): integrar upload real de arquivos via FormData multipart.
 * Atualmente o `ContabilAgentClient.createSession` ainda nao consome
 * `arquivos`; o campo eh aceito aqui para preservar o contrato de tool
 * mas e ignorado silenciosamente ate a integracao completa.
 */
export interface ArquivoUpload {
  name: string;
  content: Buffer | Uint8Array | string;
}

export interface ProcessarFechamentoInput {
  empresa: string;
  periodo: string;
  modo?: string;
  arquivos?: ArquivoUpload[];
}

export interface ProcessarFechamentoOutput {
  sessao_id: string;
  task_id: string;
  status: string;
}

/** Declaracao para o `ctx.tools.register` (terceiro arg do SDK). */
export const processarFechamentoDeclaration: Pick<
  PluginToolDeclaration,
  "displayName" | "description" | "parametersSchema"
> = {
  displayName: "Processar fechamento contabil",
  description:
    "Inicia o processamento de um fechamento contabil mensal no Contabil-Agent " +
    "criando uma sessao no backend e correlacionando-a ao Task do Paperclip.",
  parametersSchema: {
    type: "object",
    required: ["empresa", "periodo"],
    properties: {
      empresa: { type: "string", description: "Identificador/CNPJ da empresa." },
      periodo: { type: "string", description: "Periodo MMYYYY (ex.: 112025)." },
      modo: {
        type: "string",
        description: "Modo de execucao (ex.: 'autonomo'). Opcional.",
      },
      arquivos: {
        type: "array",
        description:
          "Lista de arquivos de extrato (upload). Opcional ate T13.",
        items: {
          type: "object",
          required: ["name", "content"],
          properties: {
            name: { type: "string" },
            content: {},
          },
        },
      },
    },
  },
};

/** Nome estavel da tool, usado no manifest e no `ctx.tools.register`. */
export const PROCESSAR_FECHAMENTO_NAME = "processar_fechamento";

/**
 * Constroi o handler da tool, fechando sobre uma instancia compartilhada
 * de `ContabilAgentClient` e — opcionalmente — um `EventListener` que
 * sera ligado a sessao recem-criada (T13).
 *
 * O `listener` eh opcional para preservar a assinatura usada pelos testes
 * de T10; quando passado, o handler chama `listener.attach(sessao_id, runId)`
 * apos `patchSession` ter completado com sucesso.
 */
export function makeProcessarFechamentoHandler(
  client: ContabilAgentClient,
  listener?: EventListener,
) {
  return async function handler(
    params: unknown,
    runCtx: ToolRunContext,
  ): Promise<ToolResult> {
    const input = params as ProcessarFechamentoInput;
    if (!input || typeof input !== "object") {
      return { error: "input invalido: esperado objeto." };
    }
    if (!input.empresa || !input.periodo) {
      return { error: "input invalido: empresa e periodo sao obrigatorios." };
    }

    // TODO(T13+): integrar upload de arquivos. Por ora, repassamos apenas
    // empresa/periodo/modo ao backend; arquivos sao aceitos no contrato
    // mas nao transmitidos ate o client ser estendido.
    const createInput: CreateSessionInput = {
      empresa: input.empresa,
      periodo: input.periodo,
      modo: input.modo,
    };

    const sessao = await client.createSession(createInput);

    // Fecha o loop: persiste o runId (Paperclip Task ID) na sessao.
    await client.patchSession(sessao.sessao_id, {
      paperclip_task_id: runCtx.runId,
    });

    // T13: liga o WS de eventos do pipeline a esta sessao (se o worker
    // injetou um listener). Erros de attach nao devem derrubar a tool —
    // o listener loga internamente e tentara reconectar.
    if (listener) {
      try {
        listener.attach(sessao.sessao_id, runCtx.runId);
      } catch {
        // ignore: o listener ja loga; nao bloqueia o retorno da tool.
      }
    }

    const output: ProcessarFechamentoOutput = {
      sessao_id: sessao.sessao_id,
      task_id: runCtx.runId,
      status: "processing",
    };
    return { content: JSON.stringify(output), data: output };
  };
}
