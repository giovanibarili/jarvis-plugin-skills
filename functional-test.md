# jarvis-plugin-skills — Functional Tests

> BDD scenarios for validating the Skill System plugin end-to-end.
> Execute these after any code change, plugin update, or JARVIS core upgrade.

## Feature: Skill Discovery

### Scenario: Skills are discovered at boot

```gherkin
Given the plugin is installed and enabled
And ~/.jarvis/skills/ contains directories with SKILL.md files
When I call skill_list
Then the result should contain all valid skills from the directory
And each skill should have name, description, active (boolean), userInvocable, autoInvoke, injection, activation, and triggers
And the skill count should match the number of valid SKILL.md files in ~/.jarvis/skills/
```

**Validation command:**
```
skill_list() → verify skill count matches: ls -d ~/.jarvis/skills/*/SKILL.md | wc -l
```

### Scenario: Skills appear in system prompt catalog

```gherkin
Given the plugin is running with discovered skills
When I check the system prompt via session_get_system
Then an <available_skills> section should be present
And each auto-invoke skill should be listed with name, description, when_to_use, and triggers
And skills with auto-invoke: false should NOT appear in the catalog
```

### Scenario: Malformed SKILL.md is skipped

```gherkin
Given a skill directory exists at ~/.jarvis/skills/broken-skill/
And its SKILL.md has no YAML frontmatter (missing --- delimiters)
When the plugin scans skills
Then "broken-skill" should NOT appear in skill_list
And no error should crash the plugin
And all other valid skills should still be loaded
```

### Scenario: Skill directory without SKILL.md is skipped

```gherkin
Given a directory exists at ~/.jarvis/skills/empty-dir/ with no SKILL.md file
When the plugin scans skills
Then "empty-dir" should NOT appear in skill_list
And no error should occur
```

## Feature: Skill Activation

### Scenario: Activate a skill by name

```gherkin
Given skill "file-preview" exists and is not active
When I call skill_invoke with name "file-preview"
Then the result should be ok: true with message containing "activated"
And skill_list should show "file-preview" as active: true
And the skill body should be injected into the system prompt as <active_skill name="file-preview">
```

### Scenario: Activate a skill with arguments

```gherkin
Given skill "file-preview" exists
When I call skill_invoke with name "file-preview" and arguments "test-arg"
Then the result should be ok: true
And the message should mention the arguments
And $ARGUMENTS in the skill body should be replaced with "test-arg"
```

### Scenario: Activate an unknown skill

```gherkin
Given no skill named "nonexistent" exists
When I call skill_invoke with name "nonexistent"
Then the result should be ok: false
And the message should contain "Unknown skill: nonexistent"
And the message should list available skills
```

### Scenario: Re-activate an already active skill

```gherkin
Given skill "file-preview" is already active in the current session
When I call skill_invoke with name "file-preview" again
Then the result should be ok: true (re-activation replaces the previous body)
And skill_list should still show only one instance of "file-preview"
And the active skill count should not increase
```

### Scenario: Max active skills cap (5)

```gherkin
Given 5 skills are already active in the current session
When I call skill_invoke for a 6th skill that is not already active
Then the result should be ok: false
And the message should contain "max 5 active skills reached"
And the message should list the currently active skills
And suggest using skill_deactivate first
```

### Scenario: Token budget enforcement

```gherkin
Given the combined token count of active skills is near the 25K limit
When I try to activate a large skill that would exceed the budget
Then the result should be ok: false
And the message should contain "exceed active skills token budget"
And suggest deactivating a skill first
```

## Feature: Skill Deactivation

### Scenario: Deactivate an active skill

```gherkin
Given skill "file-preview" is active in the current session
When I call skill_deactivate with name "file-preview"
Then the result should be ok: true with message containing "deactivated"
And skill_list should show "file-preview" as active: false
And the <active_skill> block for "file-preview" should be removed from the system prompt
```

### Scenario: Deactivate a skill that is not active

```gherkin
Given skill "file-preview" is NOT active in the current session
When I call skill_deactivate with name "file-preview"
Then the result should be ok: false
And the message should contain "is not active"
```

## Feature: Per-Session Isolation

