import { readFileSync, existsSync, readdirSync, watch } from "node:fs";
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
const SHELL_TIMEOUT_MS = 30_000;

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
  shell: string;
  body: string;
}

interface ActiveSkill {
  name: string;
  processedBody: string;
}

// ─── YAML-light parser ──────────────────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\S+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: match[2].trim() };
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

// ─── SkillManagerPiece ──────────────────────────────────────

export class SkillManagerPiece implements Piece {
  readonly id = "skill-manager";
  readonly name = "Skill Manager";

  private bus!: EventBus;
  private ctx: PluginContext;
  private skills = new Map<string, Skill>();
  private activeSkills = new Map<string, ActiveSkill>();
  private watcher?: ReturnType<typeof watch>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private started = false;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  systemContext(): string {
    // Catalog: always show available skills
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

    // Active skills: injected bodies
    const active = [...this.activeSkills.values()]
      .map(a => `<active_skill name="${a.name}">\n${a.processedBody}\n</active_skill>`)
      .join("\n\n");

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
    this.registerCapabilities();
    this.registerSlashCommands();
    this.startWatcher();
  }

  async stop(): Promise<void> {
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
      .filter(d => d.isDirectory());

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

    // Parse triggers (comma-separated or YAML list)
    const rawTriggers = meta.triggers ?? meta["trigger"];
    const triggers = rawTriggers
      ? rawTriggers.split(",").map((t: string) => t.trim()).filter(Boolean)
      : undefined;

    return {
      name: meta.name ?? dirName,
      dir: dirPath,
      description: meta.description ?? body.split("\n")[0].slice(0, 100),
      whenToUse: meta.when_to_use ?? meta["when-to-use"],
      triggers,
      argumentHint: meta["argument-hint"],
      userInvocable: meta["user-invocable"] !== "false",
      autoInvoke: meta["auto-invoke"] !== "false",
      shell: meta.shell ?? "bash",
      body,
    };
  }

  // ─── Activation ─────────────────────────────────────────

  private async activateSkill(name: string, rawArgs: string): Promise<{ ok: boolean; message: string }> {
    const skill = this.skills.get(name);
    if (!skill) return { ok: false, message: `Unknown skill: ${name}. Available: ${[...this.skills.keys()].join(", ")}` };

    const args = parseArgs(rawArgs);
    let processed = substituteArgs(skill.body, args, skill.dir, "main");
    processed = await preprocessShell(processed, process.cwd(), skill.shell);

    this.activeSkills.set(name, { name, processedBody: processed });

    return {
      ok: true,
      message: `Skill **${name}** activated.${args.length > 0 ? ` Args: ${args.join(" ")}` : ""} The skill instructions are now in your context.`,
    };
  }

  private deactivateSkill(name: string): { ok: boolean; message: string } {
    if (!this.activeSkills.has(name)) return { ok: false, message: `Skill ${name} is not active.` };
    this.activeSkills.delete(name);
    return { ok: true, message: `Skill **${name}** deactivated.` };
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
        return this.activateSkill(String(input.name), String(input.arguments ?? ""));
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
        return this.deactivateSkill(String(input.name));
      }) as CapabilityHandler,
    });

    this.ctx.capabilityRegistry.register({
      name: "skill_list",
      description: "List all available skills with their activation status.",
      input_schema: { type: "object", properties: {} },
      handler: (async () => ({
        skills: [...this.skills.values()].map(s => ({
          name: s.name,
          description: s.description,
          active: this.activeSkills.has(s.name),
          userInvocable: s.userInvocable,
          autoInvoke: s.autoInvoke,
          hint: s.argumentHint,
          triggers: s.triggers,
        })),
        activeCount: this.activeSkills.size,
      })) as CapabilityHandler,
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
          const result = await this.activateSkill(skill.name, args);
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
          // Re-process active skills if their source changed
          for (const [name, active] of this.activeSkills) {
            if (!this.skills.has(name)) {
              this.activeSkills.delete(name);
            }
          }
        }, 300);
      });
    } catch {
      // fs.watch not available — skip
    }
  }
}
