/**
 * Testes de bootstrap (T16).
 *
 * Estrategia: mocamos o PaperclipAdminClient (DI via opcoes) e gravamos
 * fixtures de empresas em diretorio temporario. Sem fetch real, sem
 * filesystem do repo Contabil-Agent.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrap, COMPANY_NAME, loadEmpresas } from "./bootstrap.js";
import type { PaperclipAdminClient } from "./_admin-client.js";

function makeClientStub(opts: {
  existingCompany?: { id: string; name: string };
  existingGoalTitles?: string[];
}) {
  const created: Array<{ kind: string; payload: unknown }> = [];
  let goalCounter = 0;
  const stub = {
    findCompanyByName: vi.fn(async (name: string) => {
      if (opts.existingCompany && opts.existingCompany.name === name) {
        return opts.existingCompany;
      }
      return null;
    }),
    createCompany: vi.fn(async (body: unknown) => {
      created.push({ kind: "company", payload: body });
      return { id: "new-company-id", name: (body as { name: string }).name };
    }),
    listGoals: vi.fn(async () => {
      return (opts.existingGoalTitles ?? []).map((t, i) => ({
        id: `existing-goal-${i}`,
        companyId: opts.existingCompany?.id ?? "new-company-id",
        title: t,
      }));
    }),
    createGoal: vi.fn(async (companyId: string, body: unknown) => {
      created.push({ kind: "goal", payload: { companyId, ...(body as object) } });
      goalCounter += 1;
      return {
        id: `new-goal-${goalCounter}`,
        companyId,
        title: (body as { title: string }).title,
      };
    }),
  };
  return { client: stub as unknown as PaperclipAdminClient, created, stub };
}

function setupFixtures(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "contabil-bootstrap-"));
  const empresasDir = path.join(root, "src", "empresas");
  mkdirSync(empresasDir, { recursive: true });
  writeFileSync(
    path.join(empresasDir, "alpha.json"),
    JSON.stringify({
      empresa: { nome: "Alpha LTDA", cnpj: "11.111.111/0001-11", regime_tributario: "simples" },
    }),
  );
  writeFileSync(
    path.join(empresasDir, "beta.json"),
    JSON.stringify({
      empresa: { nome: "Beta SA", cnpj: "22.222.222/0001-22", regime_tributario: "lucro_real" },
    }),
  );
  return {
    dir: empresasDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("loadEmpresas", () => {
  let fx: ReturnType<typeof setupFixtures>;
  beforeEach(() => { fx = setupFixtures(); });
  afterEach(() => fx.cleanup());

  it("le e mapeia cada JSON para PlannedGoal", () => {
    const planned = loadEmpresas(fx.dir);
    expect(planned).toHaveLength(2);
    expect(planned[0]!.title).toBe("Alpha LTDA");
    expect(planned[0]!.metadata.cnpj).toBe("11.111.111/0001-11");
    expect(planned[1]!.title).toBe("Beta SA");
  });

  it("falha com mensagem clara se empresa.nome estiver ausente", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bad-"));
    const dir = path.join(root, "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "broken.json"), JSON.stringify({ empresa: {} }));
    expect(() => loadEmpresas(dir)).toThrow(/empresa\.nome/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("bootstrap", () => {
  let fx: ReturnType<typeof setupFixtures>;
  beforeEach(() => { fx = setupFixtures(); });
  afterEach(() => fx.cleanup());

  const silent = { info: () => {}, warn: () => {} };

  it("cria Company + 2 Goals em ambiente vazio", async () => {
    const { client, created } = makeClientStub({});
    const plan = await bootstrap({ client, empresasDir: fx.dir, logger: silent });

    expect(plan.company).toEqual({ name: COMPANY_NAME, existed: false, id: "new-company-id" });
    expect(plan.goals.map((g) => g.title)).toEqual(["Alpha LTDA", "Beta SA"]);
    expect(plan.goals.every((g) => !g.existed)).toBe(true);
    expect(created.filter((c) => c.kind === "company")).toHaveLength(1);
    expect(created.filter((c) => c.kind === "goal")).toHaveLength(2);
  });

  it("e idempotente: nao recria Company nem Goals existentes", async () => {
    const { client, created } = makeClientStub({
      existingCompany: { id: "co-1", name: COMPANY_NAME },
      existingGoalTitles: ["Alpha LTDA", "Beta SA"],
    });
    const plan = await bootstrap({ client, empresasDir: fx.dir, logger: silent });

    expect(plan.company.existed).toBe(true);
    expect(plan.goals.every((g) => g.existed)).toBe(true);
    expect(created).toHaveLength(0);
  });

  it("dry-run nao chama createCompany/createGoal", async () => {
    const { client, stub } = makeClientStub({});
    const plan = await bootstrap({
      client,
      empresasDir: fx.dir,
      dryRun: true,
      logger: silent,
    });
    expect(stub.createCompany).not.toHaveBeenCalled();
    expect(stub.createGoal).not.toHaveBeenCalled();
    expect(plan.goals).toHaveLength(2);
    expect(plan.goals.every((g) => g.id === "<dry-run>")).toBe(true);
  });
});
