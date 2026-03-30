# Nations Server Platform

Projeto base para um servidor Bedrock de nações com:

- Capital central
- Arenas PvP
- Mapa de Exploração
- Nação do Fogo
- Nação da Água
- Nação da Terra
- Nação do Vento
- Economia em Draco
- Clãs
- Inventário sincronizado entre servidores
- Banco externo Postgres via Supabase
- Servidor Bedrock Linux local versionado na raiz do projeto

## Arquitetura inicial

- `addon/`: espaço reservado para scripts/addons Bedrock
- `backend/`: API TypeScript que centraliza estado, economia e sincronização
- `backend/sql/001_init.sql`: schema inicial do banco
- `docs/architecture.md`: desenho da arquitetura
- `runtime/`: dados persistidos dos containers Bedrock
- `docker-compose.yml`: sobe API e os 7 servidores Bedrock
- `docker/bedrock-local/entrypoint.sh`: injeta o `network_core`, cria config do script e aponta cada servidor para o `serverSlug` correto

## Fluxo de sincronização

1. O jogador entra em qualquer servidor Bedrock.
2. O addon/script chama `POST /internal/player-sync/join`.
3. A API devolve saldo em Draco, nação, clã e o inventário salvo.
4. Durante transferência ou logout, o addon chama `POST /internal/player-sync/inventory`.
5. Ao sair, o addon chama `POST /internal/player-sync/leave`.

## Como subir

1. Copie `.env.example` para `.env`.
2. Preencha `SUPABASE_DB_URL` com a string de conexão do seu projeto Supabase.
3. Rode a migração `backend/sql/001_init.sql` no Postgres do Supabase.
4. O pacote Linux local deve existir em `bedrock-server-1.26.10.4-linux/` na raiz.
5. Suba os containers:

```bash
docker compose up --build
```

6. Teste a API:

```bash
curl http://localhost:8080/health
```

7. O pack `addon/behavior_packs/network_core` é configurado automaticamente em cada container Bedrock.
   O `serverSlug`, o `baseUrl` da API e o `TRANSFER_HOST` são injetados via `@minecraft/server-admin` variables no bootstrap do container.

## Comandos de viagem

- `!capital`
- `!arenas`
- `!fogo`
- `!agua`
- `!terra`
- `!vento`
- `!exploracao`
- `!mapas`

## Próximos passos

- Ligar o `addon/` ao backend por HTTP ou WebSocket
- Mapear os poderes Bedrock de cada nação em scripts
- Implementar comandos de clã, banco e loja em Draco
- Criar pipeline de deploy para quando cada servidor virar uma VPS
