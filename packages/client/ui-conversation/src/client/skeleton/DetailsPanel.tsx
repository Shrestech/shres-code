// DetailsPanel: a close button plus, for a call selection, the selected
// call's args and result — args as JSON, the result raw except for a
// terminal-card call, whose Output section is the command's terminal card;
// for a file selection, the file's bounded text with a native-editor
// hand-off. Reads the selection from the shared chat store (conversation
// writes, this panel reads — the cross-registration share the store seat
// exists for), derives the call material from the session snapshot, and
// fetches file content per selection.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { CodeBlock, ReadBlock } from '@shres-code/shres-code-client-ui-primitives'
import { shallowEqual } from '@shres-code/shres-code-client-runtime/client'
import type { ConversationSnapshot, RunningToolCall, ToolCallBlock, ToolResultNode } from '@shres-code/shres-code-client-runtime/client'
import type { FileRead } from '@shres-code/shres-code-client-connection/client'
import type { DetailsSlotProps } from '../contract/slots.ts'
import type { CallSelectionTarget, FileSelectionTarget, SelectionTarget } from '../contract/views.ts'
import { findToolCall } from '../chat/tool-node-reader.ts'
import css from './DetailsPanel.module.css'

/** Full props composed by reference from the contract (automatic shares & injected share). */
export type DetailsPanelProps = DetailsSlotProps

/**
 * Selected call material: the call's display name and args plus the frozen
 * block slice it came from. `block` is a snapshot-cached reference, so the
 * wrapper stays shallow-equal across unrelated snapshot frames; the settled /
 * running split is read off it with the `'kind' in block` discrimination
 * instead of duplicated as flags.
 */
interface CallMaterial {
  name: string
  argsRaw: string | null
  block: ToolCallBlock
}

/** Material of a settled result node (native call or run_code sub-dispatch). */
function settledMaterial(node: ToolResultNode, callId: string): CallMaterial {
  return { name: node.call?.name ?? callId, argsRaw: node.call?.argsRaw ?? null, block: node }
}

/** Material of an in-flight call (native call or run_code sub-dispatch). */
function runningMaterial(call: RunningToolCall): CallMaterial {
  return { name: call.name, argsRaw: call.argsRaw, block: call }
}

function materialFor(s: ConversationSnapshot, callId: string): CallMaterial | null {
  const found = findToolCall(s, callId)
  if (found === undefined) return null
  return 'kind' in found ? settledMaterial(found, callId) : runningMaterial(found)
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // Not JSON (streaming fragment or plain text): show verbatim.
    return raw
  }
}

/** Flatten a settled result for the no-ui-tool fallback. */
function rawResultText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  const parts = block.content.map(item => item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n')
}

/** Whether the selection targets a tool call (the persisted pre-file shape included). */
function isCallSelection(selection: SelectionTarget | null): selection is CallSelectionTarget {
  return selection !== null && !isFileSelection(selection)
}

function isFileSelection(selection: SelectionTarget | null): selection is FileSelectionTarget {
  return selection !== null && 'kind' in selection && selection.kind === 'file'
}

/** Grammar hint for the file extension; unknown extensions render plain. */
const FILE_LANGS: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json', md: 'markdown',
  css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', sh: 'shellscript', bash: 'shellscript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', rb: 'ruby',
  swift: 'swift', kt: 'kotlin', toml: 'toml', sql: 'sql',
}

function langForPath(path: string): string | undefined {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? ''
  return FILE_LANGS[ext]
}

/** Human-readable byte size for the image read's meta line. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Image read render: the served bytes as a pane-bounded <img> from a data URL,
 * with the byte size and the browser-reported dimensions once the image loads.
 */
function FileImage({ read, path, t }: { read: FileRead; path: string; t: DetailsPanelProps['t'] }) {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const src = `data:${read.imageMediaType};base64,${read.imageData}`
  return (
    <section className={css.section}>
      <div className={css.sectionLabel}>{t('details.file')}</div>
      <img
        className={css.image}
        src={src}
        alt={path}
        onLoad={(event) => {
          const img = event.currentTarget
          setDimensions({ width: img.naturalWidth, height: img.naturalHeight })
        }}
      />
      <div className={css.imageMeta}>
        {formatBytes(read.sizeBytes)}
        {dimensions !== null ? ` · ${dimensions.width} × ${dimensions.height}` : ''}
      </div>
    </section>
  )
}

/** Fetch state of one file read for the viewer branch. */
type FileViewState =
  | { phase: 'loading' }
  | { phase: 'ok'; read: FileRead }
  | { phase: 'failed'; message: string }