> Skills are stored per session ID internally. The main session uses "main". 
> These scenarios verify isolation by inspecting internal state via jarvis_eval.

### Scenario: Skills activated in main are not visible to other sessions

```gherkin
Given skill "file-preview" is active in the "main" session
When I inspect the internal activeSkills map for a different session ID
Then that session should have 0 active skills
And "file-preview" should remain active in "main"
```

**Validation command:**
```
1. skill_invoke(name="file-preview") → activates in main
2. skill_list() → verify file-preview is active, note activeCount
3. jarvis_eval: inspect activeSkills map for session "other-session" → should be empty/undefined
4. skill_deactivate(name="file-preview") → cleanup
```

## Feature: State Persistence

### Scenario: Active skills survive restart

```gherkin
Given skill "file-preview" is active in the "main" session
Then ~/.jarvis/state/active-skills.json should exist
And it should contain {"main": ["file-preview", ...]}
When JARVIS restarts
Then the previously active skills should be restored from the state file
And skill_list should show them as active again
```

**Validation command:**
```
1. skill_invoke(name="file-preview")
2. bash: cat ~/.jarvis/state/active-skills.json → verify "file-preview" is listed under "main"
3. skill_deactivate(name="file-preview") → cleanup
```

### Scenario: State file is updated on every activation/deactivation

```gherkin
Given the state file exists at ~/.jarvis/state/active-skills.json
When I activate a skill
Then the state file should be updated to include it
When I deactivate that skill
Then the state file should be updated to exclude it
```

## Feature: Slash Commands

### Scenario: Skills register as slash commands

```gherkin
Given skills with user-invocable: true exist
When the plugin starts
Then each user-invocable skill should be registered as a slash command
And the slash command should be available in the chat input (e.g. /file-preview)
```

**Validation command:**
```
jarvis_eval: check registered slash commands include skill names
```

### Scenario: Non-invocable skills are not registered as slash commands

```gherkin
Given a skill with user-invocable: false exists
When the plugin registers slash commands
Then that skill should NOT appear as a slash command
```

## Feature: Hot Reload

### Scenario: New skill picked up without restart

```gherkin
Given the plugin is running
When I create a new directory ~/.jarvis/skills/test-hot-reload/ with a valid SKILL.md
And wait ~300ms for the debounce
Then skill_list should include "test-hot-reload"
When I delete the test-hot-reload directory
And wait ~300ms
Then skill_list should no longer include "test-hot-reload"
```

**Validation command:**
```
1. bash: mkdir -p ~/.jarvis/skills/test-hot-reload && cat > ~/.jarvis/skills/test-hot-reload/SKILL.md << 'EOF'
---
name: test-hot-reload
description: Temporary skill for hot reload testing
triggers: hot-reload-test
---

This is a test skill for hot reload validation.
EOF
2. Wait 1 second
3. skill_list() → verify "test-hot-reload" is present
4. bash: rm -rf ~/.jarvis/skills/test-hot-reload
5. Wait 1 second
6. skill_list() → verify "test-hot-reload" is gone
```

## Feature: Shell Preprocessing

### Scenario: Inline shell commands are executed

```gherkin
Given a skill body contains !`date +%Y` inline
When the skill is activated
Then the !`date +%Y` should be replaced with the current year (e.g. "2025")
And the processed body should contain the shell output, not the raw command
```

### Scenario: Shell errors are handled gracefully

```gherkin
Given a skill body contains !`nonexistent-command-xyz`
When the skill is activated
Then the inline command should be replaced with "[Shell error: ...]"
And the skill should still activate successfully
And no crash should occur
```

## Feature: Argument Substitution

### Scenario: Positional arguments are substituted

```gherkin
Given a skill body contains $1 and $2 placeholders
When activated with arguments "hello world"
Then $1 should be replaced with "hello"
And $2 should be replaced with "world"
And $ARGUMENTS should be replaced with "hello world"
```

### Scenario: Environment variables are substituted

```gherkin
Given a skill body contains ${JARVIS_SKILL_DIR}, ${JARVIS_SESSION_ID}, and ${JARVIS_CWD}
When activated in the "main" session
Then ${JARVIS_SKILL_DIR} should be replaced with the skill's directory path
And ${JARVIS_SESSION_ID} should be replaced with "main"
And ${JARVIS_CWD} should be replaced with the current working directory
```

