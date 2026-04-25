import { defineConfig } from "vitest/config";

/**
 * Configuracao local de testes para o plugin contabil-agent.
 *
 * Definida explicitamente para evitar a heranca da configuracao raiz
 * do monorepo (que referencia projetos via paths absolutos do workspace).
 *
 * - Tests `*.test.ts` rodam em ambiente Node (handlers de tools, http client, listener WS).
 * - Tests `*.test.tsx` (componentes React UI — T14/T15) rodam em jsdom para
 *   suportar React Testing Library. `environmentMatchGlobs` aplica o ambiente
 *   por padrao de arquivo, preservando o setup Node existente.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    environmentMatchGlobs: [["src/**/*.test.tsx", "jsdom"]],
    globals: false,
    pool: "forks",
  },
});
