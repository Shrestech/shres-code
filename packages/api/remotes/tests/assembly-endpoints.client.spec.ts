/**
 * Guard for the api-remotes Client assembly: every Remote endpoint it mounts
 * must install on a real Client Remote service. A generated namespace is a
 * Cordis Service, so an endpoint whose method name the namespace Service
 * already owns (`install`, `has`, `namespace`, `ctx`, …) fails `$mount` and with it
 * every Web page's plugin boot. The endpoints are read from the Host sources
 * of the packages the assembly imports, so the guard runs on a clean tree;
 * once Host tsdown has generated the `/remote` artifacts, the assembly's own
 * contributions are mounted as well and compared with the source scan.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { z } from 'zod'
import { Context } from '@shres-code/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InvocationDescriptor } from '@shres-code/shres-code-typert-protocol'
import TypertRegistry from '@shres-code/shres-code-typert-registry'
import type { ConnectionHandle } from '@shres-code/shres-code-client-connection/client'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { apply as gatewayApply, inject as gatewayInject } from '@shres-code/shres-code-api-gateway/client'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const ASSEMBLY = join(ROOT, 'packages/api/remotes/src/client/index.ts')

/** One Remote endpoint as a Host service declares it. */
interface Endpoint {
  readonly pkg: string
  readonly service: string
  readonly namespace: string
  readonly method: string
}

/** Workspace package names mapped to their directories. */
function workspacePackages(): Map<string, string> {
  const packages = new Map<string, string>()
  for (const group of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(ROOT, 'packages', group.name)
    for (const name of readdirSync(groupDir)) {
      const manifest = join(groupDir, name, 'package.json')
      if (!existsSync(manifest)) continue
      packages.set((JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name, join(groupDir, name))
    }
  }
  return packages
}

/** Packages whose generated `/remote` contribution the assembly imports. */
function assemblyRemotePackages(): string[] {
  const source = ts.createSourceFile(ASSEMBLY, readFileSync(ASSEMBLY, 'utf8'), ts.ScriptTarget.Latest)
  const packages: string[] = []
  for (const statement of source.statements) {
    // A default import is the contribution value; type-only imports carry no default binding here.
    if (!ts.isImportDeclaration(statement) || statement.importClause?.name === undefined) continue
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
    if (specifier.endsWith('/remote')) packages.push(specifier.slice(0, -'/remote'.length))
  }
  return packages
}

/** Every `.ts` source file under a package's `src`. */
function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path)
  }
  return files
}

/** The literal text of a string-literal expression, or undefined. */
function literal(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined
}

/**
 * Read the Remote endpoints one source file declares: each class extending
 * `TypertRemoteService`, its service key and wire namespace from the `super`
 * call, and each method decorated with `@Remote` or `@RemoteScope`.
 */
function declaredEndpoints(pkg: string, file: string, text = readFileSync(file, 'utf8')): Endpoint[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const endpoints: Endpoint[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      const remoteMethods = node.members.filter(ts.isMethodDeclaration).flatMap((member) => {
        const decorators = ts.getDecorators(member) ?? []
        return decorators.flatMap((decorator) => {
          const expression = decorator.expression
          const name = member.name.getText(source)
          if (ts.isIdentifier(expression) && expression.text === 'Remote') return [name]
          if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return []
          if (expression.expression.text === 'Remote') return [literal(expression.arguments[0]) ?? name]
          if (expression.expression.text === 'RemoteScope') return [literal(expression.arguments[1]) ?? name]
          return []
        })
      })
      const extendsRemote = node.heritageClauses?.some(clause => clause.types.some(type => type.expression.getText(source) === 'TypertRemoteService')) === true
      if (remoteMethods.length > 0 && !extendsRemote) {
        throw new Error(`${file}: ${node.name?.text ?? 'a class'} marks Remote methods without extending TypertRemoteService; teach this guard its binding`)
      }
      if (extendsRemote) {
        let binding: { service: string; namespace: string } | undefined
        const findSuper = (inner: ts.Node): void => {
          if (ts.isCallExpression(inner) && inner.expression.kind === ts.SyntaxKind.SuperKeyword) {
            const service = literal(inner.arguments[1])
            const options = inner.arguments[2]
            const namespaceProperty = options !== undefined && ts.isObjectLiteralExpression(options)
              ? options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'namespace')
              : undefined
            const namespace = namespaceProperty !== undefined && ts.isPropertyAssignment(namespaceProperty)
              ? literal(namespaceProperty.initializer)
              : undefined
            if (service === undefined) throw new Error(`${file}: the TypertRemoteService super call names no literal service key`)
            binding = { service, namespace: namespace ?? service }
          }
          ts.forEachChild(inner, findSuper)
        }
        ts.forEachChild(node, findSuper)
        if (binding === undefined) throw new Error(`${file}: ${node.name?.text ?? 'a class'} extends TypertRemoteService without a super call`)
        const { service, namespace } = binding
        endpoints.push(...remoteMethods.map(method => ({ pkg, service, namespace, method })))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return endpoints
}

/** Every endpoint the assembly mounts, read from the imported packages' Host sources. */
function assemblyEndpoints(): Endpoint[] {
  const directories = workspacePackages()
  return assemblyRemotePackages().flatMap((pkg) => {
    const dir = directories.get(pkg)
    if (dir === undefined) throw new Error(`the assembly imports ${pkg}/remote, which is not a workspace package`)
    const endpoints = sourceFiles(join(dir, 'src')).flatMap(file => declaredEndpoints(pkg, file))
    if (endpoints.length === 0) throw new Error(`${pkg} declares no Remote endpoint the guard can read`)
    return endpoints
  })
}

/** A strict descriptor for one endpoint: no parameters, any JSON result. */
function descriptor(endpoint: Endpoint): InvocationDescriptor {
  return {
    id: `${endpoint.pkg}#${endpoint.namespace}/${endpoint.method}`,
    service: endpoint.service,
    namespace: endpoint.namespace,
    method: endpoint.method,
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'strict', typeSymbol: '@guard#Result', schema: z.unknown() },
  }
}

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

