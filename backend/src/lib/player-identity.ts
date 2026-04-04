import { z } from "zod";

function normalizeIdentityValue(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function isGamertagFallbackXuid(xuid: string, gamertag: string) {
  const normalizedXuid = normalizeIdentityValue(xuid);
  const normalizedGamertag = normalizeIdentityValue(gamertag);

  return normalizedXuid.length > 0 && normalizedXuid === normalizedGamertag;
}

export function rejectGamertagFallbackXuid(
  payload: { xuid: string; gamertag: string },
  ctx: z.RefinementCtx
) {
  if (!isGamertagFallbackXuid(payload.xuid, payload.gamertag)) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["xuid"],
    message: "xuid must be the persistent player id, not the normalized gamertag."
  });
}
