import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, watch } from "node:fs";
import { join, basename } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  Piece,
  PluginContext,
  EventBus,
  CapabilityHandler,
} from "@jarvis/core";

const execAsync = promisify(exec);

const SKILLS_DIR = join(process.env.HOME ?? "~", ".jarvis", "skills");
const STATE_DIR = join(process.env.HOME ?? "~", ".jarvis", "state");
const STATE_FILE = join(STATE_DIR, "active-skills.json");
const SHELL_TIMEOUT_MS = 30_000;
const MAX_ACTIVE_SKILLS = 5;
const MAX_ACTIVE_TOKENS = 25_000; // ~100K chars / 4

// ─── Skill types ────────────────────────────────────────────

interface Skill {
  name: string;
  dir: string;
  description: string;
  whenToUse?: string;
  triggers?: string[];
  argumentHint?: string;
  userInvocable: boolean;
  autoInvoke: boolean;
  contextFork: boolean;
  shell: string;
  body: string;
}

interface ActiveSkill {
  name: string;
  processedBody: string;
}

// ─── YAML frontmatter parser ────────────────────────────────
// Supports: scalars, booleans, quoted strings, comma-separated lists,
// YAML arrays (- item), and multi-line values (indented continuation).

type MetaValue = string | string[] | boolean;

function parseFrontmatter(content: string): { meta: Record<string, MetaValue>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const meta: Record<string, MetaValue> = {};
  const lines = match[1].split("\n");

  let currentKey = "";
  let currentList: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // YAML list item: "  - value"
    if (/^\s+-\s+/.test(line) && currentKey) {
      const item = line.replace(/^\s+-\s+/, "").trim();
      if (!currentList) currentList = [];
      currentList.push(item);
      continue;
    }

    // Flush pending list
    if (currentList && currentKey) {
      meta[currentKey] = currentList;
      currentList = null;
    }

    // Indented continuation line (multi-line value)
    if (/^\s+\S/.test(line) && currentKey && !currentList) {
      const prev = meta[currentKey];
      if (typeof prev === "string") {
        meta[currentKey] = prev + " " + line.trim();
      }
      continue;
    }

    // Key: value pair
    const kv = line.match(/^(\S+):\s*(.*)$/);
    if (!kv) continue;

    currentKey = kv[1];
    const rawValue = kv[2].trim();

    // Empty value — might be followed by a YAML list
    if (!rawValue) {
      currentList = [];
      continue;
    }

    // Boolean
    if (rawValue === "true") { meta[currentKey] = true; continue; }
    if (rawValue === "false") { meta[currentKey] = false; continue; }

    // Quoted string — strip quotes
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
      meta[currentKey] = rawValue.slice(1, -1);
      continue;
    }

    // Inline list: [item1, item2] or comma-separated
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      meta[currentKey] = rawValue.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
      continue;
    }

    // Plain scalar (might be comma-separated list if key is triggers/allowed-tools)
    meta[currentKey] = rawValue;
  }

  // Flush trailing list
  if (currentList && currentKey) {
    meta[currentKey] = currentList;
  }

  return { meta, body: match[2].trim() };
}

// Helper to get string from meta value
function metaStr(val: MetaValue | undefined): string | undefined {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val.join(", ");
  return undefined;
}

function metaBool(val: MetaValue | undefined, fallback: boolean): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") return val !== "false";
  return fallback;
}

function metaList(val: MetaValue | undefined): string[] | undefined {
  if (Array.isArray(val)) return val;
  if (typeof val === "string" && val) return val.split(",").map(s => s.trim()).filter(Boolean);
  return undefined;
}

// ─── Argument parsing ───────────────────────────────────────

function parseArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (const ch of raw) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; continue; }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

function substituteArgs(body: string, args: string[], skillDir: string, sessionId: string): string {
  let result = body;
  const hasPlaceholder = /\$ARGUMENTS|\$\d+/.test(body);

  result = result.replace(/\$ARGUMENTS/g, args.join(" "));
  result = result.replace(/\$(\d+)/g, (_, n) => args[parseInt(n)] ?? "");
  result = result.replace(/\$\{JARVIS_SKILL_DIR\}/g, skillDir);
  result = result.replace(/\$\{JARVIS_SESSION_ID\}/g, sessionId);
  result = result.replace(/\$\{JARVIS_CWD\}/g, process.cwd());

  if (!hasPlaceholder && args.length > 0) {
    result += `\n\nARGUMENTS: ${args.join(" ")}`;
  }
  return result;
}