/** A Client root with the slot registry, the Typert registry, a stub connection, and the real Client Remote service. */
async function clientRoot(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  await ctx.plugin(TypertRegistry)
  ctx.provide('connection', { rpc: { call: vi.fn() } } as unknown as ConnectionHandle)
  await ctx.plugin({ inject: gatewayInject, apply: gatewayApply })
  return ctx
}

/** Mount endpoints grouped by package, as the assembly mounts one contribution per package. */
async function mountAll(ctx: Context, endpoints: readonly Endpoint[]): Promise<void> {
  const byPackage = new Map<string, Endpoint[]>()
  for (const endpoint of endpoints) byPackage.set(endpoint.pkg, [...byPackage.get(endpoint.pkg) ?? [], endpoint])
  for (const [pkg, members] of byPackage) {
    await ctx.remote.$mount({ package: pkg, descriptors: members.map(descriptor) })
  }
}

describe('api-remotes Client assembly endpoints', () => {
  it('reads every package the assembly mounts, including the judgment engine and Laya Remotes', () => {
    const endpoints = assemblyEndpoints()
    const packages = new Set(endpoints.map(endpoint => endpoint.pkg))
    expect([...packages].sort()).toEqual([...assemblyRemotePackages()].sort())
    expect(endpoints).toContainEqual({
      pkg: '@shres-code/shres-code-judgment-dispatch', service: 'judgmentEnginesRemote', namespace: 'judgmentEngines', method: 'snapshot',
    })
    expect(endpoints.filter(endpoint => endpoint.namespace === 'laya').map(endpoint => endpoint.method).sort())
      .toEqual(['gatewayStatus', 'installGateway', 'restartGateway'])
  })

  it('mounts every endpoint on a real Client Remote service without a namespace-Service member collision', async () => {
    const ctx = await clientRoot()
    const endpoints = assemblyEndpoints()

    await mountAll(ctx, endpoints)

    for (const endpoint of endpoints) {
      const namespace = (ctx.remote as unknown as Record<string, Record<string, unknown>>)[endpoint.namespace]
      expect(typeof namespace?.[endpoint.method], `${endpoint.namespace}/${endpoint.method}`).toBe('function')
    }
  })

  it('fails the mount for an endpoint named after a namespace-Service member, as a Web boot would', async () => {
    const ctx = await clientRoot()
    const clashing: Endpoint = { pkg: '@guard/clash', service: 'guardClash', namespace: 'guardClash', method: 'install' }

    await expect(mountAll(ctx, [clashing])).rejects.toThrow('client api: method "guardClash/install" conflicts with its namespace service')
    for (const reserved of ['has', 'namespace', 'ctx', 'installDirect']) {
      await expect(mountAll(ctx, [{ ...clashing, method: reserved }])).rejects.toThrow('conflicts with its namespace service')
    }
  })

  it('reads a bare @Remote method, a named @Remote, a @RemoteScope export, and rejects an unbound Remote class', () => {
    const sample = [
      "class Named extends TypertRemoteService { constructor(ctx) { super(ctx, 'named', { namespace: 'wire' }) }",
      "  @Remote bare() {}  @Remote('exported') renamed() {}  @RemoteScope('agent', 'scoped') scopedMethod() {}  @RemoteScope('agent') plain() {}  helper() {} }",
      "class Keyed extends TypertRemoteService { constructor(ctx) { super(ctx, 'keyed') }  @Remote list() {} }",
    ].join('\n')
    expect(declaredEndpoints('@guard/sample', 'sample.ts', sample).map(endpoint => `${endpoint.service}:${endpoint.namespace}/${endpoint.method}`))
      .toEqual(['named:wire/bare', 'named:wire/exported', 'named:wire/scoped', 'named:wire/plain', 'keyed:keyed/list'])
    expect(() => declaredEndpoints('@guard/sample', 'unbound.ts', 'class Bound { @Remote list() {} }'))
      .toThrow('marks Remote methods without extending TypertRemoteService')
    expect(() => declaredEndpoints('@guard/sample', 'dynamic.ts', 'class D extends TypertRemoteService { constructor(ctx) { super(ctx, key) }  @Remote a() {} }'))
      .toThrow('names no literal service key')
    expect(() => declaredEndpoints('@guard/sample', 'nosuper.ts', 'class N extends TypertRemoteService { @Remote a() {} }'))
      .toThrow('without a super call')
  })
})

const BUILT = assemblyRemotePackages().every((pkg) => {
  const dir = workspacePackages().get(pkg)
  return dir !== undefined && existsSync(join(dir, 'lib/typert.remote-client.js'))
})

describe.skipIf(!BUILT)('api-remotes Client assembly, generated contributions', () => {
  it('mounts the assembly itself, and its generated endpoints equal the source scan', async () => {
    const ctx = await clientRoot()
    const assembly = await import('../src/client/index.ts')
    await ctx.plugin({ inject: assembly.inject, apply: assembly.apply })

    const generated = ctx.typert.remotes.list().map(item => `${item.namespace}/${item.method}`).sort()
    expect(generated).toEqual(assemblyEndpoints().map(endpoint => `${endpoint.namespace}/${endpoint.method}`).sort())
  })
})
