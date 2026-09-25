/**
 * Verified provisioning and launch verification of the pinned release
 * artifacts into the owned root: platform and Chrome checks first
 * (unsupported, missing, or too-old setups refuse before any download), then
 * bounded downloads whose bytes are hash-pinned in source, extraction only
 * after verification, and publication into the artifact tree. The extension
 * loads from the fixed path `<root>/artifacts/extension`; the verified
 * archive stays at `<root>/artifacts/extension.zip` as the only repair
 * source. All staging lives under the owned root on one filesystem, so
 * publication is a same-device rename. Nothing here spawns the daemon or the
 * browser.
 *
 * The division between the two entry points is a security division:
 * `provisionArtifacts` runs under download consent and may fetch the pinned
 * assets; `ensureLaunchArtifacts` runs before every Chrome launch, never
 * fetches, and repairs the extension tree only from the retained archive
 * after re-hashing it against the pin — a missing or mismatched retained
 * archive refuses the launch instead of downloading. A crash between the two
 * publication renames can leave the fixed path missing; the next launch
 * verification repairs it before Chrome loads anything. Neither function
 * publishes more than one artifact atomically: each directory swap is a
 * rename pair with the documented crash gap, not a multi-artifact
 * transaction.
 *
 * @module @shres-code/shres-code-browserskill/runtime/provision
 */

import { createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { writeFileAtomic } from '@shres-code/shres-code-atomic-write'
import {
  BSK_PLATFORM_PIN,
  BSK_VERSION,
  CHROME_MINIMUM_MAJOR,
  EXTENSION_ASSET,
  EXTENSION_TREE_SHA256,
  EXTENSION_VERSION,
  bskArchiveUrl,
  extensionArchiveUrl,
  platformPin,
} from './manifest.ts'
import { ArtifactTreeError, computeTreeDigest, extractTarArchive, extractZipArchive, sha256Bytes, sha256File, soleFile } from './extract.ts'
import type { ResolvedBrowserSkillConfig } from '../config.ts'
import type { BrowserSkillRefusal } from '../types.ts'

/** Provisioning or launch verification refused; the reason is user-displayable. */
export class ProvisionRefusedError extends Error {
  constructor(readonly refusal: BrowserSkillRefusal) {
    super(`browserskill provision refused: ${refusal.kind}`)
    this.name = 'ProvisionRefusedError'
  }
}

/** The durable record of what provisioning published. */
export interface ProvisionedState {
  /** Record format version; bumped only on an incompatible change. */
  version: 1
  bsk: {
    /** Pinned CLI version. */
    version: string
    /** Absolute executable path inside the owned root. */
    executablePath: string
    /** SHA-256 of the executable, rechecked before every spawn. */
    binarySha256: string
    /** SHA-256 of the downloaded archive. */
    archiveSha256: string
  }
  extension: {
    /** Pinned extension version. */
    version: string
    /** Absolute unpacked directory inside the owned root; the fixed load path. */
    dir: string
    /** SHA-256 of the downloaded zip. */
    archiveSha256: string
    /** Tree digest receipt; {@link EXTENSION_TREE_SHA256} is the trust anchor. */
    treeDigest: string
  }
}

/**
 * The integrity pins one provisioning or verification run is measured
 * against, resolved from the manifest for production. The optional seam
 * exists so tests can run the full flows against fixture bytes; the
 * supervisor always uses the manifest resolution.
 */
export interface ArtifactPins {
  /** SHA-256 of the pinned CLI archive. */
  bskArchiveSha256: string
  /** SHA-256 of the extracted executable. */
  bskBinarySha256: string
  /** SHA-256 of the pinned extension zip. */
  extensionArchiveSha256: string
  /** Tree digest of the unpacked extension. */
  extensionTreeDigest: string
}

/**
 * The manifest pins for the running process.
 * @returns the pins recorded from measured release evidence.
 */
export function manifestArtifactPins(): ArtifactPins {
  return {
    bskArchiveSha256: BSK_PLATFORM_PIN.archiveSha256,
    bskBinarySha256: BSK_PLATFORM_PIN.binarySha256,
    extensionArchiveSha256: EXTENSION_ASSET.sha256,
    extensionTreeDigest: EXTENSION_TREE_SHA256,
  }
}

/** Validate persisted provisioning state at the durable boundary. Records
 * from before the tree-digest receipt are refused: they name artifacts that
 * were never verified as a tree, so they provision again instead of loading. */
function parseProvisionedState(raw: unknown): ProvisionedState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const wire = raw as Record<string, unknown>
  if (wire.version !== 1 || typeof wire.bsk !== 'object' || wire.bsk === null || typeof wire.extension !== 'object' || wire.extension === null) {
    return undefined
  }
  const bsk = wire.bsk as Record<string, unknown>
  const extension = wire.extension as Record<string, unknown>
  if (
    typeof bsk.version !== 'string' || typeof bsk.executablePath !== 'string' ||
    typeof bsk.binarySha256 !== 'string' || typeof bsk.archiveSha256 !== 'string' ||
    typeof extension.version !== 'string' || typeof extension.dir !== 'string' ||
    typeof extension.archiveSha256 !== 'string' || typeof extension.treeDigest !== 'string'
  ) {
    return undefined
  }
  return {
    version: 1,
    bsk: { version: bsk.version, executablePath: bsk.executablePath, binarySha256: bsk.binarySha256, archiveSha256: bsk.archiveSha256 },
    extension: { version: extension.version, dir: extension.dir, archiveSha256: extension.archiveSha256, treeDigest: extension.treeDigest },
  }
}

