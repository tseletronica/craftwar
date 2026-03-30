# Arquitetura do servidor de nações

## Topologia atual

- `capital`: hub principal, comercio, banco, NPCs e teleporte
- `arenas`: PvP, eventos e torneios
- `exploration`: mapa aberto de exploração
- `fire`: nação do fogo
- `water`: nação da água
- `earth`: nação da terra
- `air`: nação do vento
- `api`: backend central para persistência
- `supabase`: Postgres externo compartilhado por todos os servidores

## Separação por responsabilidade

### Bedrock containers

Cada container Bedrock cuida de:

- gameplay local
- regras daquele mapa
- scripts de habilidade
- envio de dados para a API

### Backend central

A API cuida de:

- cadastro de jogador por `xuid`
- presença online por servidor
- saldo em Draco
- contas de jogador, clã, nação e sistema
- transações financeiras
- inventário global e histórico de sincronização
- leitura de nações, habilidades e clãs

## Escalabilidade

Hoje:

- todos os servidores rodam no mesmo `docker-compose`
- todos compartilham o mesmo Postgres do Supabase

Amanhã:

- cada servidor Bedrock pode virar uma VPS separada
- a API pode continuar em container proprio
- o banco continua central no Supabase

Essa troca fica simples porque o estado persistente não fica preso ao container do jogo.

## Fluxo de inventário global

1. O jogador entra em um servidor.
2. O script consulta a API usando o `xuid`.
3. A API responde com o snapshot mais recente do inventário.
4. O script aplica o inventário no mundo atual.
5. Ao trocar de servidor ou sair, o script envia um novo snapshot.
6. A API incrementa a versão do inventário e registra um evento de sync.

## Fluxo de economia Draco

1. Jogador, clã e nação possuem contas próprias.
2. Toda movimentação gera registro em `draco_transactions`.
3. O saldo atual fica em `accounts`.
4. Historico e auditoria ficam no banco para consultas futuras.

## Poderes por nação

Modelo inicial definido no banco:

- Fogo: `flame_dash`, `magma_guard`
- Agua: `healing_tide`, `ice_wall`
- Terra: `stone_skin`, `quake_jump`
- Vento: `wind_step`, `cyclone_push`

As habilidades foram modeladas como dados para permitir ajuste sem mudar toda a estrutura.