export function DetailsPanel({
  useSession, useSessions, sessionId, useStore, renderSlot, closeDetails, readFile, openNative, t,
}: DetailsPanelProps) {
  const selection = useStore(s => s.selection)
  const fileTarget = isFileSelection(selection) ? selection : null
  const callTarget = isCallSelection(selection) ? selection : null
  const callId = callTarget?.callId

  // Session workspace root: an omitted or relative terminal cwd resolves
  // against it, which the pure presenter cannot see.
  const sessionCwd = useSessions(list => list.byId[sessionId]?.cwd)
  const material = useSession(
    s => (callId === undefined ? null : materialFor(s, callId)),
    (a, b) => shallowEqual(a, b))

  // The injected readFile face is fetched through a ref so re-renders never
  // retrigger the fetch; the selection's file path is the only effect key.
  const readFileRef = useRef(readFile)
  useEffect(() => {
    readFileRef.current = readFile
  })
  const [fileState, setFileState] = useState<FileViewState>({ phase: 'loading' })
  // The pane serves the read's own text with file-relative line numbers; the
  // ReadBlock's head/tail collapse shapes long files the same way read cards do.
  const fileLines = useMemo(
    () => (fileState.phase === 'ok' && !fileState.read.binary
      ? fileState.read.content.split('\n').map((text, index) => ({ number: index + 1, text }))
      : []),
    [fileState],
  )
  const filePath = fileTarget?.path
  useEffect(() => {
    if (filePath === undefined) return
    let live = true
    setFileState({ phase: 'loading' })
    void readFileRef.current(filePath).then(
      (read) => { if (live) setFileState({ phase: 'ok', read }) },
      (error: unknown) => {
        if (live) setFileState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { live = false }
  }, [filePath])

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.title}>
          {fileTarget !== null
            ? fileTarget.path.split('/').filter(Boolean).at(-1) ?? fileTarget.path
            : callTarget === null ? t('details.title') : material?.name ?? callTarget.toolName ?? t('details.title')}
        </div>
        <div className={css.actions}>
          {fileTarget !== null && (
            <button
              type="button" className={css.nativeBtn}
              onClick={() => { openNative(fileTarget.path) }}
            >
              {t('details.openNative')}
            </button>
          )}
          <button
            type="button" className={css.close} aria-label={t('details.close')}
            onClick={() => { closeDetails() }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <div className={css.body}>
        {fileTarget !== null ? (
          fileState.phase === 'loading'
            ? <div className={css.empty}>{t('details.fileLoading')}</div>
            : fileState.phase === 'failed'
              ? <div className={css.empty}>{t('details.fileLoadFailed', { message: fileState.message })}</div>
              : fileState.read.binary
                ? fileState.read.imageMediaType !== undefined
                  ? fileState.read.truncated
                    ? <div className={css.empty}>{t('details.fileImageTruncated', { sizeBytes: fileState.read.sizeBytes })}</div>
                    : fileState.read.imageData !== undefined
                      ? (
                        // Keyed by the selected file: the image's onLoad
                        // dimensions and the <img> element are per-file state,
                        // which React would otherwise carry into the next
                        // selection because the panel does not unmount between
                        // files.
                        <Fragment key={fileTarget.path}>
                          <FileImage read={fileState.read} path={fileTarget.path} t={t} />
                        </Fragment>
                      )
                      : <div className={css.empty}>{t('details.fileBinary')}</div>
                  : <div className={css.empty}>{t('details.fileBinary')}</div>
                : fileState.read.content === ''
                  ? <div className={css.empty}>{t('details.fileEmpty')}</div>
                  : (
                    <section className={css.section}>
                      <div className={css.sectionLabel}>{t('details.file')}</div>
                      {fileState.read.truncated && <div className={css.note}>{t('details.fileTruncated')}</div>}
                      <ReadBlock
                        label={fileTarget.path} lines={fileLines} totalLines={fileLines.length}
                        lang={langForPath(filePath ?? '')} maxLines={64}
                      />
                    </section>
                  )
        ) : selection === null || callId === undefined
          ? <div className={css.empty}>{t('details.empty')}</div>
          : material === null
            ? <div className={css.empty}>{t('details.notInWindow')}</div>
            : (
              <>
                {material.argsRaw !== null && (
                  <section className={css.section}>
                    <div className={css.sectionLabel}>{t('details.input')}</div>
                    <CodeBlock code={pretty(material.argsRaw)} lang="json" copyLabel={t('copy')} copiedLabel={t('copied')} />
                  </section>
                )}
                <section className={css.section}>
                  <div className={css.sectionLabel}>{t('details.output')}</div>
                  {/* Keyed by the selected call: the body owns per-call view
                      state (the terminal card's expand and copy), which React
                      would otherwise carry into the next selection because the
                      panel does not unmount between calls. */}
                  <Fragment key={callId}>
                    {renderSlot('conversation.details.tool', { block: material.block, cwd: sessionCwd }, {
                      fallback: 'kind' in material.block
                        ? (
                          <pre className={css.code} data-error={material.block.isError || undefined}>
                            {rawResultText(material.block)}
                          </pre>
                        )
                        : <div className={css.empty}>{t('details.running')}</div>,
                    })}
                  </Fragment>
                </section>
              </>
            )}
      </div>
    </div>
  )
}
