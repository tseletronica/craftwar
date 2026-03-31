import { config } from "../config.js";

/**
 * Normaliza textos para comparação de gamertags e xuids.
 * Remove acentos, espaços extras e deixa em minúsculo.
 */
function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Verifica se uma identidade (gamertag ou XUID) pertence a um administrador
 * configurado nas variáveis de ambiente da rede.
 */
export function isAdmin(gamertag: string, xuid?: string | null): boolean {
  const normalizedGamertag = normalizeText(gamertag);
  const normalizedXuid = String(xuid || "").trim();

  // Verifica no catálogo de Gamertags permitidas
  const isAllowedGamertag = config.ADMIN_COMMAND_GAMERTAGS.some(
    (entry) => normalizeText(entry) === normalizedGamertag
  );

  // Verifica no catálogo de XUIDs permitidos
  const isAllowedXuid = normalizedXuid.length > 0 && 
    config.ADMIN_COMMAND_XUIDS.includes(normalizedXuid);

  const result = isAllowedGamertag || isAllowedXuid;
  if (!result && (normalizedGamertag.includes("serafim") || normalizedXuid === "2535408045948271")) {
    console.warn(`[ADMIN] Denied admin access for "${gamertag}" ("${xuid}"). Configured tags: [${config.ADMIN_COMMAND_GAMERTAGS}], xuids: [${config.ADMIN_COMMAND_XUIDS}]`);
  }

  return result;
}