/** Paths of the provisioned artifacts under the owned root. The extension
 * path is fixed — Chrome loads exactly `<root>/artifacts/extension` — and
 * the retained archive beside it is the only source a launch repair trusts.
 * @param root - owned runtime root.
 * @returns executable, extension, retained archive, and state-record locations.
 */
export function artifactPaths(root: string): { bskExecutable: string; extensionDir: string; extensionArchive: string; stateFile: string } {
  return {
    bskExecutable: join(root, 'artifacts', `bsk-v${BSK_VERSION}`, 'bsk'),
    extensionDir: join(root, 'artifacts', 'extension'),
    extensionArchive: join(root, 'artifacts', 'extension.zip'),
    stateFile: join(root, 'artifacts', 'state.json'),
  }
}

/** Every staging directory under the owned root carries this prefix, so residue
 * from a crashed run is recognizable without trusting directory contents. */
const STAGING_PREFIX = 'staging-'

/**
 * Read the durable provisioning record.
 * @param root - the owned runtime root.
 * @returns the record, or `undefined` when absent, malformed, or missing the integrity receipts.
 */
export async function readProvisionedState(root: string): Promise<ProvisionedState | undefined> {
  try {
    return parseProvisionedState(JSON.parse(await readFile(artifactPaths(root).stateFile, 'utf8')))
  } catch {
    return undefined
  }
}

/** The evaluation of an installed Chrome against the pinned requirement. */
export type ChromeEvaluation =
  | { kind: 'ok'; version: string }
  | { kind: 'refusal'; refusal: BrowserSkillRefusal }

/**
 * Evaluate a Chrome Info.plist's content against the pinned requirement:
 * the bundle version must be present and at least the pinned minimum.
 * @param infoPlist - the plist content of an installed Chrome bundle.
 * @returns the version, or the user-displayable refusal.
 */
export function evaluateInstalledChrome(infoPlist: string): ChromeEvaluation {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(infoPlist)
  const version = match?.[1]
  if (version === undefined) {
    return { kind: 'refusal', refusal: { kind: 'chrome-missing', detail: 'installed Chrome version could not be read from its bundle metadata' } }
  }
  const major = Number.parseInt(version, 10)
  if (!Number.isInteger(major) || major < CHROME_MINIMUM_MAJOR) {
    return { kind: 'refusal', refusal: { kind: 'chrome-too-old', detail: `Chrome ${version} is older than the ${CHROME_MINIMUM_MAJOR} the extension requires` } }
  }
  return { kind: 'ok', version }
}

/**
 * Detect the installed Chrome on the measured platform from its bundle
 * metadata.
 * @returns the executable path and its version string.
 * @throws ProvisionRefusedError with `chrome-missing` or `chrome-too-old`.
 */
export async function detectInstalledChrome(): Promise<{ executablePath: string; version: string }> {
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  let infoPlist: string
  try {
    infoPlist = await readFile('/Applications/Google Chrome.app/Contents/Info.plist', 'utf8')
  } catch {
    throw new ProvisionRefusedError({ kind: 'chrome-missing', detail: 'Google Chrome is not installed at /Applications' })
  }
  const evaluation = evaluateInstalledChrome(infoPlist)
  if (evaluation.kind === 'refusal') throw new ProvisionRefusedError(evaluation.refusal)
  return { executablePath, version: evaluation.version }
}

