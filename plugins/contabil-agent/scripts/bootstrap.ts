/**
 * T16 — Bootstrap "Central do Contador" + 1 Goal por empresa.
 *
 * Idempotente:
 *  - Cria a Company "Central do Contador" se nao existir.
 *  - Para cada empresa em $CONTABIL_AGENT_REPO/src/empresas/*.json,
 *    cria um Goal cujo `title` = `empresa.nome`.
 *  - Re-execucoes nao duplicam (lookup por nome).
 *
 * Como rodar:
 *   pnpm --filter @central-do-contador/contabil-agent bootstrap
 *   pnpm --filter @central-do-contador/contabil-agent bootstrap -- --dry-run
 *
 * Variaveis de ambiente:
 *   PAPERCLIP_BASE_URL     URL do servidor Paperclip (default http://localhost:3000)
 *   PAPERCLIP_AUTH_TOKEN   Bearer token / agent key opcional
 *   CONTABIL_AGENT_REPO    Caminho para o repo Contabil-Agent
 *                          (default detecta C:\Github\Contabil-Agent ou /opt/contabil-agent)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  PaperclipAdminClient,
  type Company,
  type Goal,
} from "./_admin-client.js";

export const COMPANY_NAME = "Central do Contador";

export interface EmpresaJson {
  empresa: {
    nome: string;
    cnpj?: string;
    regime_tributario?: string;
    tipo?: string;
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}

export interface PlannedGoal {
  empresaSlug: string;
  title: string;
  description: string;
  metadata: { cnpj?: string; regime_tributario?: string };
}

export interface BootstrapPlan {
  company: { name: string; existed: boolean; id?: string };
  goals: Array<PlannedGoal & { existed: boolean; id?: string }>;
}

export interface BootstrapOptions {
  client: PaperclipAdminClient;
  empresasDir: string;
  dryRun?: boolean;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

const consoleLogger = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
};

// ---------------------------------------------------------------------------
// Helpers puros (testaveis)
// ---------------------------------------------------------------------------

export function resolveEmpresasDir(envVar: string | undefined): string {
  if (envVar && existsSync(envVar)) return path.join(envVar, "src", "empresas");
  const candidates = ["C:\\Github\\Contabil-Agent", "/opt/contabil-agent"];
  for (const root of candidates) {
    const full = path.join(root, "src", "empresas");
    if (existsSync(full)) return full;
  }
  // fallback: deixa o erro estourar adiante
  return path.join(envVar ?? candidates[0]!, "src", "empresas");
}

export function loadEmpresas(empresasDir: string): PlannedGoal[] {
  if (!existsSync(empresasDir) || !statSync(empresasDir).isDirectory()) {
    throw new Error(`Diretorio de empresas nao encontrado: ${empresasDir}`);
  }
  const files = readdirSync(empresasDir).filter((f) => f.endsWith(".json")).sort();
  const out: PlannedGoal[] = [];
  for (const file of files) {
    const slug = file.replace(/\.json$/i, "");
    const raw = readFileSync(path.join(empresasDir, file), "utf-8");
    const parsed = JSON.parse(raw) as EmpresaJson;
    if (!parsed?.empresa?.nome) {
      throw new Error(`empresa.nome ausente em ${file}`);
    }
    const metadata = {
      cnpj: parsed.empresa.cnpj,
      regime_tributario: parsed.empresa.regime_tributario,
    };
    out.push({
      empresaSlug: slug,
      title: parsed.empresa.nome,
      description: buildGoalDescription(slug, metadata),
      metadata,
    });
  }
  return out;
}

export function buildGoalDescription(
  slug: string,
  metadata: { cnpj?: string; regime_tributario?: string },
): string {
  // createGoalSchema nao expoe `metadata`, entao serializamos no description
  // usando um marcador estavel para releitura idempotente futura.
  return JSON.stringify({
    source: "contabil-agent.bootstrap",
    empresa_slug: slug,
    cnpj: metadata.cnpj ?? null,
    regime_tributario: metadata.regime_tributario ?? null,
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapPlan> {
  const logger = opts.logger ?? consoleLogger;
  const planned = loadEmpresas(opts.empresasDir);
  logger.info(
    `[bootstrap] ${planned.length} empresa(s) encontrada(s) em ${opts.empresasDir}`,
  );

  // 1) Company
  let company: Company | null = await opts.client.findCompanyByName(COMPANY_NAME);
  const companyExisted = company !== null;
  if (!company) {
    if (opts.dryRun) {
      logger.info(`[bootstrap] (dry-run) criaria Company "${COMPANY_NAME}"`);
      company = { id: "<dry-run>", name: COMPANY_NAME };
    } else {
      logger.info(`[bootstrap] criando Company "${COMPANY_NAME}"`);
      company = await opts.client.createCompany({
        name: COMPANY_NAME,
        description: "Empresa contabil — gerada por contabil-agent bootstrap",
      });
    }
  } else {
    logger.info(`[bootstrap] Company "${COMPANY_NAME}" ja existe (id=${company.id})`);
  }

  // 2) Goals
  const existingGoals: Goal[] = companyExisted
    ? await opts.client.listGoals(company.id)
    : [];
  const existingByTitle = new Map(existingGoals.map((g) => [g.title, g]));

  const goalsResult: BootstrapPlan["goals"] = [];
  for (const planEntry of planned) {
    const existing = existingByTitle.get(planEntry.title);
    if (existing) {
      logger.info(
        `[bootstrap] Goal "${planEntry.title}" ja existe (id=${existing.id}) — skip`,
      );
      goalsResult.push({ ...planEntry, existed: true, id: existing.id });
      continue;
    }
    if (opts.dryRun) {
      logger.info(`[bootstrap] (dry-run) criaria Goal "${planEntry.title}"`);
      goalsResult.push({ ...planEntry, existed: false, id: "<dry-run>" });
      continue;
    }
    logger.info(`[bootstrap] criando Goal "${planEntry.title}"`);
    const created = await opts.client.createGoal(company.id, {
      title: planEntry.title,
      description: planEntry.description,
    });
    goalsResult.push({ ...planEntry, existed: false, id: created.id });
  }

  return {
    company: { name: COMPANY_NAME, existed: companyExisted, id: company.id },
    goals: goalsResult,
  };
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
  const empresasDir = resolveEmpresasDir(process.env.CONTABIL_AGENT_REPO);
  const client = new PaperclipAdminClient({
    baseUrl,
    authToken: process.env.PAPERCLIP_AUTH_TOKEN,
  });

  const plan = await bootstrap({ client, empresasDir, dryRun: args.dryRun });
  console.log(JSON.stringify(plan, null, 2));
}

// `tsx scripts/bootstrap.ts` -> import.meta.url === entrypoint
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error("[bootstrap] erro fatal:", err);
    process.exit(1);
  });
}
