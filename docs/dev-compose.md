# Dev compose: Paperclip + Contabil-Agent

Stack local de validacao que sobe o servidor Paperclip (porta 3100) com o
plugin `contabil-agent` apontando para uma instancia local da API FastAPI do
Contabil-Agent (porta 8000), usando rede interna do docker-compose.

## Pre-requisitos

- Docker Desktop (ou Docker Engine + Compose v2) instalado e rodando.
- Repositorio [`Contabil-Agent`](https://github.com/arthuroliveira12/Contabil-Agent)
  clonado como **sibling** deste fork:

  ```
  ~/code/
  |-- paperclip-fork/        # voce esta aqui
  +-- Contabil-Agent/        # default esperado
  ```

  Se o seu layout for diferente, defina:

  ```bash
  export CONTABIL_AGENT_HOST_PATH=/caminho/absoluto/Contabil-Agent
  ```

- (Opcional) arquivo `.env` no diretorio do `paperclip-fork` com chaves de LLM:

  ```env
  ANTHROPIC_API_KEY=sk-ant-...
  GEMINI_API_KEY=...
  LANGSMITH_API_KEY=...
  ```

  O `docker compose` carrega `.env` automaticamente.

## Subir o stack

```bash
docker compose up --build
```

Primeiro build pode levar alguns minutos (instala deps Python e Node).
Apos os healthchecks ficarem `healthy`:

- API Contabil-Agent: <http://localhost:8000/docs>
- Paperclip server: <http://localhost:3100/>

## Verificar

Em outro terminal:

```bash
# 1. Contabil-Agent FastAPI responde
curl -fsS http://localhost:8000/docs | head -1

# 2. Paperclip responde
curl -fsS http://localhost:3100/ | head -1

# 3. Paperclip enxerga contabil-api via DNS interno
docker compose exec paperclip curl -fsS http://contabil-api:8000/docs | head -1

# 4. Status dos healthchecks
docker compose ps
```

Os dois containers devem aparecer como `healthy` em <60s.

## Parar / resetar

```bash
# Para os containers, mantem volumes (DB persiste).
docker compose down

# Apaga TUDO incluindo SessionDB, uploads e outputs.
docker compose down -v
```

## Volumes persistidos

| Volume                | Mount no container | Conteudo                   |
| --------------------- | ------------------ | -------------------------- |
| `contabil_data`       | `/app/data`        | `contabil.db` (SessionDB)  |
| `contabil_uploads`    | `/app/uploads`     | OFX/PDFs enviados          |
| `contabil_output`     | `/app/output`      | Planilhas geradas          |
| `contabil_logs`       | `/app/logs`        | Logs do agente             |

O codigo do Contabil-Agent vem via bind-mount do host
(`${CONTABIL_AGENT_HOST_PATH:-../Contabil-Agent}` -> `/app`),
incluindo `src/empresas/` para configs de empresa.

## Limitacoes conhecidas

- Sem hot-reload do uvicorn por padrao. Apos editar codigo Python:
  `docker compose restart contabil-api`.
- O `Dockerfile.contabil-api` referencia `requirements.txt` no contexto de
  build (= repo Contabil-Agent). Adicionar dep nova exige `--build`.
- Healthcheck do Paperclip pode demorar ate 60s no primeiro start (build de
  assets + bootstrap de DB).
