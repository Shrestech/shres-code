/**
 * Wire-form image admission and the abstract store's batch validation:
 * canonical base64, count/byte/type limits, and the default request-image
 * refusal when a provider does not project.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import {
  admitEncodedImages,
  AttachmentError,
  AttachmentId,
  AttachmentStore,
  isImageAdmissionError,
} from '../src/index.ts'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '../src/index.ts'

const PNG = 'image/png' as const

/** In-memory store that uses the abstract batch/save path, not a local override. */
class MemoryStore extends AttachmentStore {
  override readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 64,
    maxImagesPerMessage: 2,
    maxMessageImageBytes: 64,
    maxImagePixels: 100,
    maxImageDimension: 10,
    mediaTypes: [PNG],
  }

  readonly saved: SaveImageAttachment[] = []

  override validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  override saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    return Promise.resolve({
      attachmentId: AttachmentId(`mem-${String(this.saved.length)}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    })
  }

  override readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref, data: new Uint8Array() })
  }
}

function pngPayload(bytes = Uint8Array.of(1, 2, 3)): string {
  return Buffer.from(bytes).toString('base64')
}

describe('admitEncodedImages', () => {
  it('decodes canonical base64, preserves an optional name, and commits through the store', async () => {
    const store = new MemoryStore(new Context())
    const named = await admitEncodedImages(store, [
      { mediaType: PNG, data: pngPayload(), name: 'shot.png' },
    ])
    expect(named).toHaveLength(1)
    expect(named[0]?.name).toBe('shot.png')
    expect(store.saved[0]?.data).toEqual(Uint8Array.of(1, 2, 3))

    const anonymous = await admitEncodedImages(store, [
      { mediaType: PNG, data: pngPayload(Uint8Array.of(4)) },
    ])
    expect(anonymous[0]?.name).toBeUndefined()
  })

  it('rejects empty and non-canonical base64 before any store write', async () => {
    const store = new MemoryStore(new Context())
    await expect(admitEncodedImages(store, [{ mediaType: PNG, data: '' }]))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE_BASE64' })
    await expect(admitEncodedImages(store, [{ mediaType: PNG, data: 'aGk' }]))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE_BASE64' })
    expect(store.saved).toEqual([])
  })
})

describe('isImageAdmissionError', () => {
  it('accepts admission codes and rejects storage faults and non-errors', () => {
    expect(isImageAdmissionError(new AttachmentError('too many', 'TOO_MANY_IMAGES'))).toBe(true)
    expect(isImageAdmissionError(new AttachmentError('missing', 'ATTACHMENT_NOT_FOUND'))).toBe(false)
    expect(isImageAdmissionError(new Error('plain'))).toBe(false)
    expect(isImageAdmissionError({ code: 'TOO_MANY_IMAGES' })).toBe(false)
  })
})

describe('AttachmentStore batch validation and default projection', () => {
  it('refuses an oversized count, oversized bytes, and an unsupported type', async () => {
    const store = new MemoryStore(new Context())
    const one = { data: Uint8Array.of(1), mediaType: PNG }
    await expect(store.saveImages([one, one, one]))
      .rejects.toMatchObject({ code: 'TOO_MANY_IMAGES' })
    await expect(store.saveImages([{ data: new Uint8Array(65), mediaType: PNG }]))
      .rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' })
    await expect(store.saveImages([{ data: Uint8Array.of(1), mediaType: 'image/jpeg' }]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE_TYPE' })
  })

  it('commits a valid batch in order through saveImage', async () => {
    const store = new MemoryStore(new Context())
    const refs = await store.saveImages([
      { data: Uint8Array.of(1), mediaType: PNG },
      { data: Uint8Array.of(2), mediaType: PNG },
    ])
    expect(refs.map(ref => ref.bytes)).toEqual([1, 1])
    expect(store.saved.map(item => [...item.data])).toEqual([[1], [2]])
  })

  it('refuses request-image projection and honors an already-aborted signal', async () => {
    const store = new MemoryStore(new Context())
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId('x'),
      mediaType: PNG,
      bytes: 1,
      width: 1,
      height: 1,
    }
    const policy = { maxPixels: 4, maxBytes: 16 }
    await expect(store.readImageRequest(ref, policy))
      .rejects.toMatchObject({ code: 'ATTACHMENT_PROJECTION_UNSUPPORTED' })
    const signal = AbortSignal.abort(new Error('cancelled'))
    expect(() => store.readImageRequest(ref, policy, signal)).toThrow('cancelled')
  })
})
