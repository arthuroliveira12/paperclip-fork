/**
 * Testes do EventListener (T13).
 *
 * Mocks:
 *   - WebSocket: classe FakeWebSocket extends EventTarget — simula
 *     open/message/close.
 *   - PaperclipSideEffects: spies vi.fn() injetados via construtor.
 *   - scheduler: substitui setTimeout/clearTimeout para tornar reconnect
 *     deterministico (executa imediatamente quando solicitamos).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContabilAgentClient } from "./http-client.js";
import {
  EventListener,
  type PaperclipSideEffects,
} from "./event-listener.js";

// ---------------------------------------------------------------------------
// FakeWebSocket — minima superficie usada pelo listener.
// ---------------------------------------------------------------------------

class FakeWebSocket extends EventTarget {
  readyState: number = 1;
  // Evita erro "WebSocket is not defined" em ambientes node sem WS global —
  // o listener so usa addEventListener e close().
  send = vi.fn();
  close = vi.fn(function (this: FakeWebSocket) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    // O detach passa por aqui; o teste sinaliza wasClean conforme o caso.
    this.dispatchEvent(
      new CloseEvent("close", { wasClean: true, code: 1000 }),
    );
  });

  emitOpen(): void {
    this.dispatchEvent(new Event("open"));
  }
  emitMessage(payload: unknown): void {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  emitUnexpectedClose(code = 1006): void {
    this.readyState = 3;
    this.dispatchEvent(
      new CloseEvent("close", { wasClean: false, code }),
    );
  }
  emitError(message = "boom"): void {
    this.dispatchEvent(new ErrorEvent("error", { message }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEffects(
  overrides: Partial<PaperclipSideEffects> = {},
): PaperclipSideEffects {
  return {
    updateTaskProgress: vi.fn().mockResolvedValue(undefined),
    createApproval: vi.fn().mockResolvedValue(undefined),
    uploadWorkProduct: vi.fn().mockResolvedValue(undefined),
    markTaskComplete: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

interface ManualScheduler {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  /** Dispara o ultimo callback agendado, util para acionar reconnect. */
  runNext: () => void;
  pending: Array<{ cb: () => void; ms: number; cancelled: boolean }>;
}

