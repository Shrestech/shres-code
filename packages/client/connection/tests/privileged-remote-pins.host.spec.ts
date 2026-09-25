/** Privileged Remote declarations and the HTTP loopback pins must stay in agreement. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
// Add every new gesture-gated gateway here; each declared method must be loopback-pinned.
const gateways = [
  'packages/browser/browserskill/src/gateway.ts',
  'packages/host/plugin-admin/src/gateway.ts',
  'packages/host/remote-control/src/admin.ts',
]

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function readPins(source: string): Set<string> {
  const declarations = parse(source).statements.flatMap(statement =>
    ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
  ).filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'PRIVILEGED_METHODS')
  if (declarations.length !== 1) throw new Error('Expected one PRIVILEGED_METHODS declaration')
  const expression = declarations[0]!.initializer
  if (expression === undefined || !ts.isNewExpression(expression)
    || !ts.isIdentifier(expression.expression) || expression.expression.text !== 'Set') {
    throw new Error('PRIVILEGED_METHODS must construct a Set')
  }
  const array = expression.arguments?.[0]
  if (array === undefined || !ts.isArrayLiteralExpression(array)) throw new Error('PRIVILEGED_METHODS must use a literal array')
  return new Set(array.elements.map((element) => {
    if (!ts.isStringLiteral(element)) throw new Error('PRIVILEGED_METHODS entries must be string literals')
    return element.text
  }))
}

function readGateway(source: string): { namespace: string; methods: string[] } {
  const classes = parse(source).statements.filter(ts.isClassDeclaration).filter(declaration =>
    declaration.heritageClauses?.some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword
      && clause.types.some(type => ts.isIdentifier(type.expression) && type.expression.text === 'TypertRemoteService')),
  )
  if (classes.length !== 1) throw new Error('Expected one TypertRemoteService class')
  const declaration = classes[0]!
  const constructor = declaration.members.find(ts.isConstructorDeclaration)
  const call = constructor?.body?.statements.filter(ts.isExpressionStatement).map(statement => statement.expression)
    .find(expression => ts.isCallExpression(expression) && expression.expression.kind === ts.SyntaxKind.SuperKeyword)
  if (call === undefined || !ts.isCallExpression(call)) throw new Error('Expected a direct super(ctx, namespace) call')
  const namespace = call.arguments[1]
  if (namespace === undefined || !ts.isStringLiteral(namespace)) throw new Error('Remote namespace must be a string literal')
  const methods: string[] = []
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member)) continue
    for (const decorator of ts.getDecorators(member) ?? []) {
      const expression = decorator.expression
      if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== 'Remote') continue
      const name = expression.arguments[0]
      if (name === undefined || !ts.isStringLiteral(name)) throw new Error('Remote method name must be a string literal')
      methods.push(namespace.text + '/' + name.text)
    }
  }
  if (methods.length === 0) throw new Error('Expected at least one @Remote method')
  if (new Set(methods).size !== methods.length) throw new Error('Remote method names must be unique')
  return { namespace: namespace.text, methods }
}

function assertPinned(pins: Set<string>, gateway: ReturnType<typeof readGateway>): void {
  const methods = new Set(gateway.methods)
  const missing = gateway.methods.filter(method => !pins.has(method))
  const stale = [...pins].filter(method => method.startsWith(gateway.namespace + '/') && !methods.has(method))
  if (missing.length !== 0 || stale.length !== 0) {
    throw new Error('Privileged Remote pin mismatch: missing=[' + missing.join(', ') + '], stale=[' + stale.join(', ') + ']')
  }
}

const fixture = "class Gateway extends TypertRemoteService { constructor(ctx: Context) { super(ctx, 'browserSkill') } @Remote('status') status() {} @Remote('probe') probe() {} }"

describe('privileged Remote pins', () => {
  it('pins every declared method of each gesture-gated namespace and rejects stale pins', () => {
    const pins = readPins(readFileSync(join(root, 'packages/client/connection/src/index.ts'), 'utf8'))
    for (const path of gateways) assertPinned(pins, readGateway(readFileSync(join(root, path), 'utf8')))
  })

  it('rejects an added Remote method without its loopback pin', () => {
    expect(() => { assertPinned(new Set(['browserSkill/status']), readGateway(fixture)) })
      .toThrow('missing=[browserSkill/probe]')
  })

  it('rejects a stale pin and refuses to silently skip unrecognized declarations', () => {
    expect(() => {
      assertPinned(new Set(['browserSkill/status', 'browserSkill/probe', 'browserSkill/typo']), readGateway(fixture))
    }).toThrow('stale=[browserSkill/typo]')
    expect(() => readPins('const PRIVILEGED_METHODS = new Set([dynamic])')).toThrow('entries must be string literals')
    expect(() => readGateway('class Other {}')).toThrow('Expected one TypertRemoteService class')
  })
})
