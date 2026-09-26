import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zipSync, strToU8 } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { computeTreeDigest, extractTarArchive, extractZipArchive, sha256Bytes, sha256File, soleFile, UnsafeArchiveError } from '../src/runtime/extract.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function ownedDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `shres-bsk-extract-${prefix}-`))
  cleanup.push(dir)
  return dir
}

/** One raw tar header block, exactly 512 bytes. */
function tarHeader(name: string, typeflag: string, content: Uint8Array, linkname: string): Uint8Array {
  const header = new Uint8Array(512)
  const text = (offset: number, value: string, width: number): void => {
    header.set(new TextEncoder().encode(value.slice(0, width)), offset)
  }
  text(0, name, 100)
  text(100, '0000644', 8)
  text(108, '0000000', 8)
  text(116, '0000000', 8)
  text(124, content.length.toString(8).padStart(11, '0') + ' ', 12)
  text(136, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ', 12)
  header[156] = typeflag.charCodeAt(0)
  text(157, linkname, 100)
  text(257, 'ustar', 6)
  text(263, '00', 2)
  // The checksum field reads as spaces while it is summed, then the
  // six-digit octal sum is stored with the NUL-space suffix.
  header.fill(0x20, 148, 156)
  let checksum = 0
  for (const byte of header) checksum += byte
  text(148, checksum.toString(8).padStart(6, '0') + '\0 ', 8)
  return header
}

/**
 * Craft a tar.gz from raw entries, so hostile entries (symlinks, links,
 * traversing names) exist without needing a tool willing to create them.
 * @param entries - the entries to pack.
 * @returns the gzipped tar bytes.
 */
function craftTarGz(entries: { name: string; typeflag: string; content?: string; linkname?: string }[]): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    const content = new TextEncoder().encode(entry.content ?? '')
    chunks.push(tarHeader(entry.name, entry.typeflag, content, entry.linkname ?? ''))
    const padding = (512 - (content.length % 512)) % 512
    chunks.push(content)
    chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(1024))
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const raw = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    raw.set(chunk, offset)
    offset += chunk.length
  }
  return gzipSync(raw)
}

describe('zip extraction', () => {
  it('extracts regular files and directories from a benign archive', async () => {
    const dir = await ownedDir('ok')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const zip = zipSync({
      'manifest.json': strToU8('{"name":"x"}'),
      'icons/': new Uint8Array(0),
      'icons/main.png': strToU8('png-bytes'),
    })
    const result = await extractZipArchive(zip, dest, 1 << 20)
    expect([...result.files].sort()).toEqual(['icons/main.png', 'manifest.json'])
    expect(await readFile(join(dest, 'manifest.json'), 'utf8')).toBe('{"name":"x"}')
    expect((await stat(join(dest, 'icons/main.png'))).isFile()).toBe(true)
  })

  it('refuses absolute and parent-traversing entry names', async () => {
    const dir = await ownedDir('names')
    const dest = join(dir, 'out')
    await mkdir(dest)
    await expect(extractZipArchive(zipSync({ '/abs.txt': strToU8('x') }), dest, 1 << 20)).rejects.toBeInstanceOf(UnsafeArchiveError)
    await expect(extractZipArchive(zipSync({ '../escape.txt': strToU8('x') }), dest, 1 << 20)).rejects.toBeInstanceOf(UnsafeArchiveError)
    await expect(extractZipArchive(zipSync({ 'a/../../escape.txt': strToU8('x') }), dest, 1 << 20)).rejects.toBeInstanceOf(UnsafeArchiveError)
    await expect(extractZipArchive(zipSync({ 'back\\slash.txt': strToU8('x') }), dest, 1 << 20)).rejects.toBeInstanceOf(UnsafeArchiveError)
    await expect(extractZipArchive(zipSync({ ['long.txt'.padEnd(300, 'a')]: strToU8('x') }), dest, 1 << 20)).rejects.toBeInstanceOf(UnsafeArchiveError)
    // Nothing was written by any refused archive.
    expect(await readdir(dest)).toEqual([])
  })

  it('refuses entries resolving at the target root', async () => {
    const dir = await ownedDir('zip-root')
    const dest = join(dir, 'out')
    await mkdir(dest)
    // A '.' or './' entry resolves at the root itself: allowed only for a
    // tar directory entry, never for a zip file entry.
    await expect(extractZipArchive(zipSync({ '.': strToU8('x') }), dest, 1 << 20)).rejects.toThrow(/at or outside the target root/)
    await expect(extractZipArchive(zipSync({ './': strToU8('x') }), dest, 1 << 20)).rejects.toThrow(/at or outside the target root/)
    expect(await readdir(dest)).toEqual([])
  })

  it('refuses archives that expand past the byte bound', async () => {
    const dir = await ownedDir('bound')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const zip = zipSync({ 'big.bin': strToU8('a'.repeat(1000)) })
    await expect(extractZipArchive(zip, dest, 100)).rejects.toThrow(/expands past/)
  })

  it('never creates symlinks: every entry lands as a regular file', async () => {
    const dir = await ownedDir('symlink')
    const dest = join(dir, 'out')
    await mkdir(dest)
    // fflate exposes no file attributes, so a symlink HEADER cannot be
    // refused; the guarantee under test is that the written entry is a
    // REGULAR FILE pointing nowhere.
    const zip = zipSync({ 'looks-like-link': strToU8('/etc/passwd') })
    await extractZipArchive(zip, dest, 1 << 20)
    expect((await stat(join(dest, 'looks-like-link'))).isSymbolicLink()).toBe(false)
    expect((await stat(join(dest, 'looks-like-link'))).isFile()).toBe(true)
  })

  it('refuses a duplicate entry name', async () => {
    const dir = await ownedDir('duplicate')
    const dest = join(dir, 'out')
    await mkdir(dest)
    // A crafted zip: the second entry's name is rewritten, in place, to
    // duplicate the first, which no constructor of archives would emit.
    const zip = zipSync({ 'aaa.txt': strToU8('first'), 'bbb.txt': strToU8('second') })
    const patched = new Uint8Array(zip)
    const needle = new TextEncoder().encode('bbb.txt')
    const replacement = new TextEncoder().encode('aaa.txt')
    for (let i = 0; i + needle.length <= patched.length; i++) {
      let matched = true
      for (let j = 0; j < needle.length; j++) {
        if (patched[i + j] !== needle[j]) {
          matched = false
          break
        }
      }
      if (matched) patched.set(replacement, i)
    }
    await expect(extractZipArchive(patched, dest, 1 << 20)).rejects.toThrow(/duplicate entry refused/)
    expect(await readdir(dest)).toEqual([])
  })
})

