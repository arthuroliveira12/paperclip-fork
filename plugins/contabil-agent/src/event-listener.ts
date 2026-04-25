/**
 * EventListener — assina o WS `/sessoes/{id}/eventos` da api.py por sessao
 * ativa e traduz cada evento em side effects no Paperclip.
 *
 * Eventos suportados:
 *   - `estagio_iniciado`   -> updateTaskProgress
 *   - `aprovacao_pendente` -> createApproval
 *   - `completado`         -> uploadWorkProduct (artifacts) + markTaskComplete
 *   - `erro`               -> uploadWorkProduct (traceback) + markTaskFailed
 *   - `metrica`            -> recordCostEvent (T18) ou apenas log
 *
 * Reconexao: em close inesperado, faz backoff exponencial 1s/2s/4s/8s/16s
 * (max 5 tentativas). detach() cancela qualquer reconexao pendente.
 *
 * Os side effects em Paperclip nao sao expostos diretamente ao plugin worker
 * pelo SDK (ToolRunContext eh apenas {agentId,runId,companyId,projectId}),
 * portanto a integracao real eh injetada via `PaperclipSideEffects`. O worker
 * passa uma implementacao stub baseada em logger ate o SDK expor as APIs.
 *
 * Ref: T13 do plano de migracao Paperclip.
 */

import type { ContabilAgentClient, Logger } from "./http-client.js";

// ---------------------------------------------------------------------------
// Eventos do pipeline (espelham a api.py)
// ---------------------------------------------------------------------------

export type EventoTipo =
  | "estagio_iniciado"
  | "aprovacao_pendente"
  | "completado"
  | "erro"
  | "metrica";

export interface EventoBase<T = unknown> {
  tipo: EventoTipo | string;
  dados: T;
  timestamp?: string;
}

