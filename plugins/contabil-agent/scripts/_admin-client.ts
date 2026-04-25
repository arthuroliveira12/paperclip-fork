/**
 * PaperclipAdminClient — cliente HTTP para os scripts de bootstrap (T16/T17).
 *
 * Diferente do `ContabilAgentClient` (que fala com api.py em src/), este cliente
 * fala com o servidor Paperclip (server/src/routes/*) para criar/listar
 * Companies, Goals, Routines, Triggers e Issues.
 *
 * Por que existir:
 *  - Os scripts (`bootstrap.ts`, `setup-routines.ts`) rodam STANDALONE via tsx,
 *    fora do contexto worker do plugin SDK. Eles precisam falar HTTP direto
 *    com o servidor Paperclip.
 *
 * TODO(api-contract): os shapes de retorno (Company/Goal/Routine) seguem o
 * que o servidor responde hoje (`res.status(201).json(created)` em
 * server/src/routes/{companies,goals,routines}.ts). Caso o servidor mude o
 * formato, os tipos abaixo precisam acompanhar — testes mocam o cliente
 * e nao detectam drift de contrato.
 */

export interface PaperclipAdminClientOptions {
  /** URL base do servidor Paperclip (ex.: http://localhost:3000). */
  baseUrl: string;
  /** Token de auth (Bearer) ou agent key. Opcional para dev local sem auth. */
  authToken?: string;
  /** Implementacao de fetch injetavel (DI para testes). */
  fetchFn?: typeof fetch;
  /** Prefixo da API. Default: "/api". */
  apiPrefix?: string;
}

export interface Company {
  id: string;
  name: string;
  description?: string | null;
  [extra: string]: unknown;
}

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description?: string | null;
  level?: string;
  [extra: string]: unknown;
}

export interface Routine {
  id: string;
  companyId: string;
  goalId?: string | null;
  title: string;
  description?: string | null;
  status?: string;
  [extra: string]: unknown;
}

export interface RoutineTrigger {
  id: string;
  routineId: string;
  kind: "schedule" | "webhook" | "api";
  cronExpression?: string | null;
  timezone?: string | null;
  enabled?: boolean;
  [extra: string]: unknown;
}

export interface CreateCompanyBody {
  name: string;
  description?: string | null;
}

export interface CreateGoalBody {
  title: string;
  description?: string | null;
}

export interface CreateRoutineBody {
  title: string;
  description?: string | null;
  goalId?: string | null;
  assigneeAgentId?: string | null;
}

export interface CreateScheduleTriggerBody {
  kind: "schedule";
  cronExpression: string;
  timezone?: string;
  label?: string | null;
  enabled?: boolean;
}

export class PaperclipAdminError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
    public readonly method: string,
  ) {
    super(message);
    this.name = "PaperclipAdminError";
  }
}

export class PaperclipAdminClient {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly apiPrefix: string;

  constructor(opts: PaperclipAdminClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.authToken = opts.authToken;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.apiPrefix = opts.apiPrefix ?? "/api";
  }

  // -------------------------------------------------------------------------
  // Companies
  // -------------------------------------------------------------------------

  async listCompanies(): Promise<Company[]> {
    return this.request<Company[]>("GET", "/companies");
  }

  async findCompanyByName(name: string): Promise<Company | null> {
    const all = await this.listCompanies();
    return all.find((c) => c.name === name) ?? null;
  }

  async createCompany(body: CreateCompanyBody): Promise<Company> {
    return this.request<Company>("POST", "/companies", body);
  }

  // -------------------------------------------------------------------------
  // Goals
  // -------------------------------------------------------------------------

  async listGoals(companyId: string): Promise<Goal[]> {
    return this.request<Goal[]>("GET", `/companies/${encodeURIComponent(companyId)}/goals`);
  }

  async createGoal(companyId: string, body: CreateGoalBody): Promise<Goal> {
    return this.request<Goal>("POST", `/companies/${encodeURIComponent(companyId)}/goals`, body);
  }

  // -------------------------------------------------------------------------
  // Routines
  // -------------------------------------------------------------------------

  async listRoutines(companyId: string): Promise<Routine[]> {
    return this.request<Routine[]>(
      "GET",
      `/companies/${encodeURIComponent(companyId)}/routines`,
    );
  }

  async createRoutine(companyId: string, body: CreateRoutineBody): Promise<Routine> {
    return this.request<Routine>(
      "POST",
      `/companies/${encodeURIComponent(companyId)}/routines`,
      body,
    );
  }

  async createRoutineTrigger(
    routineId: string,
    body: CreateScheduleTriggerBody,
  ): Promise<RoutineTrigger> {
    const result = await this.request<RoutineTrigger | { trigger: RoutineTrigger }>(
      "POST",
      `/routines/${encodeURIComponent(routineId)}/triggers`,
      body,
    );
    // routineRoutes pode devolver { trigger, secret } (kind=webhook) ou direto.
    if (result && typeof result === "object" && "trigger" in result) {
      return (result as { trigger: RoutineTrigger }).trigger;
    }
    return result as RoutineTrigger;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${this.apiPrefix}${path}`;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    const response = await this.fetchFn(url, init);
    if (!response.ok) {
      const text = await safeText(response);
      throw new PaperclipAdminError(
        `Paperclip admin API ${method} ${path} -> ${response.status}`,
        response.status,
        text,
        url,
        method,
      );
    }
    const text = await response.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
