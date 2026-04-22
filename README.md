# jarvis-plugin-skills

Skill system for JARVIS — Claude Code-style `SKILL.md` files with per-session isolation, injection modes, and token budgets.

## Install

Ask JARVIS:

```
"Install the skills plugin from github.com/giovanibarili/jarvis-plugin-skills"
```

## How it works

Skills are `SKILL.md` files inside `~/.jarvis/skills/<name>/`. Each file has YAML frontmatter (metadata) and a markdown body (instructions). The plugin discovers skills at boot, injects a catalog into the system prompt so the AI knows what's available, and loads full skill content only when invoked.

**SkillManagerPiece** scans the skills directory, parses frontmatter, registers capabilities and slash commands, watches for file changes (hot reload), and manages per-session activation state.

## Creating a skill

```
~/.jarvis/skills/my-skill/SKILL.md
```

```markdown
---
name: my-skill
description: What this skill does
when_to_use: When to invoke it
triggers: keyword1, keyword2
argument-hint: <required-arg>
user-invocable: true
auto-invoke: true
context: false
injection: system-prompt
activation: on-demand
shell: bash
---

# Instructions

The AI follows these instructions when the skill is active.

Arguments: $ARGUMENTS
First arg: $1
Skill dir: ${JARVIS_SKILL_DIR}
Session: ${JARVIS_SESSION_ID}

Dynamic content via shell: !`date +%Y-%m-%d`
```

## Frontmatter fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | dir name | Skill identifier |
| `description` | string | first line | One-line description shown in catalog |
| `when_to_use` | string | — | Guidance for when the AI should invoke |
| `triggers` | list/csv | — | Keywords that hint the AI to invoke |
| `argument-hint` | string | — | Shown in slash menu and catalog |
| `user-invocable` | bool | true | Register as `/skill-name` slash command |
| `auto-invoke` | bool | true | Show in `<available_skills>` catalog |
| `injection` | string | system-prompt | Where to inject: `system-prompt` (changes system prompt, may invalidate cache) or `message` (injected as conversation message, cache-friendly) |
| `activation` | string | on-demand | When to activate: `on-demand` (explicit invocation) or `bootstrap` (auto-activated on startup for main session) |
| `shell` | string | bash | Shell for `!`command`` preprocessing |

## Three invocation paths

**AI tool call** — the AI calls `skill_invoke(name, arguments)` when it recognizes a trigger or decides the skill is relevant.

**Slash command** — the user types `/skill-name [args]` in the chat. Skills with `user-invocable: true` are registered automatically.

**AI auto-invoke** — skills with `auto-invoke: true` appear in the `<available_skills>` catalog in the system prompt, letting the AI decide when to use them.

## Features

**Per-session isolation** — each session has its own set of active skills. Activating a skill in one session doesn't affect others.

**Max active skills cap** — maximum 5 active skills per session, preventing context bloat.

**Token budget** — active skills are capped at ~25K tokens combined per session. Exceeding the budget rejects activation with a clear message.

**Injection modes** — `injection: system-prompt` (default) places the skill body in the system prompt dynamic block. `injection: message` injects it as a conversation message before each API call, preserving system prompt cache. Use `message` mode for frequently toggled or large skills to avoid cache invalidation.

**Activation modes** — `activation: on-demand` (default) requires explicit invocation. `activation: bootstrap` auto-activates the skill for the main session on startup without needing a tool call.

**State persistence** — active skills are saved to `~/.jarvis/state/active-skills.json` on every activation/deactivation and restored on restart.

**Shell preprocessing** — inline `!`command`` and block ````!` syntax execute shell commands and inject their output before the skill body is sent to the AI.

**Argument substitution** — `$ARGUMENTS` (full string), `$1`/`$2` (positional), `${JARVIS_SKILL_DIR}`, `${JARVIS_SESSION_ID}`, `${JARVIS_CWD}`.

**Hot reload** — file changes in `~/.jarvis/skills/` are picked up automatically (300ms debounce).

## Tools

| Tool | Description |
|------|-------------|
| `skill_invoke` | Activate a skill by name with optional arguments |
| `skill_deactivate` | Deactivate a skill to free context space |
| `skill_list` | List all skills with activation status and token usage |

## License

ISC