### Scenario: Arguments without placeholders are appended

```gherkin
Given a skill body does NOT contain $ARGUMENTS or $1 placeholders
When activated with arguments "some input"
Then "ARGUMENTS: some input" should be appended at the end of the body
```

## Feature: Skill Info & Limits

### Scenario: skill_list returns complete metadata

```gherkin
Given skills exist in the system
When I call skill_list
Then the response should contain:
  - skills: array with name, description, active, userInvocable, autoInvoke, injection, activation, triggers
  - activeCount: number of currently active skills
  - activeTokens: estimated token count of all active skill bodies
  - limits: { maxSkills: 5, maxTokens: 25000 }
```

## Feature: Injection Modes

### Scenario: Skill with injection: message is NOT in system prompt

```gherkin
Given a skill with injection: message exists and is active
When I check the system prompt via session_get_system
Then the <active_skill> block for that skill should NOT appear in the system prompt
And the skill should still be listed as active in skill_list
```

**Validation command:**
```
1. Create test skill with injection: message
2. skill_invoke(name="test-msg-inject")
3. session_get_system(raw=true) → verify NO <active_skill name="test-msg-inject"> in blocks
4. skill_list() → verify test-msg-inject is active: true
5. Cleanup: skill_deactivate + remove test skill
```

### Scenario: Skill with injection: system-prompt appears in system prompt (default)

```gherkin
Given a skill with injection: system-prompt (or no injection field) is active
When I check the system prompt via session_get_system
Then the <active_skill> block for that skill SHOULD appear in the system prompt dynamic block
```

### Scenario: Activation message reflects injection mode

```gherkin
Given a skill with injection: message exists
When I call skill_invoke for it
Then the activation message should contain "Injected as message (cache-friendly)"
Given a skill with injection: system-prompt exists
When I call skill_invoke for it
Then the activation message should contain "The skill instructions are now in your context"
```

## Feature: Activation Modes

### Scenario: Bootstrap skill auto-activates on startup

```gherkin
Given a skill with activation: bootstrap exists
When JARVIS starts (or the plugin restarts)
Then that skill should be automatically active in the main session without any explicit invocation
And skill_list should show it as active: true
```

**Validation command:**
```
1. Create test skill with activation: bootstrap
2. Restart JARVIS or reload the plugin
3. skill_list() → verify the bootstrap skill is active: true in main
4. Cleanup: remove test skill
```

### Scenario: On-demand skill does NOT auto-activate

```gherkin
Given a skill with activation: on-demand (or no activation field) exists
When JARVIS starts
Then that skill should NOT be automatically active
And it should only become active when explicitly invoked via skill_invoke or slash command
```

## Feature: Compaction Promotion (message → system-prompt)

### Scenario: Message-injected skill is promoted to system-prompt after compaction

```gherkin
Given a skill with injection: message is active in session "main"
When a compaction event is published on the bus for session "main"
Then the active skill's injection mode should change to "system-prompt" in memory
And the skill body should appear in the system prompt (via session_get_system)
And the skill should NOT be re-injected as ephemeral message anymore
And skill_list should still show the skill as active
```

**Validation command:**
```
1. Create test skill with injection: message:
   bash: mkdir -p ~/.jarvis/skills/test-msg-promote && cat > ~/.jarvis/skills/test-msg-promote/SKILL.md << 'EOF'
   ---
   name: test-msg-promote
   description: Test skill for compaction promotion
   injection: message
   triggers: test-msg-promote
   ---

   This is a test skill that uses message injection mode.
   EOF
2. Wait 1 second for hot reload
3. skill_invoke(name="test-msg-promote") → verify ok, "Injected as message"
4. session_get_system(raw=true) → verify NO <active_skill name="test-msg-promote"> in system prompt
5. Simulate compaction: jarvis_eval to publish system.event with event="compaction", data={sessionId:"main"}
6. session_get_system(raw=true) → verify <active_skill name="test-msg-promote"> IS now in system prompt
7. skill_list() → verify test-msg-promote is still active
8. Cleanup: skill_deactivate(name="test-msg-promote") + rm -rf ~/.jarvis/skills/test-msg-promote
```