// Payloads tipados (best-effort, baseados na api.py).
export interface EstagioIniciadoDados {
  estagio: string;
  descricao?: string;
}
export interface AprovacaoPendenteDados {
  approval_id: string;
  titulo: string;
  dados: unknown;
}
export interface ArtifactDados {
  nome: string;
  conteudo: string; // base64 ou texto
  mime: string;
}
export interface CompletadoDados {
  artifacts?: ArtifactDados[];
}
export interface ErroDados {
  erro: string;
  traceback?: string;
}
export interface MetricaDados {
  /**
   * Discriminador da metrica. Apenas `llm_call` vira Cost Event no Paperclip
   * (T18). Outras metricas (latencia, contadores, etc.) sao apenas logadas.
   */
  tipo?: string;
  tokens_input?: number;
  tokens_output?: number;
  modelo?: string;
  custo_usd?: number;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Side effects no Paperclip (interface injetada — facilita teste e adia
// a wiring real ao SDK ate ele expor as APIs).
// ---------------------------------------------------------------------------

export interface PaperclipSideEffects {
  updateTaskProgress(
    taskRunId: string,
    payload: EstagioIniciadoDados,
  ): Promise<void>;
  createApproval(
    taskRunId: string,
    payload: AprovacaoPendenteDados,
  ): Promise<void>;
  uploadWorkProduct(
    taskRunId: string,
    payload: { nome: string; conteudo: Buffer | string; mime: string },
  ): Promise<void>;
  markTaskComplete(
    taskRunId: string,
    payload?: { artifacts?: ArtifactDados[] },
  ): Promise<void>;
  markTaskFailed(taskRunId: string, payload: ErroDados): Promise<void>;
  /**
   * Opcional — T18 registra o handler real de cost events.
   *
   * O 3o argumento (`context`) carrega `companyId`/`agentId` da sessao,
   * necessarios para o POST /api/companies/:companyId/cost-events do
   * Paperclip server. Quando ausente (sessao registrada sem contexto),
   * o handler pode optar por logar e ignorar.
   */
  recordCostEvent?(
    taskRunId: string,
    payload: MetricaDados,
    context?: SessionContext,
  ): Promise<void>;
}

/**
 * Contexto opcional de sessao usado por handlers que precisam saber a qual
 * Company/Agent pertencem os eventos (T18 — cost events). Os campos sao
 * passados pelo `attach()` e armazenados na `AttachedSession`.
 */
export interface SessionContext {
  companyId?: string;
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Opcoes do listener
// ---------------------------------------------------------------------------

export interface EventListenerOptions {
  client: ContabilAgentClient;
  effects: PaperclipSideEffects;
  logger?: Logger;
  /** Default 5. */
  maxReconnects?: number;
  /** Default 1000ms. Sequencia: base, base*2, base*4, base*8, base*16. */
  reconnectBaseDelayMs?: number;
  /** Hook para testes determinarem o agendador (default: setTimeout). */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface AttachedSession {
  sessaoId: string;
  taskRunId: string;
  ws: WebSocket | null;
  reconnectAttempt: number;
  reconnectHandle: unknown | null;
  /** true quando detach foi chamado — evita reconexao. */
  detaching: boolean;
  /** Opcional — usado por handlers como `recordCostEvent` (T18). */
  context?: SessionContext;
}

// ---------------------------------------------------------------------------
// EventListener
// ---------------------------------------------------------------------------

export class EventListener {
  private readonly client: ContabilAgentClient;
  private readonly effects: PaperclipSideEffects;
  private readonly logger: Logger;
  private readonly maxReconnects: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly scheduler: NonNullable<EventListenerOptions["scheduler"]>;
  private readonly sessions = new Map<string, AttachedSession>();

  constructor(opts: EventListenerOptions) {
    this.client = opts.client;
    this.effects = opts.effects;
    this.logger = opts.logger ?? noopLogger;
    this.maxReconnects = opts.maxReconnects ?? 5;
    this.reconnectBaseDelayMs = opts.reconnectBaseDelayMs ?? 1_000;
    this.scheduler = opts.scheduler ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  /**
   * Abre o WS para a sessao e mantem aberto (com reconnect) ate detach.
   *
   * @param context T18 — opcional; quando informado, eventos `metrica` do
   *   tipo `llm_call` chamam `recordCostEvent` com este contexto, permitindo
   *   ao handler postar /api/companies/:companyId/cost-events.
   */
  attach(
    sessaoId: string,
    taskRunId: string,
    context?: SessionContext,
  ): void {
    if (this.sessions.has(sessaoId)) {
      this.logger.warn(
        `[contabil-agent] attach ignorado: sessao ${sessaoId} ja conectada`,
      );
      return;
    }
    const state: AttachedSession = {
      sessaoId,
      taskRunId,
      ws: null,
      reconnectAttempt: 0,
      reconnectHandle: null,
      detaching: false,
      context,
    };
    this.sessions.set(sessaoId, state);
    this.openSocket(state);
  }

  /** Fecha o WS da sessao e cancela qualquer reconexao pendente. */
  detach(sessaoId: string): void {
    const state = this.sessions.get(sessaoId);
    if (!state) return;
    state.detaching = true;
    if (state.reconnectHandle !== null) {
      this.scheduler.clearTimeout(state.reconnectHandle);
      state.reconnectHandle = null;
    }
    if (state.ws) {
      try {
        state.ws.close();
      } catch (err) {
        this.logger.warn(
          `[contabil-agent] erro ao fechar WS ${sessaoId}: ${String(err)}`,
        );
      }
    }
    this.sessions.delete(sessaoId);
  }

  /** Encerra todas as sessoes ativas (util no shutdown do worker). */
  detachAll(): void {
    for (const sessaoId of Array.from(this.sessions.keys())) {
      this.detach(sessaoId);
    }
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private openSocket(state: AttachedSession): void {
    let ws: WebSocket;
    try {
      ws = this.client.connectEvents(state.sessaoId);
    } catch (err) {
      this.logger.error(
        `[contabil-agent] connectEvents falhou para ${state.sessaoId}: ${String(err)}`,
      );
      this.scheduleReconnect(state);
      return;
    }
    state.ws = ws;

    ws.addEventListener("open", () => {
      this.logger.info(
        `[contabil-agent] WS aberto sessao=${state.sessaoId} task=${state.taskRunId}`,
      );
      // Reset do contador apos open bem-sucedido.
      state.reconnectAttempt = 0;
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      this.handleMessage(state, ev).catch((err) => {
        this.logger.error(
          `[contabil-agent] erro ao processar mensagem WS ${state.sessaoId}: ${String(err)}`,
        );
      });
    });

    ws.addEventListener("error", (ev) => {
      this.logger.warn(
        `[contabil-agent] WS error sessao=${state.sessaoId}: ${String((ev as ErrorEvent)?.message ?? ev)}`,
      );
    });

    ws.addEventListener("close", (ev) => {
      this.handleClose(state, ev as CloseEvent);
    });
  }

  private async handleMessage(
    state: AttachedSession,
    ev: MessageEvent,
  ): Promise<void> {
    let parsed: EventoBase;
    try {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      parsed = JSON.parse(raw) as EventoBase;
    } catch (err) {
      this.logger.warn(
        `[contabil-agent] payload WS invalido sessao=${state.sessaoId}: ${String(err)}`,
      );
      return;
    }

    const { tipo, dados } = parsed;
    const taskId = state.taskRunId;
    switch (tipo) {
      case "estagio_iniciado":
        await this.effects.updateTaskProgress(
          taskId,
          dados as EstagioIniciadoDados,
        );
        return;
      case "aprovacao_pendente":
        await this.effects.createApproval(
          taskId,
          dados as AprovacaoPendenteDados,
        );
        return;
      case "completado": {
        const d = (dados ?? {}) as CompletadoDados;
        if (d.artifacts && d.artifacts.length > 0) {
          for (const art of d.artifacts) {
            await this.effects.uploadWorkProduct(taskId, {
              nome: art.nome,
              conteudo: art.conteudo,
              mime: art.mime,
            });
          }
        }
        await this.effects.markTaskComplete(taskId, { artifacts: d.artifacts });
        return;
      }
      case "erro": {
        const d = (dados ?? { erro: "erro desconhecido" }) as ErroDados;
        if (d.traceback) {
          await this.effects.uploadWorkProduct(taskId, {
            nome: "traceback.txt",
            conteudo: d.traceback,
            mime: "text/plain",
          });
        }
        await this.effects.markTaskFailed(taskId, d);
        return;
      }
      case "metrica": {
        // T18: filtra por dados.tipo === 'llm_call'. Outras metricas sao
        // apenas logadas (latencia, contadores etc.) — nao geram Cost Event.
        const m = (dados ?? {}) as MetricaDados;
        if (m.tipo !== "llm_call") {
          this.logger.debug(
            `[contabil-agent] metrica nao-llm_call sessao=${state.sessaoId} tipo=${String(m.tipo ?? "<sem tipo>")}`,
          );
          return;
        }
        if (this.effects.recordCostEvent) {
          await this.effects.recordCostEvent(taskId, m, state.context);
        } else {
          this.logger.debug(
            `[contabil-agent] metrica llm_call recebida sessao=${state.sessaoId} (sem handler injetado)`,
          );
        }
        return;
      }
      default:
        this.logger.debug(
          `[contabil-agent] evento desconhecido tipo=${tipo} sessao=${state.sessaoId}`,
        );
    }
  }

  private handleClose(state: AttachedSession, ev: CloseEvent): void {
    state.ws = null;
    if (state.detaching) {
      this.logger.info(
        `[contabil-agent] WS fechado (detach) sessao=${state.sessaoId}`,
      );
      return;
    }
    if (ev?.wasClean) {
      this.logger.info(
        `[contabil-agent] WS fechado limpo sessao=${state.sessaoId}; sem reconnect`,
      );
      this.sessions.delete(state.sessaoId);
      return;
    }
    this.logger.warn(
      `[contabil-agent] WS fechado inesperado sessao=${state.sessaoId} code=${ev?.code}; reconnect`,
    );
    this.scheduleReconnect(state);
  }

  private scheduleReconnect(state: AttachedSession): void {
    if (state.detaching) return;
    if (state.reconnectAttempt >= this.maxReconnects) {
      this.logger.error(
        `[contabil-agent] desistindo de reconectar sessao=${state.sessaoId} apos ${this.maxReconnects} tentativas`,
      );
      this.sessions.delete(state.sessaoId);
      return;
    }
    const delay =
      this.reconnectBaseDelayMs * Math.pow(2, state.reconnectAttempt);
    state.reconnectAttempt += 1;
    this.logger.info(
      `[contabil-agent] reconnect sessao=${state.sessaoId} tentativa=${state.reconnectAttempt}/${this.maxReconnects} em ${delay}ms`,
    );
    state.reconnectHandle = this.scheduler.setTimeout(() => {
      state.reconnectHandle = null;
      if (state.detaching) return;
      this.openSocket(state);
    }, delay);
  }

  /** Util para testes / introspeccao. */
  hasSession(sessaoId: string): boolean {
    return this.sessions.has(sessaoId);
  }
}