// ─── Shell injection ────────────────────────────────────────

async function preprocessShell(body: string, cwd: string, shell: string): Promise<string> {
  let result = body;

  // Inline: !`command`
  const inlinePattern = /!\`([^`]+)\`/g;
  const inlineMatches = [...result.matchAll(inlinePattern)];
  for (const m of inlineMatches) {
    try {
      const { stdout } = await execAsync(m[1], { cwd, shell, timeout: SHELL_TIMEOUT_MS });
      result = result.replace(m[0], stdout.trim());
    } catch (err: any) {
      result = result.replace(m[0], `[Shell error: ${err.message ?? err}]`);
    }
  }

  // Block: ```!\ncommand\n```
  const blockPattern = /```!\n([\s\S]*?)```/g;
  const blockMatches = [...result.matchAll(blockPattern)];
  for (const m of blockMatches) {
    try {
      const { stdout } = await execAsync(m[1], { cwd, shell, timeout: SHELL_TIMEOUT_MS });
      result = result.replace(m[0], stdout.trim());
    } catch (err: any) {
      result = result.replace(m[0], `[Shell error: ${err.message ?? err}]`);
    }
  }

  return result;
}

// ─── Token estimation ───────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── SkillManagerPiece ──────────────────────────────────────

export class SkillManagerPiece implements Piece {
  readonly id = "skill-manager";
  readonly name = "Skill Manager";

  private bus!: EventBus;
  private ctx: PluginContext;
  private skills = new Map<string, Skill>();
  /** Per-session active skills: Map<sessionId, Map<skillName, ActiveSkill>> */
  private activeSkills = new Map<string, Map<string, ActiveSkill>>();
  private watcher?: ReturnType<typeof watch>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private started = false;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  systemContext(sessionId?: string): string {
    // Catalog: always show available skills (same for all sessions)
    const catalog = [...this.skills.values()]
      .filter(s => s.autoInvoke) // exclude auto-invoke: false from catalog
      .map(s => {
        const hint = s.argumentHint ? ` ${s.argumentHint}` : "";
        const parts = [s.description];
        if (s.whenToUse) parts.push(`Use when: ${s.whenToUse}`);
        if (s.triggers?.length) parts.push(`Triggers: ${s.triggers.join(", ")}`);
        return `- ${s.name}${hint}: ${parts.join(". ")}`;
      })
      .join("\n");

    // Active skills: per-session
    const sessionSkills = sessionId ? this.activeSkills.get(sessionId) : undefined;
    const active = sessionSkills
      ? [...sessionSkills.values()]
          .map(a => `<active_skill name="${a.name}">\n${a.processedBody}\n</active_skill>`)
          .join("\n\n")
      : "";

    if (!catalog && !active) return "";

    let ctx = "";
    if (catalog) {
      ctx += `<available_skills>\n${catalog}\n</available_skills>`;
    }
    if (active) {
      ctx += (ctx ? "\n\n" : "") + active;
    }
    return ctx;
  }

  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus = bus;

    this.scanSkills();
    this.restoreActiveSkills();
    this.registerCapabilities();
    this.registerSlashCommands();
    this.startWatcher();
  }

  async stop(): Promise<void> {
    this.persistActiveSkills();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  // ─── Discovery ──────────────────────────────────────────

  private scanSkills(): void {
    this.skills.clear();
    if (!existsSync(SKILLS_DIR)) return;

    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("."));

    for (const dir of dirs) {
      const skillPath = join(SKILLS_DIR, dir.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      try {
        const content = readFileSync(skillPath, "utf-8");
        const skill = this.parseSkill(dir.name, join(SKILLS_DIR, dir.name), content);
        if (skill) this.skills.set(skill.name, skill);
      } catch {
        // skip malformed
      }
    }
  }

  private parseSkill(dirName: string, dirPath: string, content: string): Skill | null {
    const parsed = parseFrontmatter(content);
    if (!parsed) return null;

    const { meta, body } = parsed;
    if (!body) return null;

    return {
      name: metaStr(meta.name) ?? dirName,
      dir: dirPath,
      description: metaStr(meta.description) ?? body.split("\n")[0].slice(0, 100),
      whenToUse: metaStr(meta.when_to_use) ?? metaStr(meta["when-to-use"]),
      triggers: metaList(meta.triggers) ?? metaList(meta.trigger),
      argumentHint: metaStr(meta["argument-hint"]),
      userInvocable: metaBool(meta["user-invocable"], true),
      autoInvoke: metaBool(meta["auto-invoke"], true),
      contextFork: metaBool(meta["context"], false) || metaStr(meta["context"]) === "fork",
      shell: metaStr(meta.shell) ?? "bash",
      body,
    };
  }

  // ─── Activation ─────────────────────────────────────────

  private async activateSkill(name: string, rawArgs: string, sessionId: string): Promise<{ ok: boolean; message: string }> {
    const skill = this.skills.get(name);
    if (!skill) return { ok: false, message: `Unknown skill: ${name}. Available: ${[...this.skills.keys()].join(", ")}` };

    // context: fork — delegate to an actor instead of injecting into context
    if (skill.contextFork) {
      return this.forkSkill(skill, rawArgs, sessionId);
    }

    // Check max active skills cap
    const sessionSkills = this.activeSkills.get(sessionId);
    const currentCount = sessionSkills?.size ?? 0;
    if (currentCount >= MAX_ACTIVE_SKILLS && !sessionSkills?.has(name)) {
      const activeNames = sessionSkills ? [...sessionSkills.keys()].join(", ") : "";
      return {
        ok: false,
        message: `Cannot activate **${name}**: max ${MAX_ACTIVE_SKILLS} active skills reached. Active: ${activeNames}. Deactivate one first with skill_deactivate.`,
      };
    }

    const args = parseArgs(rawArgs);
    let processed = substituteArgs(skill.body, args, skill.dir, sessionId);
    processed = await preprocessShell(processed, process.cwd(), skill.shell);

    // Check token budget
    const currentTokens = this.getSessionActiveTokens(sessionId);
    const newTokens = estimateTokens(processed);
    if (currentTokens + newTokens > MAX_ACTIVE_TOKENS && !sessionSkills?.has(name)) {
      return {
        ok: false,
        message: `Cannot activate **${name}**: would exceed active skills token budget (~${MAX_ACTIVE_TOKENS} tokens). Current: ~${currentTokens} tokens. Deactivate a skill first.`,
      };
    }

    if (!this.activeSkills.has(sessionId)) {
      this.activeSkills.set(sessionId, new Map());
    }
    this.activeSkills.get(sessionId)!.set(name, { name, processedBody: processed });

    this.persistActiveSkills();

    return {
      ok: true,
      message: `Skill **${name}** activated.${args.length > 0 ? ` Args: ${args.join(" ")}` : ""} The skill instructions are now in your context.`,
    };
  }

  private async forkSkill(skill: Skill, rawArgs: string, sessionId: string): Promise<{ ok: boolean; message: string }> {
    const args = parseArgs(rawArgs);
    let processed = substituteArgs(skill.body, args, skill.dir, sessionId);
    processed = await preprocessShell(processed, process.cwd(), skill.shell);

    // Dispatch to an actor via bus
    const actorName = `skill-${skill.name}`;
    this.bus.publish({
      channel: "ai.request",
      source: "skill-manager",
      target: `actor-${actorName}`,
      text: processed,
      replyTo: sessionId === "main" ? "main" : sessionId,
      data: {
        role: { name: `Skill: ${skill.name}`, systemPrompt: skill.description },
        name: actorName,
      },
    } as any);

    return {
      ok: true,
      message: `Skill **${skill.name}** forked to actor **${actorName}**. It will run autonomously and report back when done.`,
    };
  }

  private deactivateSkill(name: string, sessionId: string): { ok: boolean; message: string } {
    const sessionSkills = this.activeSkills.get(sessionId);
    if (!sessionSkills?.has(name)) return { ok: false, message: `Skill ${name} is not active.` };
    sessionSkills.delete(name);
    if (sessionSkills.size === 0) this.activeSkills.delete(sessionId);

    this.persistActiveSkills();

    return { ok: true, message: `Skill **${name}** deactivated.` };
  }

  private getSessionActiveTokens(sessionId: string): number {
    const sessionSkills = this.activeSkills.get(sessionId);
    if (!sessionSkills) return 0;
    let total = 0;
    for (const skill of sessionSkills.values()) {
      total += estimateTokens(skill.processedBody);
    }
    return total;
  }

  // ─── State Persistence ────────────────────────────────────

  private persistActiveSkills(): void {
    try {
      if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

      const state: Record<string, string[]> = {};
      for (const [sessionId, skills] of this.activeSkills) {
        state[sessionId] = [...skills.keys()];
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // non-critical — state is ephemeral by nature
    }
  }

  private restoreActiveSkills(): void {
    try {
      if (!existsSync(STATE_FILE)) return;

      const raw = readFileSync(STATE_FILE, "utf-8");
      const state: Record<string, string[]> = JSON.parse(raw);

      for (const [sessionId, skillNames] of Object.entries(state)) {
        for (const name of skillNames) {
          const skill = this.skills.get(name);
          if (!skill || skill.contextFork) continue; // don't restore forked skills

          // Re-activate without args (best effort — args aren't persisted)
          if (!this.activeSkills.has(sessionId)) {
            this.activeSkills.set(sessionId, new Map());
          }
          this.activeSkills.get(sessionId)!.set(name, { name, processedBody: skill.body });
        }
      }
    } catch {
      // corrupted state file — start fresh
    }
  }

  // ─── Capabilities ───────────────────────────────────────

  private registerCapabilities(): void {
    this.ctx.capabilityRegistry.register({
      name: "skill_invoke",
      description: "Activate a skill by name. The skill's instructions will be injected into context. Check <available_skills> for what's available.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name" },
          arguments: { type: "string", description: "Arguments to pass to the skill" },
        },
        required: ["name"],
      },
      handler: (async (input: Record<string, unknown>) => {
        const sessionId = String(input.__sessionId ?? "main");
        return this.activateSkill(String(input.name), String(input.arguments ?? ""), sessionId);
      }) as CapabilityHandler,
    });

    this.ctx.capabilityRegistry.register({
      name: "skill_deactivate",
      description: "Deactivate an active skill to free context space.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name to deactivate" },
        },
        required: ["name"],
      },
      handler: (async (input: Record<string, unknown>) => {
        const sessionId = String(input.__sessionId ?? "main");
        return this.deactivateSkill(String(input.name), sessionId);
      }) as CapabilityHandler,
    });

    this.ctx.capabilityRegistry.register({
      name: "skill_list",
      description: "List all available skills with their activation status.",
      input_schema: { type: "object", properties: {} },
      handler: (async (input: Record<string, unknown>) => {
        const sessionId = String(input.__sessionId ?? "main");
        const sessionSkills = this.activeSkills.get(sessionId);
        return {
          skills: [...this.skills.values()].map(s => ({
            name: s.name,
            description: s.description,
            active: sessionSkills?.has(s.name) ?? false,
            userInvocable: s.userInvocable,
            autoInvoke: s.autoInvoke,
            contextFork: s.contextFork,
            hint: s.argumentHint,
            triggers: s.triggers,
          })),
          activeCount: sessionSkills?.size ?? 0,
          activeTokens: this.getSessionActiveTokens(sessionId),
          limits: { maxSkills: MAX_ACTIVE_SKILLS, maxTokens: MAX_ACTIVE_TOKENS },
        };
      }) as CapabilityHandler,
    });
  }

  // ─── Slash Commands ─────────────────────────────────────

  private registerSlashCommands(): void {
    for (const skill of this.skills.values()) {
      if (!skill.userInvocable) continue;

      this.ctx.registerSlashCommand({
        name: skill.name,
        description: skill.description,
        hint: skill.argumentHint,
        source: "skills",
        handler: async (args: string) => {
          // Slash commands come from the main chat — use "main" session
          const result = await this.activateSkill(skill.name, args, "main");
          return { message: result.message, inject: result.ok ? "active" : undefined };
        },
      });
    }
  }

  private refreshSlashCommands(): void {
    // Unregister all existing skill commands
    for (const name of this.skills.keys()) {
      this.ctx.unregisterSlashCommand(name);
    }
    // Re-register from current skill set
    this.registerSlashCommands();
  }

  // ─── File Watcher ───────────────────────────────────────

  private startWatcher(): void {
    if (!existsSync(SKILLS_DIR)) return;

    try {
      this.watcher = watch(SKILLS_DIR, { recursive: true }, () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.scanSkills();
          this.refreshSlashCommands();
          // Clean up active skills for removed skill definitions
          for (const [sessionId, sessionSkills] of this.activeSkills) {
            for (const name of sessionSkills.keys()) {
              if (!this.skills.has(name)) {
                sessionSkills.delete(name);
              }
            }
            if (sessionSkills.size === 0) this.activeSkills.delete(sessionId);
          }
        }, 300);
      });
    } catch {
      // fs.watch not available — skip
    }
  }
}
