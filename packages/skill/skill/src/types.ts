/** Transport-safe skill provenance; no registry runtime is imported. */

/**
 * Origin bucket for a skill contribution. The value is prompt-visible
 * metadata, not precedence by itself. `renderSkillContent` treats only
 * `bundled`, `user-*`, `runtime`, and `custom` as trusted local content;
 * `project-*`, `installed`, and every other label, including a missing
 * source, are untrusted.
 */
export type SkillSource = 'project-shres' | 'project-agents' | 'runtime' | 'user-shres' | 'user-agents' | 'custom' | 'bundled' | 'installed' | (string & {})
