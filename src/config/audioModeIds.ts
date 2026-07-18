import type { AudioModeConfig } from "./schema.ts";

const legacyAudioModeIds: Record<string, string> = {
  "desk-mic": "headset-desk-mic",
  iem: "iems",
  speaker: "desk-speakers"
};

export function migrateAudioModeId(id: string): string {
  return legacyAudioModeIds[id] ?? id;
}

export function migrateAudioModeOverrides(
  modes: Record<string, AudioModeConfig> | undefined
): Record<string, AudioModeConfig> | undefined {
  if (!modes) return undefined;

  const migratedModes = { ...modes };
  for (const [legacyId, currentId] of Object.entries(legacyAudioModeIds)) {
    const mode = migratedModes[legacyId];
    if (!mode) continue;
    if (!migratedModes[currentId]) migratedModes[currentId] = mode;
    delete migratedModes[legacyId];
  }
  return migratedModes;
}
