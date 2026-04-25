/**
 * Testes de setup-routines (T17).
 */

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  ROUTINE_CRON,
  ROUTINE_MARKER,
  ROUTINE_TITLE_TEMPLATE,
  ROUTINE_TZ,
  setupRoutines,
  isFechamentoMensalRoutine,
} from "./setup-routines.js";
import type { PaperclipAdminClient, Routine } from "./_admin-client.js";
import { COMPANY_NAME } from "./bootstrap.js";

const silent = { info: () => {}, warn: () => {} };

function makeClientStub(opts: {
  goals?: Array<{ id: string; title: string }>;
  routines?: Routine[];
  triggerCreator?: Mock;
}) {
  const created: Array<{ kind: string; payload: unknown }> = [];
  let routineCounter = 0;
  let triggerCounter = 0;

  const stub = {
    findCompanyByName: vi.fn(async (name: string) =>
      name === COMPANY_NAME ? { id: "company-1", name } : null,
    ),
    listGoals: vi.fn(async () =>
      (opts.goals ?? []).map((g) => ({
        id: g.id,
        companyId: "company-1",
        title: g.title,
      })),
    ),
    listRoutines: vi.fn(async () => opts.routines ?? []),
    createRoutine: vi.fn(async (companyId: string, body: unknown) => {
      created.push({ kind: "routine", payload: { companyId, ...(body as object) } });
      routineCounter += 1;
      return {
        id: `routine-${routineCounter}`,
        companyId,
        goalId: (body as { goalId?: string }).goalId ?? null,
        title: (body as { title: string }).title,
        description: (body as { description?: string }).description ?? null,
      };
    }),
    createRoutineTrigger:
      opts.triggerCreator ??
      vi.fn(async (routineId: string, body: unknown) => {
        created.push({ kind: "trigger", payload: { routineId, ...(body as object) } });
        triggerCounter += 1;
        return {
          id: `trigger-${triggerCounter}`,
          routineId,
          kind: "schedule" as const,
          cronExpression: (body as { cronExpression: string }).cronExpression,
          timezone: (body as { timezone?: string }).timezone ?? null,
          enabled: true,
        };
      }),
  };
  return { client: stub as unknown as PaperclipAdminClient, created, stub };
}

describe("isFechamentoMensalRoutine", () => {
  it("identifica rotina pelo titulo template", () => {
    expect(
      isFechamentoMensalRoutine({
        id: "x",
        companyId: "c",
        title: ROUTINE_TITLE_TEMPLATE,
      }),
    ).toBe(true);
  });

  it("identifica rotina pelo marker no description", () => {
    expect(
      isFechamentoMensalRoutine({
        id: "x",
        companyId: "c",
        title: "Outra coisa",
        description: `prefix ${ROUTINE_MARKER} suffix`,
      }),
    ).toBe(true);
  });

  it("ignora rotinas nao relacionadas", () => {
    expect(
      isFechamentoMensalRoutine({
        id: "x",
        companyId: "c",
        title: "Outra rotina qualquer",
      }),
    ).toBe(false);
  });
});

describe("setupRoutines", () => {
  it("cria routine + trigger schedule (cron 0 9 5 * *) por Goal sem rotina existente", async () => {
    const goals = [
      { id: "goal-1", title: "Alpha LTDA" },
      { id: "goal-2", title: "Beta SA" },
    ];
    const { client, created } = makeClientStub({ goals });

    const plan = await setupRoutines({ client, logger: silent });

    expect(plan.routines).toHaveLength(2);
    expect(plan.routines.every((r) => !r.existed)).toBe(true);

    const routinePayloads = created.filter((c) => c.kind === "routine");
    expect(routinePayloads).toHaveLength(2);
    for (const p of routinePayloads) {
      const payload = p.payload as { title: string; goalId: string; description: string };
      expect(payload.title).toBe(ROUTINE_TITLE_TEMPLATE);
      expect(payload.description).toContain(ROUTINE_MARKER);
      expect(payload.description).toContain("aguardando_arquivos");
    }

    const triggerPayloads = created.filter((c) => c.kind === "trigger");
    expect(triggerPayloads).toHaveLength(2);
    for (const t of triggerPayloads) {
      const payload = t.payload as {
        kind: string;
        cronExpression: string;
        timezone: string;
      };
      expect(payload.kind).toBe("schedule");
      expect(payload.cronExpression).toBe(ROUTINE_CRON);
      expect(payload.timezone).toBe(ROUTINE_TZ);
    }
  });

  it("e idempotente: pula Goals que ja tem routine fechamento-mensal", async () => {
    const goals = [{ id: "goal-1", title: "Alpha LTDA" }];
    const existingRoutine: Routine = {
      id: "existing-routine",
      companyId: "company-1",
      goalId: "goal-1",
      title: ROUTINE_TITLE_TEMPLATE,
    };
    const { client, created } = makeClientStub({ goals, routines: [existingRoutine] });

    const plan = await setupRoutines({ client, logger: silent });

    expect(plan.routines).toEqual([
      {
        goalId: "goal-1",
        goalTitle: "Alpha LTDA",
        existed: true,
        routineId: "existing-routine",
      },
    ]);
    expect(created).toHaveLength(0);
  });

  it("dry-run nao chama create*", async () => {
    const goals = [{ id: "goal-1", title: "Alpha LTDA" }];
    const { client, stub } = makeClientStub({ goals });
    const plan = await setupRoutines({ client, logger: silent, dryRun: true });
    expect(stub.createRoutine).not.toHaveBeenCalled();
    expect(stub.createRoutineTrigger).not.toHaveBeenCalled();
    expect(plan.routines[0]!.routineId).toBe("<dry-run>");
  });

  it("falha se Company 'Central do Contador' nao existir", async () => {
    const stub = {
      findCompanyByName: vi.fn(async () => null),
      listGoals: vi.fn(),
      listRoutines: vi.fn(),
      createRoutine: vi.fn(),
      createRoutineTrigger: vi.fn(),
    };
    await expect(
      setupRoutines({ client: stub as unknown as PaperclipAdminClient, logger: silent }),
    ).rejects.toThrow(/Central do Contador/);
  });
});