/**
 * Run the preflight checks every open depends on, in disclosure order:
 * platform pin first, then the installed Chrome.
 * @returns the pinned platform and the detected Chrome.
 * @throws ProvisionRefusedError before any download when unsupported.
 */
export async function preflight(): Promise<{ executablePath: string; chromeVersion: string }> {
  if (platformPin() === undefined) {
    throw unsupportedPlatform()
  }
  const chrome = await detectInstalledChrome()
  return { executablePath: chrome.executablePath, chromeVersion: chrome.version }
}

function unsupportedPlatform(): ProvisionRefusedError {
  return new ProvisionRefusedError({
    kind: 'unsupported-platform',
    detail: `BrowserSkill managed provisioning is measured on ${BSK_PLATFORM_PIN.platform} only; ${process.platform}-${process.arch} has no pinned release`,
  })
}

/** The download fetch, injectable for tests. */
export type DownloadFetch = (url: URL, init?: { signal?: AbortSignal }) => Promise<Response>

/**
 * Read a file's bytes, or `undefined` when the file is absent. Any other
 * read failure propagates: only existence is folded into the caller's
 * refusal.
 * @param path - file to read.
 * @returns the file's bytes, or `undefined` when it does not exist.
 */
async function readFileOrMissing(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * SHA-256 of a file's bytes, or the `missing` sentinel when the file is
 * absent. Any other read failure propagates: only existence is folded into
 * the refusal value.
 * @param path - file to hash.
 * @returns the lowercase hex digest, or `'missing'`.
 */
async function sha256OrMissing(path: string): Promise<string> {
  try {
    return await sha256File(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

/**
 * Download one pinned artifact to `destFile` under hard bounds: the fetch
 * runs under the download deadline, a declared Content-Length over the bound
 * refuses before the body is read, and streamed bytes are counted as they
 * arrive — the transfer is torn down the moment the count passes the bound,
 * so an absent or lying Content-Length cannot grow the staged file past it.
 * The staged bytes must hash to the pin; a failed check removes the staged
 * file.
 * @param url - the exact URL to fetch.
 * @param destFile - staging file path, created exclusively.
 * @param expectedSha256 - the pin the bytes must hash to.
 * @param artifact - which artifact the hash pin protects, for the refusal.
 * @param options - config bounds, the fetch implementation, and a caller abort.
 * @returns the staged file's hash, equal to the pin.
 * @throws ProvisionRefusedError on download, bound, deadline, abort, or hash failure.
 */
export async function downloadVerified(
  url: URL,
  destFile: string,
  expectedSha256: string,
  artifact: 'bsk' | 'extension',
  options: { config: ResolvedBrowserSkillConfig; fetchImpl?: DownloadFetch; signal?: AbortSignal },
): Promise<string> {
  const { config } = options
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error('download timed out'))
  }, config.downloadTimeoutMs)
  const onCallerAbort = () => {
    controller.abort(options.signal?.reason)
  }
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const fetchImpl = options.fetchImpl ?? (async (u: URL, init?: { signal?: AbortSignal }) => fetch(u, init))
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok || response.body === null) {
      throw new Error(`answered ${response.status}`)
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && Number.parseInt(declared, 10) > config.maxDownloadBytes) {
      throw new Error(`declares ${declared} bytes, over the ${config.maxDownloadBytes} bound`)
    }
    let received = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        received += chunk.byteLength
        if (received > config.maxDownloadBytes) {
          callback(new Error(`streamed past the ${config.maxDownloadBytes} byte bound`))
          return
        }
        callback(null, chunk)
      },
    })
    // Pipeline teardown cancels the response body on the counter error, so a
    // hostile source stops being read the moment the bound is crossed.
    await pipeline(response.body, counter, createWriteStream(destFile, { mode: 0o600, flags: 'wx' }))
  } catch (error) {
    await rm(destFile, { force: true })
    throw new ProvisionRefusedError({ kind: 'download-failed', detail: `${url.href} failed: ${error instanceof Error ? error.message : String(error)}` })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCallerAbort)
  }
  // The staged file holds exactly the counted bytes: the streaming counter
  // is the byte bound, so no post-hoc size check is needed.
  const sha256 = await sha256File(destFile)
  if (sha256 !== expectedSha256) {
    await rm(destFile, { force: true })
    throw new ProvisionRefusedError({ kind: 'hash-mismatch', artifact, expected: expectedSha256, actual: sha256 })
  }
  return sha256
}

