# VPS Deploy Runbook — Paperclip + Contabil-Agent (Hostinger KVM)

Runbook completo para subir o fork Paperclip + plugin Contabil-Agent em produção
na VPS `app.centraldocontador.com`. Cobre tasks **T22-T28** do plano de migração.

> Para reverter, ver `Contabil-Agent/.specs/features/paperclip-migration/rollback.md`.

---

## 0. Pré-requisitos & assumptions

| Item | Valor assumido | Como confirmar |
|------|----------------|----------------|
| Provedor / plano | Hostinger KVM 1, 4 GB RAM | painel Hostinger |
| SO | Ubuntu 22.04 LTS | `lsb_release -a` |
| Acesso | SSH como `root` ou usuário com `sudo` | `ssh root@<vps-ip>` |
| Domínio | `app.centraldocontador.com` aponta para VPS | `dig +short app.centraldocontador.com` |
| Repo Contabil-Agent | clonado em `/opt/contabil-agent` | `ls /opt/contabil-agent/api.py` |
| Usuário Contabil | `contabil` (já existente) | `id contabil` |
| nginx + Let's Encrypt | já configurado para chat.html | `nginx -t && certbot certificates` |
| Python | 3.12 instalado | `python3.12 --version` |
| Service legacy | `ws-bridge.service` ativo | `systemctl status ws-bridge` |

> **Se algum item diverge**, ajustar paths nos comandos abaixo antes de executar.

---

## T22 — Snapshot Hostinger (manual, web panel)

Rede de segurança obrigatória. Sem snapshot válido, não execute T26.

1. Login em https://hpanel.hostinger.com
2. Menu lateral → **VPS** → escolher a instância
3. Aba **Snapshots** → botão **Create snapshot**
4. Nome sugerido: `pre-paperclip-cutover-YYYYMMDD`
5. Aguardar status `Completed` (~3-8 min)
6. Anotar **Snapshot ID** e **timestamp** em
   `Contabil-Agent/.specs/features/paperclip-migration/rollback.md` Seção 0
7. Confirmar via SSH que a VPS continua funcional após a operação:
   ```bash
   systemctl is-system-running
   curl -fsS https://app.centraldocontador.com/chat.html | head -1
   ```

---

## T23 — Provisionar Node 20+, pnpm e usuário paperclip

```bash
# Atualizar índice apt
sudo apt-get update

# Node 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # esperado: v20.x.y
npm --version     # esperado: 10.x

# pnpm 9.15 (versão usada pelo fork — ver packageManager em package.json)
sudo npm install -g pnpm@9.15.4
pnpm --version    # esperado: 9.15.4

# Dependências de build do embedded-postgres
sudo apt-get install -y build-essential python3 git curl ca-certificates

# Usuário de serviço dedicado (sem shell de login)
sudo useradd -r -s /usr/sbin/nologin -m -d /opt/paperclip paperclip
sudo mkdir -p /opt/paperclip
sudo chown -R paperclip:paperclip /opt/paperclip
id paperclip      # esperado: uid=... gid=... groups=...
```

> **Verificação:** `node --version` precisa ser ≥ 20.0.0 (engines do fork).

---

## T24 — systemd units (criar, habilitar, NÃO iniciar)

Criar dois units. Iniciar só no T26.

### `/etc/systemd/system/paperclip.service`

```ini
[Unit]
Description=Paperclip (fork central-do-contador) — chat + plugin Contabil-Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=paperclip
Group=paperclip
WorkingDirectory=/opt/paperclip
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStartSec=60

# Telemetria desabilitada (single-tenant)
Environment=PAPERCLIP_TELEMETRY_DISABLED=1
Environment=NODE_ENV=production
Environment=PORT=3100

# Auth — gerar com: openssl rand -hex 32
Environment=BETTER_AUTH_SECRET=<PLACEHOLDER_GERAR_OPENSSL_RAND_HEX_32>

# DB: deixar vazio = embedded-postgres em ~/.paperclip/instances/default/db
# Para Postgres externo, descomentar:
# Environment=DATABASE_URL=postgres://user:pass@127.0.0.1:5432/paperclip

# Plugin Contabil-Agent → fala com a API local
Environment=CONTABIL_AGENT_API_URL=http://127.0.0.1:8000

StandardOutput=journal
StandardError=journal

# Hardening básico
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/paperclip
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
```

