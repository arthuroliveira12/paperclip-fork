import { defineConfig } from "vitest/config";

/**
 * Configuracao local de testes para o plugin contabil-agent.
 *
 * Definida explicitamente para evitar a heranca da configuracao raiz
 * do monorepo (que referencia projetos via paths absolutos do workspace).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
    pool: "forks",
  },
});