/**
 * Remove crashed runs' staging directories under the artifacts directory.
 * The caller must hold the root lease: this mutates the tree. Entries are
 * classified with `lstat` and a planted symlink is unlinked as a link,
 * never descended into. Removal is best effort — a stuck entry refuses the
 * next verification anyway, so it is never worth failing the run for.
 * @param root - the owned runtime root.
 */
async function cleanStagingResidue(root: string): Promise<void> {
  const artifactsDir = join(root, 'artifacts')
  const names = await readdir(artifactsDir)
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    const target = join(artifactsDir, name)
    try {
      const stats = await lstat(target)
      if (stats.isDirectory()) {
        await rm(target, { recursive: true, force: true })
      } else {
        await rm(target, { force: true })
      }
    } catch {
      // The entry vanished or could not be stat'ed; nothing else can reach a
      // staging leftover, and the next verification re-checks the tree.
    }
  }
}

/**
 * Publish a verified tree at the fixed load path. The current tree — or the
 * symlink planted in its place — is retired into staging and the staged tree
 * is renamed in. A crash between the renames leaves the fixed path missing,
 * which the next launch verification repairs from the retained archive; if
 * the second rename fails in-process, the retired tree is restored.
 * @param stagedTree - the verified staging tree to publish.
 * @param fixedDir - the fixed load path.
 * @param staging - the staging directory holding `stagedTree` and the retired tree.
 */
async function swapTree(stagedTree: string, fixedDir: string, staging: string): Promise<void> {
  const retired = join(staging, 'retired')
  let retiredOld = false
  try {
    await rename(fixedDir, retired)
    retiredOld = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await rename(stagedTree, fixedDir)
  } catch (error) {
    if (retiredOld) await rename(retired, fixedDir).catch(() => undefined)
    throw error
  }
}

/** The tree-verification outcome: the digest, or why the tree is unverified. */
interface TreeVerification {
  /** Whether the tree's digest equals the pin. */
  ok: boolean
  /** The computed digest, or the reason no digest could be computed. */
  actual: string
}

/**
 * Verify the unpacked extension tree against the pin without following a
 * symlink planted at the load path itself.
 * @param extensionDir - the fixed load path.
 * @param expectedTreeDigest - the manifest pin.
 * @returns the verification outcome.
 */