describe('tar extraction', () => {
  it('extracts a regular file from a benign archive', async () => {
    const { create } = await import('tar')
    const dir = await ownedDir('tar-ok')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const payload = join(dir, 'payload')
    await writeFile(payload, 'binary-goes-here')
    const archive = join(dir, 'payload.tar.gz')
    await create({ gzip: true, file: archive, cwd: dir }, ['payload'])
    const result = await extractTarArchive(archive, dest, 1 << 20)
    expect(result.files).toEqual(['payload'])
    expect(await readFile(join(dest, 'payload'), 'utf8')).toBe('binary-goes-here')
    expect(soleFile(result.files)).toBe('payload')
  })

  it('refuses a symlink entry', async () => {
    const dir = await ownedDir('tar-symlink')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const archive = join(dir, 'link.tar.gz')
    await writeFile(archive, craftTarGz([{ name: 'evil-link', typeflag: '2', linkname: '/etc/passwd' }]))
    await expect(extractTarArchive(archive, dest, 1 << 20)).rejects.toThrow(/non-regular tar entry refused \(SymbolicLink\)/)
    expect(await readdir(dest)).toEqual([])
  })

  it('refuses a hard-link entry', async () => {
    const dir = await ownedDir('tar-hardlink')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const archive = join(dir, 'hard.tar.gz')
    await writeFile(archive, craftTarGz([{ name: 'evil-hard', typeflag: '1', linkname: 'real.txt' }]))
    await expect(extractTarArchive(archive, dest, 1 << 20)).rejects.toThrow(/non-regular tar entry refused \(Link\)/)
    expect(await readdir(dest)).toEqual([])
  })

  it('refuses parent-traversing entry paths', async () => {
    const dir = await ownedDir('tar-traverse')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const archive = join(dir, 'traverse.tar.gz')
    await writeFile(archive, craftTarGz([{ name: '../../escape.txt', typeflag: '0', content: 'gotcha' }]))
    await expect(extractTarArchive(archive, dest, 1 << 20)).rejects.toBeInstanceOf(UnsafeArchiveError)
    expect(await readdir(dest)).toEqual([])
  })

  it('accepts a directory entry resolving at the target root (./)', async () => {
    const dir = await ownedDir('tar-root-dir')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const archive = join(dir, 'root.tar.gz')
    await writeFile(archive, craftTarGz([
      { name: './', typeflag: '5' },
      { name: 'file.txt', typeflag: '0', content: 'rooted' },
    ]))
    const result = await extractTarArchive(archive, dest, 1 << 20)
    expect(result.files).toEqual(['file.txt'])
    expect(await readFile(join(dest, 'file.txt'), 'utf8')).toBe('rooted')
  })

  it('refuses a file entry claiming the extraction root', async () => {
    const dir = await ownedDir('tar-root-file')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const archive = join(dir, 'root-file.tar.gz')
    await writeFile(archive, craftTarGz([{ name: '.', typeflag: '0', content: 'gotcha' }]))
    await expect(extractTarArchive(archive, dest, 1 << 20)).rejects.toThrow(/escaped or replaced the target/)
    expect(await readdir(dest)).toEqual([])
  })

  it('refuses an entry once the extracted total passes the bound, before writing it', async () => {
    const dir = await ownedDir('tar-bound')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const archive = join(dir, 'bound.tar.gz')
    await writeFile(archive, craftTarGz([{ name: 'big.bin', typeflag: '0', content: 'a'.repeat(1000) }]))
    await expect(extractTarArchive(archive, dest, 100)).rejects.toThrow(/expands past/)
    expect(await readdir(dest)).toEqual([])
  })

  it('creates benign directory entries alongside their files', async () => {
    const dir = await ownedDir('tar-dirs')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const archive = join(dir, 'dirs.tar.gz')
    await writeFile(archive, craftTarGz([
      { name: 'sub', typeflag: '5' },
      { name: 'sub/file.txt', typeflag: '0', content: 'nested' },
    ]))
    const result = await extractTarArchive(archive, dest, 1 << 20)
    expect(result.files).toEqual(['sub/file.txt'])
    expect(await readFile(join(dest, 'sub/file.txt'), 'utf8')).toBe('nested')
  })

  it('refuses a character device entry', async () => {
    const dir = await ownedDir('tar-dev')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const archive = join(dir, 'dev.tar.gz')
    await writeFile(archive, craftTarGz([{ name: 'the-device', typeflag: '3' }]))
    await expect(extractTarArchive(archive, dest, 1 << 20)).rejects.toThrow(/non-regular tar entry refused \(CharacterDevice\)/)
    expect(await readdir(dest)).toEqual([])
  })
})

