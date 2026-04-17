import { SkillManagerPiece } from "./skill-manager.js";
import type { PluginContext } from "@jarvis/core";

export function createPieces(ctx: PluginContext) {
  return [new SkillManagerPiece(ctx)];
}
