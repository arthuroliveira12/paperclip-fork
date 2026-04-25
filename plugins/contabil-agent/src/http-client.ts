/**
 * Cliente HTTP para o backend Contabil-Agent (api.py).
 *
 * Cobre os endpoints contratuais expostos pelo backend Python:
 *  - POST   /processar
 *  - PATCH  /sessoes/{id}
 *  - POST   /sessoes/{id}/aprovar
 *  - GET    /sessoes/{id}/status
 *  - WS     /sessoes/{id}/eventos
 *
 * Utiliza globals do Node 22+ (`fetch`, `AbortController`, `WebSocket`),
 * sem dependencias adicionais. Implementa timeout por requisicao e
 * politica de retry com backoff exponencial em 5xx + erros de rede.
 *
 * Ref: T9 do plano de migracao Paperclip.
 */

/** Logger minimo aceito pelo cliente (compativel com `ctx.logger` do plugin SDK). */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Tipos de payload espelhando api.py
// ---------------------------------------------------------------------------

/** Payload de criacao de sessao via /processar (versao JSON-thin para T9). */
export interface CreateSessionInput {
  empresa: string;
  periodo: string;
  modo?: string;
}

/** Resposta minima de criacao de sessao. */
export interface CreateSessionResponse {
  sessao_id: string;
  [extra: string]: unknown;
}

/** Body do PATCH /sessoes/{id}. */
export interface PatchSessionBody {
  paperclip_task_id: string;
}

/** Decisao de classificacao (REQ-PM-03). */
export interface Decisao {
  debito: number;
  credito: number;
  categoria: string;
}

/** Body do POST /sessoes/{id}/aprovar. */
export interface ApproveSessionBody {
  approval_id: string;
  decisao: Decisao;
}

/** Resposta do POST /sessoes/{id}/aprovar. */
export interface ApproveSessionResponse {
  ok: boolean;
  contexto_id: number;
}

/** Custos LLM agregados retornados em /sessoes/{id}/status. */
export interface CustosLlm {
  tokens_input: number;
  tokens_output: number;
  usd: number;
}

/** Payload retornado por /sessoes/{id}/status. */
export interface StatusResponse {
  status: string;
  estagio_atual: string | null;
  custos_llm: CustosLlm;
  aprovacoes_pendentes: unknown[];
  [extra: string]: unknown;
}

/** Sessao completa retornada por GET/PATCH em /sessoes/{id}. */
export interface Sessao {
  sessao_id: string;
  empresa?: string;
  periodo?: string;
  status?: string;
  paperclip_task_id?: string | null;
  [extra: string]: unknown;
}

/** Evento emitido pelo websocket /sessoes/{id}/eventos. */
export interface Evento {
  tipo: string;
  dados: unknown;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Erro de transporte tipado
// ---------------------------------------------------------------------------

export class HttpClientError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;
  readonly method: string;

  constructor(opts: {
    status: number;
    body: string;
    url: string;
    method: string;
    message?: string;
  }) {
    super(
      opts.message ??
        `Contabil-Agent ${opts.method} ${opts.url} respondeu ${opts.status}: ${opts.body.slice(0, 200)}`,
    );
    this.name = "HttpClientError";
    this.status = opts.status;
    this.body = opts.body;
    this.url = opts.url;
    this.method = opts.method;
  }
}

// ---------------------------------------------------------------------------
// Opcoes do cliente
// ---------------------------------------------------------------------------

