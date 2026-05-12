import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_PATH = "out/state.json";

export async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { postedPlaceIds: [], history: [] };
  }
}

export async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}
