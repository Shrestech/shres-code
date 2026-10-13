/** Keep the desktop workflow's build, artifact, and release policy reviewable as data. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const workflowPath = resolve(root, '.github/workflows/desktop.yml')
const releaseSecrets = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
] as const

type Mapping = Record<string, unknown>

describe('desktop workflow', () => {
  it('keeps pull-request packaging separate from the manual credentialed release path', () => {
    const workflow = loadWorkflow()
    const events = mapping(workflow.on, 'workflow events')
    expect(events).toHaveProperty('pull_request')
    const push = mapping(events.push, 'push event')
    expect(push.branches).toEqual(['master', 'develop'])
    expect(push.tags).toEqual(['shres-v*'])

    const dispatch = mapping(events.workflow_dispatch, 'workflow_dispatch event')
    const publishInput = mapping(mapping(dispatch.inputs, 'dispatch inputs').publish, 'publish input')
    expect(publishInput).toMatchObject({ required: true, type: 'boolean', default: false })
    expect(mapping(workflow.permissions, 'workflow permissions').contents).toBe('read')

    const desktop = job(workflow, 'desktop')
    const packageJob = job(workflow, 'package')
    const releaseValidate = job(workflow, 'release-validate')
    const publish = job(workflow, 'publish')
    expect(desktop['runs-on']).toBe('macos-14')
    expect(packageJob['runs-on']).toBe('macos-14')
    expect(publish['runs-on']).toBe('macos-14')
    expect(String(packageJob.if)).toContain("github.event_name == 'workflow_dispatch'")
    expect(String(packageJob.if)).toContain('inputs.publish == true')
    expect(String(packageJob.if)).toContain("github.ref_type == 'tag'")
    expect(String(packageJob.if)).toContain("startsWith(github.ref_name, 'shres-v')")
    expect(String(packageJob.if)).toContain('!( ')
    for (const releaseJob of [releaseValidate, publish]) {
      expect(String(releaseJob.if)).toContain("github.event_name == 'workflow_dispatch'")
      expect(String(releaseJob.if)).toContain('inputs.publish == true')
      expect(String(releaseJob.if)).toContain("github.event_name == 'push'")
      expect(String(releaseJob.if)).toContain("github.ref_type == 'tag'")
      expect(String(releaseJob.if)).toContain("startsWith(github.ref_name, 'shres-v')")
      expect(String(releaseJob.if).includes('!(')).toBe(false)
    }

    // Secrets may appear only in the protected publish job. This keeps forked
    // PRs and ordinary branch packaging unable to receive signing credentials.
    for (const uncredentialedJob of [desktop, packageJob, releaseValidate]) {
      expect(uncredentialedJob.permissions).toBeUndefined()
      expect(JSON.stringify(uncredentialedJob)).not.toMatch(/secrets\.(?:CSC|APPLE)/u)
    }
    const publishText = JSON.stringify(publish)
    for (const secret of releaseSecrets) expect(publishText).toContain(`secrets.${secret}`)
  })

  it('builds before packaging, smokes before artifact upload, and uploads installers with checksums', () => {
    const workflow = loadWorkflow()
    const packageJob = job(workflow, 'package')
    const packageSteps = steps(packageJob)
    expect(stepRun(stepByName(packageSteps, 'Confirm arm64 runner'))).toContain('uname -m')
    expect(stepRun(stepByName(packageSteps, 'Build runtime and web'))).toBe('pnpm run build')
    expect(stepRun(stepByName(packageSteps, 'Package unsigned DMG and ZIP'))).toContain('run package')
    expect(stepRun(stepByName(packageSteps, 'Smoke packaged desktop runtime'))).toContain('run smoke')

    const build = indexOf(packageSteps, 'Build runtime and web')
    const packageIndex = indexOf(packageSteps, 'Package unsigned DMG and ZIP')
    const smoke = indexOf(packageSteps, 'Smoke packaged desktop runtime')
    const extractedSmoke = indexOf(packageSteps, 'Smoke extracted ZIP desktop runtime')
    const checksums = indexOf(packageSteps, 'Generate checksums')
    const upload = indexOf(packageSteps, 'Upload unsigned artifacts')
    expect(build).toBeLessThan(packageIndex)
    expect(packageIndex).toBeLessThan(smoke)
    expect(smoke).toBeLessThan(extractedSmoke)
    expect(stepRun(stepByName(packageSteps, 'Smoke extracted ZIP desktop runtime'))).toContain('ditto -x -k')
    expect(stepRun(stepByName(packageSteps, 'Smoke extracted ZIP desktop runtime'))).toContain('--runtime')
    expect(extractedSmoke).toBeLessThan(checksums)
    expect(checksums).toBeLessThan(upload)

    const checksumRun = stepRun(stepByName(packageSteps, 'Generate checksums'))
    expect(checksumRun).toMatch(/dmgs=.*\*\.dmg/u)
    expect(checksumRun).toMatch(/zips=.*\*\.zip/u)
    expect(checksumRun).toContain('!= 1')
    expect(checksumRun).toContain('SHA256SUMS.txt')

    const uploadWith = mapping(stepByName(packageSteps, 'Upload unsigned artifacts').with, 'unsigned upload options')
    expect(uploadWith['retention-days']).toBe(7)
    const uploadPath = String(uploadWith.path)
    expect(uploadPath).toContain('*.dmg')
    expect(uploadPath).toContain('*.zip')
    expect(uploadPath).toContain('SHA256SUMS.txt')
    expect(uploadPath).not.toContain('.app')
    expect(uploadWith.name).toBe('shres-code-mac-arm64')
  })

  it('pins release source and protects signed publication with the release environment', () => {
    const workflow = loadWorkflow()
    const validation = job(workflow, 'release-validate')
    const validationCheckout = stepByUse(steps(validation), 'actions/checkout@v6')
    const validationRun = stepRun(stepByName(steps(validation), 'Require matching shres-v tag'))
    expect(mapping(validationCheckout.with, 'release validation checkout')).toMatchObject({
      ref: '${{ github.sha }}',
      'fetch-depth': 0,
    })
    expect(validationRun).toContain('$GITHUB_REF_TYPE')
    expect(validationRun).toContain('shres-v*')
    expect(validationRun).toContain('git rev-list -n 1')
    expect(validationRun).toContain('git merge-base --is-ancestor')
    expect(validationRun).toContain('origin/master')
    expect(validationRun).toContain('apps/desktop/package.json')

    const publish = job(workflow, 'publish')
    expect(publish.environment).toBe('desktop-release')
    expect(mapping(publish.permissions, 'publish permissions')).toEqual({ contents: 'write' })
    expect(publish.needs).toEqual(['desktop', 'release-validate'])
    const publishSteps = steps(publish)
    const publishCheckout = stepByUse(publishSteps, 'actions/checkout@v6')
    expect(mapping(publishCheckout.with, 'publish checkout')).toMatchObject({
      ref: '${{ github.sha }}',
      'fetch-depth': 0,
    })

    const credentialCheck = stepByName(publishSteps, 'Verify release credentials')
    const credentialEnv = mapping(credentialCheck.env, 'credential check environment')
    for (const secret of releaseSecrets) expect(credentialEnv[secret]).toBe(secretExpression(secret))
    expect(stepRun(credentialCheck)).toContain('missing $variable')

    const signedPackage = stepByName(publishSteps, 'Package signed and notarized DMG and ZIP')
    const signedEnv = mapping(signedPackage.env, 'signed package environment')
    expect(signedEnv.SHRES_DESKTOP_RELEASE).toBe('1')
    for (const secret of releaseSecrets) expect(signedEnv[secret]).toBe(secretExpression(secret))

    const build = indexOf(publishSteps, 'Build runtime and web')
    const packageIndex = indexOf(publishSteps, 'Package signed and notarized DMG and ZIP')
    const smoke = indexOf(publishSteps, 'Smoke packaged desktop runtime')
    const extractedSmoke = indexOf(publishSteps, 'Smoke extracted ZIP desktop runtime')
    const verify = indexOf(publishSteps, 'Verify signed and notarized application')
    const upload = indexOf(publishSteps, 'Upload signed artifacts')
    const release = indexOf(publishSteps, 'Publish GitHub release')
    expect(build).toBeLessThan(packageIndex)
    expect(packageIndex).toBeLessThan(smoke)
    expect(smoke).toBeLessThan(extractedSmoke)
    expect(stepRun(stepByName(publishSteps, 'Smoke extracted ZIP desktop runtime'))).toContain('ditto -x -k')
    expect(stepRun(stepByName(publishSteps, 'Smoke extracted ZIP desktop runtime'))).toContain('--runtime')
    expect(extractedSmoke).toBeLessThan(verify)
    const verifyRun = stepRun(stepByName(publishSteps, 'Verify signed and notarized application'))
    expect(verifyRun).toContain('SHRES_DESKTOP_ZIP_APP')
    expect(verifyRun).toContain('codesign --verify')
    expect(verifyRun).toContain('spctl --assess')
    expect(verifyRun).toContain('xcrun stapler validate')
    expect(verify).toBeLessThan(upload)
    expect(upload).toBeLessThan(release)

    const releaseChecksumRun = stepRun(stepByName(publishSteps, 'Generate release checksums'))
    expect(releaseChecksumRun).toMatch(/dmgs=.*\*\.dmg/u)
    expect(releaseChecksumRun).toMatch(/zips=.*\*\.zip/u)
    expect(releaseChecksumRun).toContain('!= 1')
    expect(releaseChecksumRun).toContain('SHA256SUMS.txt')

    const signedUploadWith = mapping(stepByName(publishSteps, 'Upload signed artifacts').with, 'signed upload options')
    expect(signedUploadWith['retention-days']).toBe(7)
    const signedUploadPath = String(signedUploadWith.path)
    expect(signedUploadPath).toContain('*.dmg')
    expect(signedUploadPath).toContain('*.zip')
    expect(signedUploadPath).toContain('SHA256SUMS.txt')
    expect(signedUploadPath).not.toContain('.app')
  })

  it('publishes through a non-clobbering draft', () => {
    const workflow = loadWorkflow()
    const publishSteps = steps(job(workflow, 'publish'))
    const publishRun = stepRun(stepByName(publishSteps, 'Publish GitHub release'))
    expect(publishRun).toContain('gh release create')
    expect(publishRun).toContain('--draft')
    expect(publishRun).toContain('gh release upload')
    expect(publishRun).not.toContain('--clobber')
    expect(publishRun).toContain('gh release edit')
    expect(publishRun).toContain('--draft=false')

    const version = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')) as { version: string }
    if (version.version.includes('-')) {
      expect(publishRun).toContain('--prerelease')
      expect(publishRun).toContain('--latest=false')
    }
  })
})

function loadWorkflow(): Mapping {
  return mapping(yaml.load(readFileSync(workflowPath, 'utf8')), 'desktop workflow')
}

function job(workflow: Mapping, name: string): Mapping {
  return mapping(mapping(workflow.jobs, 'workflow jobs')[name], `${name} job`)
}

function steps(jobValue: Mapping): Mapping[] {
  const value = jobValue.steps
  if (!Array.isArray(value)) throw new TypeError('workflow job must define steps')
  return value.map((step, index) => mapping(step, `workflow step ${String(index)}`))
}

function stepByName(jobSteps: readonly Mapping[], name: string): Mapping {
  const step = jobSteps.find(candidate => candidate.name === name)
  if (step === undefined) throw new TypeError(`workflow must define step ${name}`)
  return step
}

function stepByUse(jobSteps: readonly Mapping[], action: string): Mapping {
  const step = jobSteps.find(candidate => candidate.uses === action)
  if (step === undefined) throw new TypeError(`workflow must use ${action}`)
  return step
}

function stepRun(step: Mapping): string {
  if (typeof step.run !== 'string') throw new TypeError('workflow step must define a shell command')
  return step.run
}

function indexOf(jobSteps: readonly Mapping[], name: string): number {
  const index = jobSteps.findIndex(step => step.name === name)
  if (index === -1) throw new TypeError(`workflow must define step ${name}`)
  return index
}

function secretExpression(name: string): string {
  return '${{ secrets.' + name + ' }}'
}

function mapping(value: unknown, label: string): Mapping {
  if (!isRecord(value)) throw new TypeError(`${label} must be a mapping`)
  return value
}

function isRecord(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