export interface ContabilAgentClientOptions {
  /** URL base do backend (default: http://localhost:8000). */
  baseUrl?: string;
  /** Timeout por requisicao em ms (default: 30000). */
  timeoutMs?: number;
  /** Numero maximo de tentativas para erros transientes (default: 3). */
  maxRetries?: number;
  /** Atraso base do backoff exponencial em ms (default: 1000). */
  baseDelayMs?: number;
  /** Logger opcional; default e silencioso. */
  logger?: Logger;
}

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** Quando true, encoda body como multipart/form-data ao inves de JSON. */
  multipart?: boolean;
}

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export class ContabilAgentClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly logger: Logger;

  constructor(opts: ContabilAgentClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.logger = opts.logger ?? noopLogger;
  }

  // -------------------------------------------------------------------------
  // Endpoints publicos
  // -------------------------------------------------------------------------

  /**
   * POST /processar — cria uma nova sessao.
   *
   * Nota T9: api.py atual aceita apenas multipart com arquivos. Este wrapper
   * envia empresa/periodo/modo como Form fields (sem arquivos). A integracao
   * completa com upload de arquivos sera feita em T10 (processar_fechamento).
   */
  async createSession(input: CreateSessionInput): Promise<CreateSessionResponse> {
    const form = new FormData();
    form.set("empresa", input.empresa);
    form.set("periodo", input.periodo);
    if (input.modo) form.set("modo", input.modo);

    return this.request<CreateSessionResponse>({
      method: "POST",
      path: "/processar",
      body: form,
      multipart: true,
    });
  }

  /** PATCH /sessoes/{id} — atualiza paperclip_task_id. */
  async patchSession(sessaoId: string, body: PatchSessionBody): Promise<Sessao> {
    return this.request<Sessao>({
      method: "PATCH",
      path: `/sessoes/${encodeURIComponent(sessaoId)}`,
      body,
    });
  }

  /** POST /sessoes/{id}/aprovar — persiste decisao de classificacao. */
  async approveSession(
    sessaoId: string,
    body: ApproveSessionBody,
  ): Promise<ApproveSessionResponse> {
    return this.request<ApproveSessionResponse>({
      method: "POST",
      path: `/sessoes/${encodeURIComponent(sessaoId)}/aprovar`,
      body,
    });
  }

  /** GET /sessoes/{id}/status — snapshot de progresso e custos. */
  async getStatus(sessaoId: string): Promise<StatusResponse> {
    return this.request<StatusResponse>({
      method: "GET",
      path: `/sessoes/${encodeURIComponent(sessaoId)}/status`,
    });
  }

  /**
   * Conecta ao stream de eventos via WebSocket.
   *
   * Usa o `WebSocket` global (Node 22+). O caller e responsavel por
   * registrar handlers (`onmessage`, `onerror`, `onclose`) e fechar
   * a conexao ao terminar.
   */
  connectEvents(sessaoId: string): WebSocket {
    const wsUrl =
      this.baseUrl.replace(/^http/, "ws") +
      `/sessoes/${encodeURIComponent(sessaoId)}/eventos`;
    this.logger.debug(`[contabil-agent] WS connect ${wsUrl}`);
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) {
      throw new Error(
        "WebSocket global nao disponivel (Node >= 22 necessario ou polyfill).",
      );
    }
    return new WS(wsUrl);
  }

  // -------------------------------------------------------------------------
  // Internos: request + retry + timeout
  // -------------------------------------------------------------------------

  private async request<T>(opts: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${opts.path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.singleAttempt(url, opts);
        if (response.ok) {
          return await this.parseJson<T>(response);
        }

        const bodyText = await this.safeReadText(response);
        // 4xx -> erro do cliente, NAO retentar
        if (response.status >= 400 && response.status < 500) {
          throw new HttpClientError({
            status: response.status,
            body: bodyText,
            url,
            method: opts.method,
          });
        }
        // 5xx -> retentar
        lastError = new HttpClientError({
          status: response.status,
          body: bodyText,
          url,
          method: opts.method,
        });
      } catch (err) {
        // 4xx ja propagou via throw acima
        if (err instanceof HttpClientError && err.status < 500) {
          throw err;
        }
        lastError = err;
      }

      if (attempt < this.maxRetries) {
        const delay = this.baseDelayMs * 2 ** attempt;
        this.logger.warn(
          `[contabil-agent] ${opts.method} ${opts.path} falhou (tentativa ${attempt + 1}/${this.maxRetries + 1}); retry em ${delay}ms`,
        );
        await sleep(delay);
      }
    }

    throw lastError ?? new Error("Falha desconhecida em ContabilAgentClient.request");
  }

  private async singleAttempt(url: string, opts: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method: opts.method,
        signal: controller.signal,
      };
      if (opts.body !== undefined) {
        if (opts.multipart) {
          init.body = opts.body as BodyInit;
        } else {
          init.body = JSON.stringify(opts.body);
          init.headers = { "Content-Type": "application/json" };
        }
      }
      return await fetch(url, init);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `Resposta nao-JSON do Contabil-Agent (status ${response.status}): ${text.slice(0, 200)}`,
      );
    }
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
