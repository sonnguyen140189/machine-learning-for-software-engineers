// Node.js setTimeout-based promise sleep, isolated here so the rest of the
// codebase doesn't need the bare global keyword.
import { setTimeout as nodeDelay } from "node:timers/promises";

/** @param {number} ms */
export const sleep = (ms) => nodeDelay(ms);
