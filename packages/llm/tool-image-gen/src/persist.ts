/**
 * Persistence for a generated image: a deterministic workspace file plus an
 * optional durable attachment reference. The file is published with an atomic
 * temp-file + fsync + rename so a crash or a concurrent writer can never leave
 * a partial image under a numeric name, and the attachment is committed before
 * the file so an attachment failure leaves no on-disk image the call reports
 * as failed. The file name is a session-agnostic counter within the configured
 * output directory (image-1.jpg, image-2.jpg, ...), so replays of the same
 * directory assign the same names.
 * @module @shres-code/shres-code-tool-image-gen/persist
 */

import { mkdir, open, readdir, rename } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { AttachmentStore, ImageMediaType } from '@shres-code/shres-code-attachment'

/** Where a generated image was recorded. */
export interface GeneratedImageOutput {
  /** Absolute path of the written workspace file. */
  filePath: string
  /** Durable attachment id, or null when no attachment store is mounted. */
  attachmentId: string | null
  /** Media type the bytes were declared as. */
  mediaType: ImageMediaType
}

/** The deterministic file-name pattern the writer assigns. */
const IMAGE_FILE_PATTERN = /^image-(\d+)\.jpg$/u

/**
 * The next image file name in a directory: one greater than the largest
 * existing image-N.jpg suffix, so consecutive saves are deterministic and never
 * overwrite a prior generation.
 * @param entries - directory entries already present.
 * @returns the next `image-N.jpg` name.
 */
function nextImageName(entries: readonly string[]): string {
  let max = 0
  for (const entry of entries) {
    const match = IMAGE_FILE_PATTERN.exec(entry)
    // The digit pattern guarantees a bounded integer, so no overflow guard is needed.
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return `image-${max + 1}.jpg`
}

/**
 * Publish image bytes under a name in a directory, crash-safely: write a
 * uniquely named dot temp with exclusive create (`wx`, so concurrent writers
 * across processes never share an in-flight file), fsync it, then atomically
 * rename it onto the target. The dot-prefixed temp is invisible to the
 * nextImageName scan, so an aborted publish cannot be mistaken for a completed
 * image; a failed publish may leave that uniquely named temp, which a later
 * pass simply skips (last-writer-wins on the final rename). Within-process
 * exclusivity holds because the loop never assigns the same name twice.
 * @param directory - the output directory (already created).
 * @param name - the image-N.jpg name to publish under.
 * @param data - the image bytes to persist.
 * @returns the absolute path of the published file.
 */
async function writeAtomicImage(directory: string, name: string, data: Uint8Array): Promise<string> {
  const target = join(directory, name)
  const temp = join(directory, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, target)
  return target
}

/**
 * Persist decoded image bytes to the attachments service (when mounted) and,
 * only after that succeeds, to a deterministic workspace file under the output
 * directory. A missing attachment store degrades to the file-only result so a
 * headless composition still delivers the image.
 * @param store - the mounted attachment store, or null to skip the attachment.
 * @param data - the decoded image bytes.
 * @param mediaType - the image media type to declare.
 * @param outputDirectory - the directory to write the file into (created if absent).
 * @returns the saved file path and the attachment id (or null).
 */
export async function persistGeneratedImage(
  store: AttachmentStore | null,
  data: Uint8Array,
  mediaType: ImageMediaType,
  outputDirectory: string,
): Promise<GeneratedImageOutput> {
  await mkdir(outputDirectory, { recursive: true })
  const name = nextImageName(await readdir(outputDirectory))
  let attachmentId: string | null = null
  if (store !== null) {
    const ref = await store.saveImage({ data, mediaType, name })
    attachmentId = ref.attachmentId
  }
  const filePath = await writeAtomicImage(outputDirectory, name, data)
  return { filePath, attachmentId, mediaType }
}
