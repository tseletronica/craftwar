# Addon Bedrock

Esta pasta agora já contém o pack `behavior_packs/network_core`, usado para sincronizar perfil, inventário e saldo com a API central.

Como ele funciona hoje:

1. O container Bedrock copia `behavior_packs/network_core` para `/data/behavior_packs/network_core` no bootstrap.
2. O script recebe `networkBaseUrl` e `serverSlug` via `@minecraft/server-admin` variables.
3. No join, o pack tenta usar `persistentId` do `@minecraft/server-admin`; se não estiver disponível, cai para o nome do jogador em lowercase.
4. O pack chama:
   - `POST /internal/player-sync/join`
   - `POST /internal/player-sync/state`
   - `POST /internal/player-sync/inventory`
   - `POST /internal/player-sync/leave`

Próximas extensões naturais:

- `scripts/nation-powers.js`
- `scripts/clan-commands.js`
- aplicação de poderes com base em `nationSlug`