describe('tree digest', () => {
  it('is order-independent and content-sensitive', async () => {
    const dirA = await ownedDir('tree-a')
    const dirB = await ownedDir('tree-b')
    // Same files, created in reverse lexical order, in different roots.
    for (const [name, content] of [['c.txt', 'third'], ['assets/app.js', 'second'], ['manifest.json', 'first']] as const) {
      await mkdir(join(dirA, name, '..'), { recursive: true })
      await writeFile(join(dirA, name), content)
    }
    for (const [name, content] of [['manifest.json', 'first'], ['assets/app.js', 'second'], ['c.txt', 'third']] as const) {
      await mkdir(join(dirB, name, '..'), { recursive: true })
      await writeFile(join(dirB, name), content)
    }
    const digestA = await computeTreeDigest(dirA)
    expect(digestA).toBe(await computeTreeDigest(dirB))
    await writeFile(join(dirB, 'c.txt'), 'mutated')
    expect(await computeTreeDigest(dirB)).not.toBe(digestA)
  })

  it('refuses a symbolic link inside the tree', async () => {
    const dir = await ownedDir('tree-link')
    await writeFile(join(dir, 'real.txt'), 'bytes')
    await symlink('/etc/passwd', join(dir, 'planted'))
    await expect(computeTreeDigest(dir)).rejects.toThrow(/symbolic link refused.*planted/)
  })

  it('refuses a special file inside the tree', async () => {
    const dir = await ownedDir('tree-fifo')
    const { spawnSync } = await import('node:child_process')
    const fifo = join(dir, 'the-fifo')
    const made = spawnSync('mkfifo', [fifo])
    if (made.status !== 0) throw new Error('mkfifo unavailable on this host')
    await expect(computeTreeDigest(dir)).rejects.toThrow(/special file refused/)
  })
})

describe('hashing', () => {
  it('locates the sole file and refuses an archive with any other count', () => {
    expect(soleFile(['only.bin'])).toBe('only.bin')
    expect(() => soleFile([])).toThrow(/exactly one file in the CLI archive, got 0/)
    expect(() => soleFile(['a.bin', 'b.bin'])).toThrow(/got 2/)
  })

  it('hashes bytes and files identically', async () => {
    const dir = await ownedDir('hash')
    const file = join(dir, 'data.bin')
    const bytes = new TextEncoder().encode('deterministic content')
    await writeFile(file, bytes)
    expect(await sha256File(file)).toBe(sha256Bytes(bytes))
  })
})