function makeScheduler(): ManualScheduler {
  const pending: ManualScheduler["pending"] = [];
  return {
    pending,
    setTimeout: (cb, ms) => {
      const entry = { cb, ms, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (h) => {
      const entry = h as { cancelled: boolean } | null;
      if (entry) entry.cancelled = true;
    },
    runNext: () => {
      const next = pending.find((p) => !p.cancelled);
      if (!next) throw new Error("nenhum timer pendente");
      next.cancelled = true;
      next.cb();
    },
  };
}

/** Aguarda flush de microtasks (handlers async do listener). */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("EventListener (T13)", () => {
  let ws: FakeWebSocket;
  let connectEvents: ReturnType<typeof vi.fn>;
  let client: ContabilAgentClient;
  let scheduler: ManualScheduler;

  beforeEach(() => {
    ws = new FakeWebSocket();
    connectEvents = vi.fn(() => ws);
    client = { connectEvents } as unknown as ContabilAgentClient;
    scheduler = makeScheduler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispara updateTaskProgress em estagio_iniciado", async () => {
    const effects = makeEffects();
    const listener = new EventListener({
      client,
      effects,
      scheduler,
    });
    listener.attach("sess-1", "task-1");
    expect(connectEvents).toHaveBeenCalledWith("sess-1");
    ws.emitOpen();
    ws.emitMessage({
      tipo: "estagio_iniciado",
      dados: { estagio: "extracao", descricao: "PDF parser" },
    });
    await flush();
    expect(effects.updateTaskProgress).toHaveBeenCalledWith("task-1", {
      estagio: "extracao",
      descricao: "PDF parser",
    });
  });

  it("dispara createApproval em aprovacao_pendente", async () => {
    const effects = makeEffects();
    const listener = new EventListener({ client, effects, scheduler });
    listener.attach("sess-2", "task-2");
    ws.emitMessage({
      tipo: "aprovacao_pendente",
      dados: {
        approval_id: "appr-1",
        titulo: "Classificar 4 lancamentos",
        dados: { lancamentos: [1, 2, 3, 4] },
      },
    });
    await flush();
    expect(effects.createApproval).toHaveBeenCalledWith("task-2", {
      approval_id: "appr-1",
      titulo: "Classificar 4 lancamentos",
      dados: { lancamentos: [1, 2, 3, 4] },
    });
  });

  it("em completado: faz upload dos artifacts e marca a task como complete", async () => {
    const effects = makeEffects();
    const listener = new EventListener({ client, effects, scheduler });
    listener.attach("sess-3", "task-3");
    ws.emitMessage({
      tipo: "completado",
      dados: {
        artifacts: [
          { nome: "balancete.pdf", conteudo: "PDFBYTES", mime: "application/pdf" },
          { nome: "razao.csv", conteudo: "csv", mime: "text/csv" },
        ],
      },
    });
    await flush();
    expect(effects.uploadWorkProduct).toHaveBeenCalledTimes(2);
    expect(effects.uploadWorkProduct).toHaveBeenNthCalledWith(1, "task-3", {
      nome: "balancete.pdf",
      conteudo: "PDFBYTES",
      mime: "application/pdf",
    });
    expect(effects.markTaskComplete).toHaveBeenCalledWith("task-3", {
      artifacts: expect.any(Array),
    });
  });

  it("em erro: faz upload do traceback e marca a task como failed", async () => {
    const effects = makeEffects();
    const listener = new EventListener({ client, effects, scheduler });
    listener.attach("sess-4", "task-4");
    ws.emitMessage({
      tipo: "erro",
      dados: { erro: "DivisionByZero", traceback: "Traceback (most recent...)" },
    });
    await flush();
    expect(effects.uploadWorkProduct).toHaveBeenCalledWith("task-4", {
      nome: "traceback.txt",
      conteudo: "Traceback (most recent...)",
      mime: "text/plain",
    });
    expect(effects.markTaskFailed).toHaveBeenCalledWith("task-4", {
      erro: "DivisionByZero",
      traceback: "Traceback (most recent...)",
    });
  });

  it("em metrica: chama recordCostEvent quando definido", async () => {
    const recordCostEvent = vi.fn().mockResolvedValue(undefined);
    const effects = makeEffects({ recordCostEvent });
    const listener = new EventListener({ client, effects, scheduler });
    listener.attach("sess-m", "task-m");
    ws.emitMessage({
      tipo: "metrica",
      dados: { provider: "openai", tokens_in: 1200, cost_usd: 0.012 },
    });
    await flush();
    expect(recordCostEvent).toHaveBeenCalledWith("task-m", {
      provider: "openai",
      tokens_in: 1200,
      cost_usd: 0.012,
    });
  });

  it("reconecta em close inesperado e reseta o contador apos open", async () => {
    const effects = makeEffects();
    const listener = new EventListener({
      client,
      effects,
      scheduler,
      reconnectBaseDelayMs: 10,
      maxReconnects: 5,
    });
    listener.attach("sess-r", "task-r");
    expect(connectEvents).toHaveBeenCalledTimes(1);

    // Simula queda inesperada -> deve agendar reconnect
    ws.emitUnexpectedClose();
    expect(scheduler.pending.filter((p) => !p.cancelled).length).toBe(1);

    // Prepara o proximo socket que sera devolvido pelo connectEvents
    const ws2 = new FakeWebSocket();
    connectEvents.mockReturnValueOnce(ws2);

    scheduler.runNext();
    expect(connectEvents).toHaveBeenCalledTimes(2);

    ws2.emitOpen();
    // Apos open, evento estagio_iniciado deve continuar funcionando
    ws2.emitMessage({
      tipo: "estagio_iniciado",
      dados: { estagio: "validacao" },
    });
    await flush();
    expect(effects.updateTaskProgress).toHaveBeenCalledWith("task-r", {
      estagio: "validacao",
    });
  });

  it("desiste de reconectar apos maxReconnects e remove a sessao", async () => {
    const effects = makeEffects();
    const listener = new EventListener({
      client,
      effects,
      scheduler,
      reconnectBaseDelayMs: 1,
      maxReconnects: 2,
    });
    listener.attach("sess-x", "task-x");

    // 1a queda -> agenda reconnect (tentativa 1)
    ws.emitUnexpectedClose();
    let next = new FakeWebSocket();
    connectEvents.mockReturnValueOnce(next);
    scheduler.runNext();
    next.emitUnexpectedClose();

    // 2a tentativa -> agenda novamente
    let next2 = new FakeWebSocket();
    connectEvents.mockReturnValueOnce(next2);
    scheduler.runNext();
    next2.emitUnexpectedClose();

    // Excedeu maxReconnects: nao deve haver novo timer pendente
    expect(scheduler.pending.filter((p) => !p.cancelled).length).toBe(0);
    expect(listener.hasSession("sess-x")).toBe(false);
  });

  it("detach cancela reconnect pendente e fecha o WS", () => {
    const effects = makeEffects();
    const listener = new EventListener({
      client,
      effects,
      scheduler,
      reconnectBaseDelayMs: 100,
    });
    listener.attach("sess-d", "task-d");
    ws.emitUnexpectedClose();
    expect(scheduler.pending.filter((p) => !p.cancelled).length).toBe(1);

    listener.detach("sess-d");
    expect(scheduler.pending.filter((p) => !p.cancelled).length).toBe(0);
    expect(listener.hasSession("sess-d")).toBe(false);
  });
});
