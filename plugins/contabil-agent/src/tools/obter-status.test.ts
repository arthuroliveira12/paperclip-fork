/**
 * Testes da tool `obter_status` (T12).
 */

import { describe, expect, it, vi } from "vitest";

import { ContabilAgentClient, HttpClientError } from "../http-client.js";
import { makeObterStatusHandler } from "./obter-status.js";

const runCtx = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "co-1",
  projectId: "proj-1",
};

describe("obter_status tool", () => {
  it("retorna o status quando a sessao existe", async () => {
    const status = {
      status: "processing",
      estagio_atual: "classificacao",
      custos_llm: { tokens_input: 10, tokens_output: 5, usd: 0.001 },
      aprovacoes_pendentes: [],
    };
    const client = {
      getStatus: vi.fn().mockResolvedValue(status),
    } as unknown as ContabilAgentClient;

    const handler = makeObterStatusHandler(client);
    const result = await handler({ sessao_id: "sess-1" }, runCtx);

    expect(client.getStatus).toHaveBeenCalledWith("sess-1");
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual(status);
  });

  it("propaga 404 quando a sessao nao existe", async () => {
    const fail = new HttpClientError({
      status: 404,
      body: "nao encontrada",
      url: "http://api.test/sessoes/xxx/status",
      method: "GET",
    });
    const client = {
      getStatus: vi.fn().mockRejectedValue(fail),
    } as unknown as ContabilAgentClient;

    const handler = makeObterStatusHandler(client);
    await expect(
      handler({ sessao_id: "xxx" }, runCtx),
    ).rejects.toBeInstanceOf(HttpClientError);
  });
});
