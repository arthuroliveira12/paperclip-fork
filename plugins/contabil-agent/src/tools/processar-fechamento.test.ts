/**
 * Testes da tool `processar_fechamento` (T10).
 *
 * Mock do `ContabilAgentClient` por teste — nao tocamos o api.py real.
 */

import { describe, expect, it, vi } from "vitest";

import { ContabilAgentClient, HttpClientError } from "../http-client.js";
import {
  makeProcessarFechamentoHandler,
  type ProcessarFechamentoOutput,
} from "./processar-fechamento.js";

const runCtx = {
  agentId: "agent-1",
  runId: "task-paperclip-99",
  companyId: "co-1",
  projectId: "proj-1",
};

describe("processar_fechamento tool", () => {
  it("cria sessao e fecha o loop com paperclip_task_id (happy path)", async () => {
    const client = {
      createSession: vi.fn().mockResolvedValue({ sessao_id: "sess-42" }),
      patchSession: vi.fn().mockResolvedValue({
        sessao_id: "sess-42",
        paperclip_task_id: "task-paperclip-99",
      }),
    } as unknown as ContabilAgentClient;

    const handler = makeProcessarFechamentoHandler(client);
    const result = await handler(
      { empresa: "ACME", periodo: "112025", modo: "autonomo" },
      runCtx,
    );

    expect(client.createSession).toHaveBeenCalledWith({
      empresa: "ACME",
      periodo: "112025",
      modo: "autonomo",
    });
    expect(client.patchSession).toHaveBeenCalledWith("sess-42", {
      paperclip_task_id: "task-paperclip-99",
    });

    expect(result.error).toBeUndefined();
    const data = result.data as ProcessarFechamentoOutput;
    expect(data).toEqual({
      sessao_id: "sess-42",
      task_id: "task-paperclip-99",
      status: "processing",
    });
  });

  it("propaga erro 5xx do api.py (nao engole)", async () => {
    const fail = new HttpClientError({
      status: 502,
      body: "bad gateway",
      url: "http://api.test/processar",
      method: "POST",
    });
    const client = {
      createSession: vi.fn().mockRejectedValue(fail),
      patchSession: vi.fn(),
    } as unknown as ContabilAgentClient;

    const handler = makeProcessarFechamentoHandler(client);
    await expect(
      handler({ empresa: "ACME", periodo: "112025" }, runCtx),
    ).rejects.toBeInstanceOf(HttpClientError);
    expect(client.patchSession).not.toHaveBeenCalled();
  });
});
