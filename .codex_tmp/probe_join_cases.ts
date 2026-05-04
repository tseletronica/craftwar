import { handleJoin } from "./src/services/player-sync.ts";

const cases = [
  { xuid: "C9002581130EB19F", gamertag: "SerafimM2025", serverSlug: "capital" },
  { xuid: "22083669FEB1645F", gamertag: "TravisMaddox745", serverSlug: "capital" }
];

for (const entry of cases) {
  const result = await handleJoin({ ...entry, legacyXuids: [] });
  console.log(entry.gamertag, JSON.stringify(result));
}