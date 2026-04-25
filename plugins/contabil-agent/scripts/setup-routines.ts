/**
 * T17 — Setup das rotinas mensais "fechamento-mensal" por Goal.
 *
 * Para cada Goal criado por T16 dentro da Company "Central do Contador",
 * garante uma Routine `fechamento-mensal` (titulo) com trigger de schedule
 * cron `0 9 5 * *` (dia 5 de cada mes, 09:00 America/Sao_Paulo).
 *
 * O Paperclip server cria automaticamente uma Issue (Task) quando o
 * trigger dispara, herdando o titulo da routine. Para satisfazer o
 * requisito "Task `Fechamento {empresa} {MM/AAAA}` com status
 * `aguardando_arquivos`", o titulo da routine usa o template
 * `Fechamento {empresa} {MM/AAAA}` (placeholders sao substituidos no
 * dispatch pelo server — ver server/src/services/routines.ts).
 *
 * Idempotente: se uma routine com `title === ROUTINE_TITLE_TEMPLATE` (ou
 * cujo description contem o marker `contabil-agent.fechamento-mensal`)
 * ja existe para o Goal, pulamos.
 *
 * Como rodar:
 *   pnpm --filter @central-do-contador/contabil-agent setup-routines
 *   pnpm --filter @central-do-contador/contabil-agent setup-routines -- --dry-run
 */

import {
  PaperclipAdminClient,
  type Goal,
  type Routine,
} from "./_admin-client.js";
import { COMPANY_NAME, resolveEmpresasDir, loadEmpresas } from "./bootstrap.js";

export const ROUTINE_TITLE_TEMPLATE = "Fechamento {empresa} {MM/AAAA}";
export const ROUTINE_MARKER = "contabil-agent.fechamento-mensal";
export const ROUTINE_CRON = "0 9 5 * *";
export const ROUTINE_TZ = "America/Sao_Paulo";

export interface RoutinePlanEntry {
  goalId: string;
  goalTitle: string;
  existed: boolean;
  routineId?: string;
  triggerId?: string;
}

export interface SetupRoutinesPlan {
  companyId: string;
  routines: RoutinePlanEntry[];
}

export interface SetupRoutinesOptions {
  client: PaperclipAdminClient;
  /** Restringe a Goals cujos titulos batem com a lista (default: todos os Goals da Company). */
  goalTitleAllowlist?: string[];
  dryRun?: boolean;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

const consoleLogger = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
};

export function buildRoutineDescription(goalTitle: string): string {
  return JSON.stringify({
    marker: ROUTINE_MARKER,
    goal_title: goalTitle,
    initial_status: "aguardando_arquivos",
    cron: ROUTINE_CRON,
    timezone: ROUTINE_TZ,
  });
}

export function isFechamentoMensalRoutine(routine: Routine): boolean {
  if (routine.title === ROUTINE_TITLE_TEMPLATE) return true;
  if (typeof routine.description === "string" && routine.description.includes(ROUTINE_MARKER)) {
    return true;
  }
  return false;
}

export async function setupRoutines(
  opts: SetupRoutinesOptions,
): Promise<SetupRoutinesPlan> {
  const logger = opts.logger ?? consoleLogger;

  const company = await opts.client.findCompanyByName(COMPANY_NAME);
  if (!company) {
    throw new Error(
      `Company "${COMPANY_NAME}" nao encontrada. Rode 'bootstrap' antes de 'setup-routines'.`,
    );
  }

  const goals = await opts.client.listGoals(company.id);
  const allowedGoals = opts.goalTitleAllowlist
    ? goals.filter((g) => opts.goalTitleAllowlist!.includes(g.title))
    : goals;
  const existingRoutines = await opts.client.listRoutines(company.id);

  const result: RoutinePlanEntry[] = [];
  for (const goal of allowedGoals) {
    const existing = findRoutineForGoal(existingRoutines, goal);
    if (existing) {
      logger.info(
        `[setup-routines] Goal "${goal.title}" ja tem routine fechamento-mensal (id=${existing.id}) — skip`,
      );
      result.push({
        goalId: goal.id,
        goalTitle: goal.title,
        existed: true,
        routineId: existing.id,
      });
      continue;
    }

    if (opts.dryRun) {
      logger.info(
        `[setup-routines] (dry-run) criaria routine fechamento-mensal para Goal "${goal.title}"`,
      );
      result.push({
        goalId: goal.id,
        goalTitle: goal.title,
        existed: false,
        routineId: "<dry-run>",
        triggerId: "<dry-run>",
      });
      continue;
    }

    logger.info(`[setup-routines] criando routine fechamento-mensal para Goal "${goal.title}"`);
    const routine = await opts.client.createRoutine(company.id, {
      title: ROUTINE_TITLE_TEMPLATE,
      description: buildRoutineDescription(goal.title),
      goalId: goal.id,
    });
    const trigger = await opts.client.createRoutineTrigger(routine.id, {
      kind: "schedule",
      cronExpression: ROUTINE_CRON,
      timezone: ROUTINE_TZ,
      label: "fechamento-mensal-dia-5",
      enabled: true,
    });
    result.push({
      goalId: goal.id,
      goalTitle: goal.title,
      existed: false,
      routineId: routine.id,
      triggerId: trigger.id,
    });
  }

  return { companyId: company.id, routines: result };
}

function findRoutineForGoal(routines: Routine[], goal: Goal): Routine | undefined {
  return routines.find(
    (r) => r.goalId === goal.id && isFechamentoMensalRoutine(r),
  );
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.PAPERCLIP_BASE_URL ?? "http://localhost:3000";
  const client = new PaperclipAdminClient({
    baseUrl,
    authToken: process.env.PAPERCLIP_AUTH_TOKEN,
  });

  // Restringe ao allowlist baseado nas empresas conhecidas no repo, garantindo
  // que outras Goals da Company nao sejam alvos acidentais.
  let allowlist: string[] | undefined;
  try {
    const empresasDir = resolveEmpresasDir(process.env.CONTABIL_AGENT_REPO);
    allowlist = loadEmpresas(empresasDir).map((e) => e.title);
  } catch {
    // sem repo disponivel -> aplica em todos os Goals
    allowlist = undefined;
  }

  const plan = await setupRoutines({
    client,
    goalTitleAllowlist: allowlist,
    dryRun: args.dryRun,
  });
  console.log(JSON.stringify(plan, null, 2));
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error("[setup-routines] erro fatal:", err);
    process.exit(1);
  });
}