### Scenario: Re-activation after promotion restores original injection mode

```gherkin
Given a skill with injection: message was promoted to system-prompt after compaction
When I deactivate and re-activate the skill
Then the skill should revert to injection: message (original mode from SKILL.md)
And the skill body should NOT appear in the system prompt
And the skill should be injected as ephemeral message again
```

**Validation command:**
```
1. Create test skill with injection: message (as above)
2. skill_invoke(name="test-msg-promote")
3. Simulate compaction (as above) → skill is now system-prompt in memory
4. skill_deactivate(name="test-msg-promote")
5. skill_invoke(name="test-msg-promote") → verify "Injected as message" (not system-prompt)
6. session_get_system(raw=true) → verify NO <active_skill name="test-msg-promote"> in system prompt
7. Cleanup: skill_deactivate + rm -rf ~/.jarvis/skills/test-msg-promote
```

### Scenario: Only message-injected skills are promoted

```gherkin
Given skill "file-preview" (injection: system-prompt) is active
And a skill with injection: message is active
When a compaction event occurs
Then the message-injected skill should be promoted to system-prompt
And "file-preview" should remain unchanged (already system-prompt)
```

### Scenario: Promotion only affects the compacted session

```gherkin
Given a skill with injection: message is active in both "main" and "other-session" (via internal state)
When a compaction event occurs for session "main" only
Then the skill should be promoted to system-prompt in "main"
And the skill should remain injection: message in "other-session" (unaffected)
```

## Execution Checklist

Run these commands in order to validate the full lifecycle:

```
1. skill_list()
   → Verify: all skills from ~/.jarvis/skills/ are listed, counts match
   → Verify: each skill has injection and activation fields

2. skill_invoke(name="file-preview")
   → Verify: ok=true, skill becomes active, appears in system prompt

3. skill_list()
   → Verify: file-preview shows active: true, activeCount incremented, activeTokens > 0

4. skill_invoke(name="file-preview", arguments="test.txt")
   → Verify: ok=true, re-activation works, active count unchanged

5. skill_deactivate(name="file-preview")
   → Verify: ok=true, skill no longer active

6. skill_deactivate(name="file-preview")
   → Verify: ok=false, "is not active"

7. skill_invoke(name="nonexistent")
   → Verify: ok=false, "Unknown skill"

8. bash: cat ~/.jarvis/state/active-skills.json
   → Verify: state file reflects current active skills

9. Hot reload test:
   mkdir + SKILL.md → wait → skill_list → verify present
   rm -rf → wait → skill_list → verify gone

10. Per-session isolation:
    skill_invoke(file-preview) in main → jarvis_eval inspect other session → should be empty → cleanup

11. Injection mode — message:
    Create test skill with injection: message → skill_invoke → verify NOT in system prompt
    → verify IS active in skill_list → cleanup

15. Injection mode — system-prompt (default):
    skill_invoke(file-preview) → verify <active_skill> IS in system prompt → cleanup

16. Activation mode — bootstrap:
    Create test skill with activation: bootstrap → restart/reload → verify auto-active → cleanup

17. Activation mode — on-demand (default):
    Verify skills without activation: bootstrap are NOT auto-activated

18. Compaction promotion — message → system-prompt:
    Create test skill with injection: message → skill_invoke → verify NOT in system prompt
    → simulate compaction → verify IS in system prompt → verify still active
    → cleanup

19. Compaction promotion — re-activation restores original mode:
    Create test skill with injection: message → skill_invoke → simulate compaction
    → skill_deactivate → skill_invoke again → verify "Injected as message"
    → verify NOT in system prompt → cleanup

20. Compaction promotion — only affects message-injected skills:
    Activate file-preview (system-prompt) + test-msg skill (message)
    → simulate compaction → file-preview unchanged, test-msg promoted → cleanup

21. Compaction promotion — only affects compacted session:
    Activate test-msg skill in main + other session → simulate compaction for main only
    → main promoted, other session unaffected → cleanup
```
