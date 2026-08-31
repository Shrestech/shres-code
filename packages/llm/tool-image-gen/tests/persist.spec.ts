/**
 * Generated-image persistence: a deterministic image-N.jpg workspace file
 * published with an atomic temp+rename, the same bytes written to the
 * attachments store when one is mounted (attachment before file, so an
 * attachment failure leaves no on-disk image), and the next-name scan that
 * skips non-image and already-counted entries.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId } from '@shres-code/shres-code-attachment'
import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@shres-code/shres-code-attachment'
import { persistGeneratedImage } from '../src/index.ts'

/** A minimal attachment store stub that records every save. */
function fakeStore(saves: SaveImageAttachment[]): { store: AttachmentStore; ref: ImageAttachmentRef } {
  const ref = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/jpeg' as const, bytes: 0, width: 0, height: 0 }
  return {
    ref,
    store: {
      saveImage: async (input: SaveImageAttachment) => {
        saves.push(input)
        return { ...ref, bytes: input.data.byteLength }
      },
    } as unknown as AttachmentStore,
  }
}

describe('persistGeneratedImage', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tool-image-gen-persist-'))
    dirs.push(dir)
    return dir
  }

  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])

  it('writes deterministic numbered workspace files from an empty directory', async () => {
    const dir = await tempDir()
    const first = await persistGeneratedImage(null, bytes, 'image/jpeg', dir)
    const second = await persistGeneratedImage(null, bytes, 'image/jpeg', dir)
    expect(first.filePath).toBe(join(dir, 'image-1.jpg'))
    expect(second.filePath).toBe(join(dir, 'image-2.jpg'))
    expect(await readFile(first.filePath)).toEqual(Buffer.from(bytes))
    expect(await readFile(second.filePath)).toEqual(Buffer.from(bytes))
  })

  it('skips non-image entries and continues past an existing higher number', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'notes.txt'), 'not an image')
    await writeFile(join(dir, 'image-2.jpg'), Buffer.from(bytes))
    const output = await persistGeneratedImage(null, bytes, 'image/jpeg', dir)
    expect(output.filePath).toBe(join(dir, 'image-3.jpg'))
    expect(await readFile(join(dir, 'image-2.jpg'))).toEqual(Buffer.from(bytes))
  })

  it('commits the attachment before writing the file and reports the id', async () => {
    const dir = await tempDir()
    const saves: SaveImageAttachment[] = []
    const { store, ref } = fakeStore(saves)
    const output = await persistGeneratedImage(store, bytes, 'image/jpeg', dir)
    expect(output.filePath).toBe(join(dir, 'image-1.jpg'))
    expect(output.attachmentId).toBe(ref.attachmentId)
    expect(saves).toHaveLength(1)
    expect(saves[0]!.data).toEqual(bytes)
    expect(saves[0]!.mediaType).toBe('image/jpeg')
    expect(saves[0]!.name).toBe('image-1.jpg')
    expect(existsSync(join(dir, 'image-1.jpg'))).toBe(true)
  })

  it('returns a null attachment id when no store is mounted', async () => {
    const dir = await tempDir()
    const output = await persistGeneratedImage(null, bytes, 'image/jpeg', dir)
    expect(output.attachmentId).toBeNull()
    expect(output.filePath).toBe(join(dir, 'image-1.jpg'))
  })

  it('writes no file when the attachment save fails', async () => {
    const dir = await tempDir()
    const failing: AttachmentStore = {
      saveImage: async () => { throw new Error('storage full') },
    } as unknown as AttachmentStore
    await expect(persistGeneratedImage(failing, bytes, 'image/jpeg', dir)).rejects.toThrow('storage full')
    expect(existsSync(join(dir, 'image-1.jpg'))).toBe(false)
  })
})