### `/etc/systemd/system/contabil-api.service`

```ini
[Unit]
Description=Contabil-Agent FastAPI (consumido pelo plugin Paperclip)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=contabil
Group=contabil
WorkingDirectory=/opt/contabil-agent
ExecStart=/usr/bin/python3.12 -m uvicorn api:app --host 127.0.0.1 --port 8000
Restart=on-failure
RestartSec=5

Environment=PYTHONUNBUFFERED=1
Environment=CONTABIL_DB_PATH=/opt/contabil-agent/data/contabil.db

StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
# Recarregar e habilitar (start fica para T26)
sudo systemctl daemon-reload
sudo systemctl enable paperclip.service contabil-api.service

# Conferir
systemctl is-enabled paperclip.service contabil-api.service
# esperado: enabled / enabled
systemctl is-active paperclip.service contabil-api.service
# esperado: inactive / inactive
```

> **Nota:** `contabil-api` escuta apenas em `127.0.0.1` — Paperclip alcança
> diretamente via loopback, e a API nunca fica exposta na internet.

---

## T25 — nginx (preparar, NÃO recarregar)

```bash
# 1. Backup do config atual (rota chat.html via ws-bridge)
sudo cp /etc/nginx/sites-available/app.centraldocontador.com \
        /etc/nginx/sites-available/app.centraldocontador.com.legacy

# 2. Editar o sites-available — substituir o bloco location / pelo abaixo
sudo nano /etc/nginx/sites-available/app.centraldocontador.com
```

Conteúdo do server block (manter SSL/cert linhas geridas pelo certbot):

```nginx
server {
    server_name app.centraldocontador.com;
    listen 443 ssl http2;

    # SSL gerido por certbot — não editar
    ssl_certificate     /etc/letsencrypt/live/app.centraldocontador.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.centraldocontador.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;

        # WebSocket upgrade (Paperclip usa SSE + WS)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / streams longos
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

server {
    if ($host = app.centraldocontador.com) { return 301 https://$host$request_uri; }
    listen 80;
    server_name app.centraldocontador.com;
    return 404;
}
```

```bash
# 3. Validar sintaxe (NÃO recarregar — recarga é em T26 passo 11)
sudo nginx -t
# esperado: syntax is ok / test is successful
```

---

## T26 — Cutover (janela atômica, ~30 min)

Executar **sequencialmente**. Anotar timestamps em cada passo.

