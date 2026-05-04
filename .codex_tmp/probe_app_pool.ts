import { handleJoin, saveInventory } from "./src/services/player-sync.ts";

async function main() {
  const sampleXuid = "5A641DD328C5ABA1";
  const sampleGamertag = "PlaneCafe18466";
  const currentServerSlug = "air";

  try {
    const joinResult = await handleJoin({
      xuid: sampleXuid,
      gamertag: sampleGamertag,
      serverSlug: currentServerSlug,
      legacyXuids: []
    });
    console.log("handleJoin ok", JSON.stringify(joinResult));
  } catch (error) {
    console.error("handleJoin failed", error);
  }

  try {
    const inventoryResult = await saveInventory({
      xuid: sampleXuid,
      gamertag: sampleGamertag,
      serverSlug: currentServerSlug,
      legacyXuids: [],
      transferDestinationSlug: "fire",
      inventory: [],
      armor: [],
      enderChest: [],
      offhand: {},
      hotbarSlot: 0,
      experienceLevel: 0,
      totalExperience: 0,
      health: 20,
      hunger: 20,
      saturation: 5,
      metadata: {
        source: "probe_app_pool"
      }
    });
    console.log("saveInventory ok", JSON.stringify(inventoryResult));
  } catch (error) {
    console.error("saveInventory failed", error);
  }
}

main().catch((error) => {
  console.error("fatal", error);
  process.exit(1);
});
