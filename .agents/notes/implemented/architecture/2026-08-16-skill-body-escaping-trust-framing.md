# Agent Note: Skill body escaping and project-source trust framing

Status: implemented


## Problem

`renderSkillContent` embedded the skill body verbatim between `<skill_instructions>` and `</skill_content>`. A body that spelled those closing tags ended the wrapper early and could inject following markup as if the harness had written it.

Not every skill is equally trusted. `bundled` and `user-*` skills come from the operator's install or home directory. `project-roos` and `project-agents` skills come from `<projectRoot>/.roos/skills` and `<projectRoot>/.agents/skills` — files in a checkout that another author can change. Those bodies can carry instructions, permission claims, or tool-shaped requests the current user did not write. The catalog already stays summary-only; the full body reaches the model through the `skill` tool result and the user-explicit `/name` injection, both of which share `renderSkillContent`.

## Decision

`renderSkillContent` still owns the single `<skill_content>` block for both load paths. Trust is fail-closed: only `bundled`, `user-*`, `runtime`, and `custom` are trusted local content. `project-*`, any other label, and a missing source are untrusted.

- Trusted bodies neutralize a close-tag family — `</skill_content>` / `</skill_instructions>`, ASCII case-insensitive, optional whitespace before `>` — by replacing the opening `<` with `UNTRUSTED_LT_ESCAPE`. Other markup, including `<tags>`, stays intact. The `name` attribute remains HTML-escaped as before.
- Untrusted sources place the untrusted-frame header **inside** `<skill_content>`, above the instruction body, so the catalog sentence that says to follow that block includes the disclaimer. The body is `wrapUntrusted('skill_instructions', content)`, which escapes every `<`. Resource hints stay inside the outer block and outside the wrapped body.

The `skill` tool's structured value carries `source` so the Native renderer can apply the same rule as the user-explicit injection, which already receives the full `SkillDefinition`.

The catalog is unchanged: it still publishes `name` and description only.

## Alternatives considered

**Treat every skill as untrusted and run `escapeUntrusted` on the whole body.** Rejected because bundled and user-home skills are operator-controlled local content. Escaping every `<` would rewrite their markdown for a threat they do not have. Untrusted sources do run `escapeUntrusted` via `wrapUntrusted`.

**Warn in the system prompt or catalog only, without escaping close tags.** Rejected because a body that contains `</skill_instructions>` still closes the wrapper; a catalog sentence cannot restore a broken frame.

**Wrap the entire `<skill_content>` block in `frameUntrusted`.** Rejected because that would escape the harness's own tags and the `name` attribute. Trusted metadata (name, resource hints) stays outside the wrapped instruction body; the header sits inside `<skill_content>` so the catalog-named block includes it.

**Trust any non-`project-*` source, including unknown labels and a missing source.** Rejected because `SkillSource` is an open union. A future remote or marketplace provider that picks any other string would ship trusted. The allowlist is the four local trusted labels.

**Trust project skills the same as user-home skills.** Rejected because a cloned repository is not the current user's writing. Project skill files are the skill equivalent of fetched web text.

## Consequences

- Project skill renders grow by the header inside `<skill_content>`, and every `<` in those bodies becomes `\u003c`. Snapshots that load a `project-*` skill (ACP `skill-load`, the web skill-tool row, the agent-spine hot-skill path) carry those bytes. Bundled skill renders such as `roos-badge` stay byte-identical except for the new structured `source` field.
- A trusted body that mentioned the close-tag family now shows `\u003c/skill_content>` / `\u003c/skill_instructions>` (and case or spacing variants) inside the still-closed wrapper.
- The catalog template and replacement lifecycle do not mention trust. A later catalog change is not required when only the body-render rule changes.
- A new remote provider is untrusted until it is added to the trusted allowlist.