```bash
# 1. SSH como root e confirmar snapshot
ssh root@<vps-ip>
date -u    # registrar inicio_cutover
# Confirmar Snapshot ID anotado em rollback.md Seção 0

# 2. Clonar fork e construir (como usuário paperclip)
sudo -u paperclip git clone https://github.com/arthuroliveira12/paperclip-fork.git /opt/paperclip
cd /opt/paperclip
sudo -u paperclip git checkout feat/contabil-agent-plugin   # ou main após merge
sudo -u paperclip pnpm install --frozen-lockfile
sudo -u paperclip pnpm build
ls server/dist/index.js    # esperado: arquivo existe

# 3. Atualizar Contabil-Agent (assume PR #5 mergeado)
cd /opt/contabil-agent
sudo -u contabil git fetch origin
sudo -u contabil git checkout main
sudo -u contabil git pull --ff-only

# 4. Garantir schema SessionDB (idempotente)
sudo -u contabil python3.12 -c "from tools.database import SessionDB; SessionDB('/opt/contabil-agent/data/contabil.db')"

# 5. Backup do SessionDB ANTES de migrar histórico
TS=$(date +%Y%m%d%H%M%S)
sudo -u contabil cp /opt/contabil-agent/data/contabil.db \
                    /opt/contabil-agent/data/contabil.db.bak.$TS
echo "Backup: /opt/contabil-agent/data/contabil.db.bak.$TS"
# Anotar caminho em rollback.md Seção 0

# 6. Subir contabil-api primeiro (Paperclip precisa para bootstrap)
sudo systemctl start contabil-api.service
sleep 5
systemctl status contabil-api.service --no-pager
curl -fsS http://127.0.0.1:8000/health || echo "WARN: sem /health, verificar manualmente"

# 7. Iniciar Paperclip (gera embedded-postgres + admin token na 1a vez)
sudo systemctl start paperclip.service
sleep 15    # embedded-postgres precisa de tempo no boot inicial
systemctl status paperclip.service --no-pager
journalctl -u paperclip.service --since "1 min ago" | tail -30

# Capturar admin token criado no bootstrap
sudo -u paperclip cat /opt/paperclip/.paperclip/instances/default/admin-token 2>/dev/null \
  || journalctl -u paperclip.service | grep -i "admin token"
# Anotar como ADMIN_TOKEN

# 8. Migração DRY-RUN do histórico
sudo -u contabil python3.12 /opt/contabil-agent/scripts/migrar_historico_paperclip.py \
  --dry-run \
  --paperclip-url http://127.0.0.1:3100 \
  --paperclip-token <ADMIN_TOKEN>
# Inspecionar saída: contagem de sessões, mensagens, erros esperados.
# Se não fizer sentido, ABORTAR e ir para rollback.md Seção 3.

# 9. Migração real (sem --dry-run)
sudo -u contabil python3.12 /opt/contabil-agent/scripts/migrar_historico_paperclip.py \
  --paperclip-url http://127.0.0.1:3100 \
  --paperclip-token <ADMIN_TOKEN>

# 10. Bootstrap do plugin + cadastro de rotinas
sudo -u paperclip pnpm --dir /opt/paperclip --filter @central-do-contador/contabil-agent bootstrap
sudo -u paperclip pnpm --dir /opt/paperclip --filter @central-do-contador/contabil-agent setup-routines

# 11. Recarregar nginx (chaveia público para Paperclip)
sudo nginx -t && sudo systemctl reload nginx

# 12. Smoke tests
curl -fsS https://app.centraldocontador.com/api/health   # ou /
curl -fsSI https://app.centraldocontador.com/ | head -5  # 200 OK esperado
# Abrir no browser: https://app.centraldocontador.com/
# - Login funciona?
# - Histórico migrado aparece?
# - Iniciar conversa nova com agent contabil

# 13. Registrar fim
date -u    # registrar fim_cutover
# Atualizar Contabil-Agent/STATE.md:
#   - inicio_cutover, fim_cutover, duracao
#   - snapshot_id usado, backup_sessiondb path
#   - admin_token (em local seguro, não commitar)
```

---

## T27 — Monitorar 24-48h

Janela de observação antes de declarar sucesso.

```bash
# Logs em tempo real (Ctrl+C para sair)
sudo journalctl -u paperclip -u contabil-api -f

# Snapshot de recursos
htop
free -m
df -h /opt /var

# OOM-kills?
sudo dmesg -T | grep -i 'killed process' | tail
sudo dmesg -T | grep -i 'out of memory' | tail

# Estado do SessionDB
ls -lh /opt/contabil-agent/data/
sudo -u contabil sqlite3 /opt/contabil-agent/data/contabil.db "PRAGMA integrity_check;"
```

### Critérios de aceitação (todos têm que passar)

