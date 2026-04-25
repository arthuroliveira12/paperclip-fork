/**
 * Testes da tool `aprovar_classificacao` (T11).
 */

import { describe, expect, it, vi } from "vitest";

import type { ContabilAgentClient } from "../http-client.js";
import { makeAprovarClassificacaoHandler } from "./aprovar-classificacao.js";

const runCtx = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "co-1",
  projectId: "proj-1",
};

describe("aprovar_classificacao tool", () => {
  it("aprova decisao valida e devolve ok + contexto_id", async () => {
    const client = {
      approveSession: vi
        .fn()
        .mockResolvedValue({ ok: true, contexto_id: 7 }),
    } as unknown as ContabilAgentClient;

    const handler = makeAprovarClassificacaoHandler(client);
    const result = await handler(
      {
        sessao_id: "sess-1",
        approval_id: "appr-9",
        decisao: { debito: 100, credito: 200, categoria: "Despesas" },
      },
      runCtx,
    );

    expect(client.approveSession).toHaveBeenCalledWith("sess-1", {
      approval_id: "appr-9",
      decisao: { debito: 100, credito: 200, categoria: "Despesas" },
    });
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ ok: true, contexto_id: 7 });
  });

  it("rejeita decisao invalida localmente (sem chamar client)", async () => {
    const client = {
      approveSession: vi.fn(),
    } as unknown as ContabilAgentClient;

    const handler = makeAprovarClassificacaoHandler(client);

    // debito nao inteiro
    const r1 = await handler(
      {
        sessao_id: "sess-1",
        approval_id: "appr-1",
        decisao: { debito: 1.5, credito: 2, categoria: "X" },
      },
      runCtx,
    );
    expect(r1.error).toMatch(/inteiros/);

    // categoria vazia
    const r2 = await handler(
      {
        sessao_id: "sess-1",
        approval_id: "appr-1",
        decisao: { debito: 1, credito: 2, categoria: "   " },
      },
      runCtx,
    );
    expect(r2.error).toMatch(/categoria/);

    expect(client.approveSession).not.toHaveBeenCalled();
  });
});