async function verifyTree(extensionDir: string, expectedTreeDigest: string): Promise<TreeVerification> {
  try {
    const stats = await lstat(extensionDir)
    if (stats.isSymbolicLink()) {
      return { ok: false, actual: `symbolic link at the load path ${extensionDir}` }
    }
    if (!stats.isDirectory()) {
      return { ok: false, actual: 'the load path is not a directory' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, actual: 'missing' }
    throw error
  }
  try {
    const digest = await computeTreeDigest(extensionDir)
    return { ok: digest === expectedTreeDigest, actual: digest }
  } catch (error) {
    if (error instanceof ArtifactTreeError) return { ok: false, actual: error.message }
    throw error
  }
}

/**
 * Provision both pinned artifacts into the owned root, verifying bytes at
 * every step. An executable already on disk whose hash matches the binary
 * pin, and an extension tree whose digest matches the tree pin, skip the
 * download entirely — the on-disk bytes, never the state record, decide. A
 * corrupted or missing artifact is re-fetched under the consent that
 * provisioning carries; the extension tree is additionally repaired from the
 * retained archive when it still hashes to the pin, with no fetch.
 * Extraction happens in a staging tree under the owned root (same
 * filesystem as the published paths), the staged tree is verified against
 * the tree pin, and publication is the documented rename pair. The caller
 * must hold the root lease; provisioning carries download consent.
 * @param options - the owned root, config, progress callback, injectable fetch, and pin seam.
 * @returns the durable provisioning record.
 * @throws ProvisionRefusedError on any refusal.
 */
export async function provisionArtifacts(options: {
  root: string
  config: ResolvedBrowserSkillConfig
  onStep?: (step: 'download' | 'verify' | 'extract') => void
  fetchImpl?: DownloadFetch
  signal?: AbortSignal
  pins?: ArtifactPins
}): Promise<ProvisionedState> {
  const { root, config } = options
  const pins = options.pins ?? manifestArtifactPins()
  const archiveUrl = bskArchiveUrl(config)
  if (archiveUrl === undefined) throw unsupportedPlatform()
  const paths = artifactPaths(root)
  await mkdir(join(root, 'artifacts'), { recursive: true, mode: 0o700 })
  await cleanStagingResidue(root)
  const staging = await mkdtemp(join(root, 'artifacts', STAGING_PREFIX))
  try {
    // ---- bsk executable: bytes on disk decide; a mismatch re-fetches ----
    let binarySha = await sha256OrMissing(paths.bskExecutable)
    if (binarySha !== pins.bskBinarySha256) {
      options.onStep?.('download')
      await downloadVerified(archiveUrl, join(staging, 'bsk.tar.gz'), pins.bskArchiveSha256, 'bsk', options)
      options.onStep?.('extract')
      const stageDir = join(staging, 'bsk')
      await mkdir(stageDir, { mode: 0o700 })
      const entry = soleFile((await extractTarArchive(join(staging, 'bsk.tar.gz'), stageDir, config.maxDownloadBytes)).files)
      await rm(paths.bskExecutable, { force: true })
      await mkdir(dirname(paths.bskExecutable), { recursive: true, mode: 0o700 })
      await rename(join(stageDir, entry), paths.bskExecutable)
      binarySha = await sha256File(paths.bskExecutable)
      if (binarySha !== pins.bskBinarySha256) {
        // The archive pin matched, so a mismatch here is an extraction defect: fail closed.
        throw new ProvisionRefusedError({ kind: 'hash-mismatch', artifact: 'executable', expected: pins.bskBinarySha256, actual: binarySha })
      }
    }
    await chmod(paths.bskExecutable, 0o500)

    // ---- extension: the tree pin decides; the retained archive is the repair source ----
    const tree = await verifyTree(paths.extensionDir, pins.extensionTreeDigest)
    let retainedBytes = await readFileOrMissing(paths.extensionArchive)
    if (retainedBytes === undefined || sha256Bytes(retainedBytes) !== pins.extensionArchiveSha256) {
      // The repair source is missing or no longer pin-valid: re-fetch it
      // under the consent provisioning carries, and retain it for launch
      // repairs.
      options.onStep?.('download')
      const stagedZip = join(staging, 'extension.zip')
      await downloadVerified(extensionArchiveUrl(config), stagedZip, pins.extensionArchiveSha256, 'extension', options)
      retainedBytes = new Uint8Array(await readFile(stagedZip))
      // downloadVerified hashed the staged file; a mismatch now means the
      // buffer and the verified file diverged: fail closed.
      const freshSha = sha256Bytes(retainedBytes)
      if (freshSha !== pins.extensionArchiveSha256) {
        throw new ProvisionRefusedError({ kind: 'hash-mismatch', artifact: 'extension', expected: pins.extensionArchiveSha256, actual: freshSha })
      }
      await rename(stagedZip, paths.extensionArchive)
    }
    if (!tree.ok) {
      options.onStep?.('verify')
      // The bytes hashed above are the exact bytes extracted — no second
      // read can diverge from the hash gate. The staged tree digest below is
      // the gate on what extraction produced.
      options.onStep?.('extract')
      const stageDir = join(staging, 'extension')
      await mkdir(stageDir, { mode: 0o700 })
      // The narrowed local makes the defined-buffer invariant visible: every
      // path through the download block above assigned a concrete buffer.
      const verifiedBytes: Uint8Array = retainedBytes
      await extractZipArchive(verifiedBytes, stageDir, config.maxDownloadBytes)
      const stagedTreeDigest = await computeTreeDigest(stageDir)
      if (stagedTreeDigest !== pins.extensionTreeDigest) {
        throw new ProvisionRefusedError({ kind: 'hash-mismatch', artifact: 'extension', expected: pins.extensionTreeDigest, actual: stagedTreeDigest })
      }
      await swapTree(stageDir, paths.extensionDir, staging)
    }

    const state: ProvisionedState = {
      version: 1,
      bsk: { version: BSK_VERSION, executablePath: paths.bskExecutable, binarySha256: binarySha, archiveSha256: pins.bskArchiveSha256 },
      extension: {
        version: EXTENSION_VERSION,
        dir: paths.extensionDir,
        archiveSha256: pins.extensionArchiveSha256,
        treeDigest: pins.extensionTreeDigest,
      },
    }
    await writeFileAtomic(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    return state
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Verify the provisioned artifacts against the manifest pins immediately
 * before a Chrome launch, and repair the extension tree when it is missing
 * or mutated. This is the check every launch runs — even a freshly
 * provisioned record is verified against the bytes on disk:
 *
 * 1. The state record must parse with integrity receipts and name the pinned
 *    release; older records refuse with the instruction to provision.
 * 2. The executable must hash to the binary pin; a mismatch fails closed.
 * 3. The extension tree at the fixed load path must hash to the tree pin.
 * 4. A failed tree check is repaired ONLY from the retained archive after
 *    re-hashing it against the archive pin. A missing or mismatched retained
 *    archive refuses the launch — this function never fetches.
 *
 * The caller must hold the root lease and keep Chrome closed until this
 * returns: nothing may load the extension directory before the verification
 * resolves. Same-user mutation after this returns is residual, which is why
 * the check runs before every launch instead of once. Staging residue left
 * by crashed runs is removed here, under the lease.
 * @param root - the owned runtime root.
 * @param config - validated deployment config, for the extraction bounds.
 * @param signal - the caller's abort, checked between steps.
 * @param pins - package-internal pin substitution for tests; production resolves the manifest pins.
 * @returns the verified record, whose `extension.dir` is the fixed load path.
 * @throws ProvisionRefusedError when verification or repair fails; the launch must not proceed.
 */
export async function ensureLaunchArtifacts(
  root: string,
  config: ResolvedBrowserSkillConfig,
  signal?: AbortSignal,
  pins?: ArtifactPins,
): Promise<ProvisionedState> {
  const resolvedPins = pins ?? manifestArtifactPins()
  const paths = artifactPaths(root)
  const state = await readProvisionedState(root)
  if (state === undefined) {
    throw new ProvisionRefusedError({ kind: 'download-failed', detail: 'no verified provisioning record exists; run provision first' })
  }
  if (
    state.bsk.version !== BSK_VERSION || state.bsk.binarySha256 !== resolvedPins.bskBinarySha256 ||
    state.bsk.archiveSha256 !== resolvedPins.bskArchiveSha256 || state.bsk.executablePath !== paths.bskExecutable ||
    state.extension.version !== EXTENSION_VERSION || state.extension.archiveSha256 !== resolvedPins.extensionArchiveSha256 ||
    state.extension.dir !== paths.extensionDir
  ) {
    throw new ProvisionRefusedError({ kind: 'download-failed', detail: 'the provisioning record does not match the pinned release; run provision first' })
  }
  signal?.throwIfAborted()
  // The canonical computed path is hashed, never the recorded one: a mutated
  // record cannot point the verification at bytes outside the owned root.
  const binarySha = await sha256OrMissing(paths.bskExecutable)
  if (binarySha !== resolvedPins.bskBinarySha256) {
    throw new ProvisionRefusedError({ kind: 'hash-mismatch', artifact: 'executable', expected: resolvedPins.bskBinarySha256, actual: binarySha })
  }
  signal?.throwIfAborted()
  const tree = await verifyTree(paths.extensionDir, resolvedPins.extensionTreeDigest)
  if (!tree.ok) {
    // The retained archive is the only repair source and the helper never
    // fetches: a missing or mismatched retained archive refuses the launch.
    // The bytes read once are the bytes hashed and the bytes extracted — no
    // second read can diverge from the hash gate.
    const retainedBytes = await readFileOrMissing(paths.extensionArchive)
    if (retainedBytes === undefined) {
      throw new ProvisionRefusedError({ kind: 'download-failed', detail: `the extension tree is unverified (${tree.actual}) and the retained archive is missing; run provision first` })
    }
    const retainedSha = sha256Bytes(retainedBytes)
    if (retainedSha !== resolvedPins.extensionArchiveSha256) {
      throw new ProvisionRefusedError({ kind: 'download-failed', detail: `the extension tree is unverified (${tree.actual}) and the retained archive no longer matches the pin; run provision first` })
    }
    await mkdir(join(root, 'artifacts'), { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(root, 'artifacts', STAGING_PREFIX))
    try {
      const stageDir = join(staging, 'extension')
      await mkdir(stageDir, { mode: 0o700 })
      await extractZipArchive(retainedBytes, stageDir, config.maxDownloadBytes)
      const stagedTreeDigest = await computeTreeDigest(stageDir)
      if (stagedTreeDigest !== resolvedPins.extensionTreeDigest) {
        throw new ProvisionRefusedError({ kind: 'hash-mismatch', artifact: 'extension', expected: resolvedPins.extensionTreeDigest, actual: stagedTreeDigest })
      }
      await swapTree(stageDir, paths.extensionDir, staging)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    // The published tree is byte-identical to the staged tree that just
    // passed the digest check; a same-user mutation after verification is
    // residual and is caught by the next launch's verification.
    state.extension.treeDigest = resolvedPins.extensionTreeDigest
    await writeFileAtomic(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }
  signal?.throwIfAborted()
  await cleanStagingResidue(root)
  return state
}
