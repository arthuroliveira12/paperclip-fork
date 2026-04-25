/**
 * Testes unitarios do ContabilAgentClient (T9).
 *
 * Estrategia: stub do `globalThis.fetch` por teste via Vitest, sem
 * dependencias adicionais (nock/msw). `baseDelayMs: 1` mantem os
 * testes de retry abaixo de 100ms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContabilAgentClient, HttpClientError } from "./http-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ContabilAgentClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createSession faz POST multipart em /processar e retorna sessao_id", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ sessao_id: "abc-123", status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ContabilAgentClient({
      baseUrl: "http://api.test",
      maxRetries: 0,
      baseDelayMs: 1,
    });

    const result = await client.createSession({
      empresa: "ACME",
      periodo: "112025",
      modo: "autonomo",
    });

    expect(result.sessao_id).toBe("abc-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe("http://api.test/processar");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get("empresa")).toBe("ACME");
    expect(form.get("periodo")).toBe("112025");
    expect(form.get("modo")).toBe("autonomo");
  });

  it("patchSession envia JSON em PATCH /sessoes/{id} e devolve a sessao", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        sessao_id: "sess-9",
        empresa: "ACME",
        paperclip_task_id: "task-42",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ContabilAgentClient({
      baseUrl: "http://api.test",
      maxRetries: 0,
      baseDelayMs: 1,
    });

    const sessao = await client.patchSession("sess-9", {
      paperclip_task_id: "task-42",
    });

    expect(sessao.paperclip_task_id).toBe("task-42");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe("http://api.test/sessoes/sess-9");
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ paperclip_task_id: "task-42" }));
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBe("application/json");
  });

  it("propaga 404 imediatamente, sem retry", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("nao encontrado", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ContabilAgentClient({
      baseUrl: "http://api.test",
      maxRetries: 3,
      baseDelayMs: 1,
    });

    await expect(client.getStatus("missing")).rejects.toBeInstanceOf(
      HttpClientError,
    );
    await expect(client.getStatus("missing")).rejects.toMatchObject({
      status: 404,
    });
    // Duas chamadas (uma por await acima), nenhuma com retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retenta em 5xx e devolve sucesso na segunda tentativa", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: "processing",
          estagio_atual: "classificacao",
          custos_llm: { tokens_input: 0, tokens_output: 0, usd: 0 },
          aprovacoes_pendentes: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ContabilAgentClient({
      baseUrl: "http://api.test",
      maxRetries: 3,
      baseDelayMs: 1,
    });

    const status = await client.getStatus("sess-1");
    expect(status.status).toBe("processing");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("connectEvents constroi WebSocket com URL ws://.../sessoes/{id}/eventos", () => {
    const created: string[] = [];
    class FakeWS {
      url: string;
      constructor(url: string) {
        this.url = url;
        created.push(url);
      }
    }
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);

    const client = new ContabilAgentClient({
      baseUrl: "http://api.test",
    });
    const ws = client.connectEvents("sess-7") as unknown as FakeWS;

    expect(ws.url).toBe("ws://api.test/sessoes/sess-7/eventos");
    expect(created).toEqual(["ws://api.test/sessoes/sess-7/eventos"]);
  });
});