- [ ] 24h sem OOM kill (`dmesg | grep -i 'killed process'` vazio)
- [ ] RSS combinado (`paperclip` + `contabil-api`) < 3.2 GB
- [ ] Disco livre > 20% em `/opt`
- [ ] Zero erros críticos em `journalctl -u paperclip -u contabil-api -p err`
- [ ] **1 fechamento contábil real** processado end-to-end com sucesso
- [ ] Tempo de resposta do chat percebido como aceitável

> **Falhou algum critério?** Ir para `rollback.md` Seção 1 (decisão).

---

## T28 — Cleanup pós-estabilização (executar apenas após T27 OK)

```bash
# 1. Desativar serviço legacy
sudo systemctl stop ws-bridge.service
sudo systemctl disable ws-bridge.service
systemctl is-enabled ws-bridge.service   # esperado: disabled

# 2. nginx — remover rota /chat.html (ou redirecionar)
# Opção A: remover bloco location /chat.html do config
# Opção B: 301 para a nova UI:
#   location = /chat.html { return 301 https://$host/; }
sudo nginx -t && sudo systemctl reload nginx

# 3. Tag de rastreio
sudo -u contabil bash -c 'cd /opt/contabil-agent && git tag paperclip-cutover-$(date +%Y%m%d) && git push origin --tags'
```

### TODOs com data

Anotar em `Contabil-Agent/STATE.md` (lembrete para Arthur):

```
[ ] Em <data_cutover + 30 dias>: se não houve rollback, remover
    chat.html, ws-bridge/, scripts/migrar_historico_paperclip.py
    do repo Contabil-Agent.
[ ] Em <data_cutover + 7 dias>: deletar snapshot Hostinger pre-paperclip-cutover.
[ ] Em <data_cutover + 30 dias>: deletar backups data/contabil.db.bak.*
    além do mais recente.
```

---

## Troubleshooting

### `pnpm install` falha
- Confirmar Node ≥ 20: `node --version`
- Disco: `df -h /opt` (precisa ~2 GB livres para deps + build)
- Rede: `curl -I https://registry.npmjs.org/`
- Patches: erro em `embedded-postgres` patch? Garantir que `patches/` foi clonado.

### Embedded-postgres não inicia
- Lock antigo: `sudo -u paperclip rm -f /opt/paperclip/.paperclip/instances/default/db/postmaster.pid`
- Permissões: `sudo chown -R paperclip:paperclip /opt/paperclip/.paperclip`
- Logs: `journalctl -u paperclip.service --since "10 min ago" | grep -i postgres`
- Build essentials faltando: `sudo apt-get install -y build-essential python3`

### `paperclip.service` 502 / não responde em :3100
- `systemctl status paperclip.service`
- `journalctl -u paperclip.service -n 100 --no-pager`
- Porta ocupada? `sudo ss -tlnp | grep 3100`
- Build incompleto? `ls /opt/paperclip/server/dist/index.js`

### `contabil-api` 502 / Paperclip não alcança
- `curl -fsS http://127.0.0.1:8000/` direto na VPS
- `systemctl status contabil-api.service`
- Python path: `which python3.12` (ajustar `ExecStart` se diferente)
- Firewall local: `sudo ufw status` (loopback deve estar livre)

### SSL quebrou após reload nginx
- `sudo certbot certificates`
- Se cert OK: `sudo nginx -t` e olhar erro
- Restaurar legacy: `sudo cp /etc/nginx/sites-available/app.centraldocontador.com.legacy \
  /etc/nginx/sites-available/app.centraldocontador.com && sudo systemctl reload nginx`

### Histórico migrado não aparece na UI
- Conferir DB do Paperclip: `sudo -u paperclip ls /opt/paperclip/.paperclip/instances/default/db/`
- Reexecutar migração com flag de força (ver `scripts/migrar_historico_paperclip.py --help`)
- Em último caso: rollback parcial (rollback.md Seção 3) e investigar offline.

### Rollback
Qualquer falha grave que não resolve em 15 min → executar
`Contabil-Agent/.specs/features/paperclip-migration/rollback.md`.
