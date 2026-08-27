/**
 * JSON Schema fragments for charter tool arguments.
 *
 * @module @shres-code/shres-code-tool-jspace/charter-schema
 */

const FAIL_PROBE_MUTATION = {
  required: true as const,
  oneOf: [
    {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        kind: { type: 'string' as const, required: true as const, const: 'insert' },
        content: { type: 'string' as const, required: true as const },
      },
    },
    {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        kind: { type: 'string' as const, required: true as const, const: 'prepend' },
        content: { type: 'string' as const, required: true as const },
      },
    },
    {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        kind: { type: 'string' as const, required: true as const, const: 'replace' },
        from: { type: 'string' as const, required: true as const },
        to: { type: 'string' as const, required: true as const },
      },
    },
  ] as const,
}

const FAIL_PROBE = {
  type: 'object' as const,
  additionalProperties: false as const,
  description:
    'A content mutation that must make `command` fail. Required when this deployment demands demonstrated discrimination.',
  properties: {
    path: {
      type: 'string' as const,
      required: true as const,
      description: 'Workspace-relative path; must be in `reads` or match a `reads` glob.',
    },
    mutation: FAIL_PROBE_MUTATION,
  },
}

/** Check-entry object for `jspace_open` / amend add / replace. */
export const CHARTER_CHECK_OBJECT = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    kind: { type: 'string' as const, required: true as const, const: 'check' },
    id: { type: 'string' as const, description: 'Kebab-case id. Omit to receive a harness-assigned id.' },
    constraint: {
      type: 'string' as const,
      required: true as const,
      description: 'The rule this command enforces, in the task\'s words.',
    },
    command: {
      type: 'string' as const,
      required: true as const,
      description: 'Foreground bash. Exit 0 = pass. Must read the paths in `reads`.',
    },
    reads: {
      type: 'array' as const,
      required: true as const,
      items: { type: 'string' as const },
      description: 'Workspace-relative files or globs the command reads. At least one.',
    },
    failProbe: FAIL_PROBE,
  },
}

/** Prose-entry object. */
export const CHARTER_PROSE_OBJECT = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    kind: { type: 'string' as const, required: true as const, const: 'prose' },
    id: { type: 'string' as const },
    constraint: { type: 'string' as const, required: true as const },
  },
}

/** Accept a harness proposal by id list (omit ids to accept all). */
export const CHARTER_ACCEPT_OBJECT = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    kind: { type: 'string' as const, required: true as const, const: 'accept-proposal' },
    ids: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Proposal ids to accept. Omit to accept every proposed entry.',
    },
  },
}

/** `jspace_open` charter array items. */
export const OPEN_CHARTER_ITEMS = {
  oneOf: [CHARTER_CHECK_OBJECT, CHARTER_PROSE_OBJECT, CHARTER_ACCEPT_OBJECT] as const,
}

/** Amend add / replace.entry items (no accept-proposal). */
export const AMEND_CHARTER_ITEMS = {
  oneOf: [CHARTER_CHECK_OBJECT, CHARTER_PROSE_OBJECT] as const,
}

/** `jspace_open` charter parameter. */
export const OPEN_CHARTER_PARAM = {
  type: 'array' as const,
  description:
    'Standing constraints this work must honor. Prefer kind=check (a bash command the harness will '
    + 'run at every checkpoint and at ship). Each check names the constraint text it enforces. '
    + 'kind=accept-proposal copies ids from the harness proposal in this turn. '
    + 'Registers on first open, or on an open card whose charter is still empty.',
  items: OPEN_CHARTER_ITEMS,
}
