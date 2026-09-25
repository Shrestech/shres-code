/**
 * The frame's full-page navigation takes a destination id owned by the
 * destination's provider. Settings sections open through `ctx.settingsPages`,
 * which checks the id against the settings.section ledger, so the only client
 * source outside ui-layout that reaches `ctx.layout.navigate` is that
 * provider. The scan reads the TypeScript syntax tree, so every spelling of the
 * access counts: optional chaining, brackets, destructuring, an alias of
 * `ctx.layout` or `ctx.get('layout')`, and a value typed `ILayout` or `LayoutController`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const CLIENT = fileURLToPath(new URL('../../', import.meta.url))
const ALLOWED = ['ui-settings-general/src/client/index.ts']
const LAYOUT_TYPES = new Set(['ILayout', 'LayoutController'])

/** The expression under parentheses, type assertions, and non-null marks. */
function bare(node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression
  return current
}

/** The text of a string literal, or undefined. */
function literal(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined
}

/**
 * Where one source file reaches the frame's navigate.
 * @param file - the file name, for the parser.
 * @param text - the source.
 * @returns the line of each access.
 */
export function layoutNavigateAccesses(file: string, text: string): number[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const aliases = new Set<string>()
  const isLayout = (node: ts.Expression): boolean => {
    const expression = bare(node)
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text === 'layout'
    if (ts.isElementAccessExpression(expression)) return literal(expression.argumentExpression) === 'layout'
    if (ts.isCallExpression(expression)) {
      const callee = bare(expression.expression)
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined
      return name === 'get' && literal(expression.arguments[0]) === 'layout'
    }
    return ts.isIdentifier(expression) && aliases.has(expression.text)
  }
  const typedLayout = (type: ts.TypeNode | undefined): boolean =>
    type !== undefined && ts.isTypeReferenceNode(type) && LAYOUT_TYPES.has(type.typeName.getText(source))
  // Aliases first, to a fixed point, so an alias of an alias counts.
  let grew = true
  while (grew) {
    grew = false
    const collect = (node: ts.Node): void => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && !aliases.has(node.name.text)) {
        const initializer = node.initializer
        if (typedLayout(node.type) || (initializer !== undefined && isLayout(initializer))) {
          aliases.add(node.name.text)
          grew = true
        }
      }
      ts.forEachChild(node, collect)
    }
    collect(source)
  }
  const lines: number[] = []
  const at = (node: ts.Node): void => { lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1) }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'navigate' && isLayout(node.expression)) at(node)
    if (ts.isElementAccessExpression(node) && literal(node.argumentExpression) === 'navigate' && isLayout(node.expression)) at(node)
    if (ts.isObjectBindingPattern(node)) {
      const holder = node.parent
      const fromLayout = (ts.isVariableDeclaration(holder) && holder.initializer !== undefined && isLayout(holder.initializer))
        || ((ts.isVariableDeclaration(holder) || ts.isParameter(holder)) && typedLayout(holder.type))
      const names = node.elements.map(element => (element.propertyName ?? element.name).getText(source).replace(/['"]/g, ''))
      if (fromLayout && names.includes('navigate')) at(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return lines
}

/** Every TypeScript source file under one directory. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/**
 * Client source files outside ui-layout that reach the frame's navigate.
 * @returns paths relative to packages/client.
 */
export function layoutNavigateCallers(): string[] {
  return readdirSync(CLIENT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'ui-layout')
    .flatMap((entry) => {
      try {
        return sources(join(CLIENT, entry.name, 'src'))
      } catch {
        // A package directory without src (lib-only residue) has nothing to scan.
        return []
      }
    })
    .filter(file => layoutNavigateAccesses(file, readFileSync(file, 'utf8')).length > 0)
    .map(file => relative(CLIENT, file).replaceAll('\\', '/'))
    .sort()
}

describe('full-page navigation callers', () => {
  // Parses every client source file; the budget covers a loaded worker.
  it('only the Settings pages provider reaches ctx.layout.navigate', { timeout: 30_000 }, () => {
    expect(layoutNavigateCallers()).toEqual(ALLOWED)
  })

  it.each([
    ['direct', "ctx.layout.navigate('models')"],
    ['optional chaining', "ctx.layout?.navigate('models')"],
    ['optional call', "ctx.layout.navigate?.('models')"],
    ['brackets on the method', "ctx.layout['navigate']('models')"],
    ['brackets on the service', "ctx['layout'].navigate('models')"],
    ['a cast', "(ctx.layout as ILayout).navigate('models')"],
    ['destructuring', "const { navigate } = ctx.layout\nnavigate('models')"],
    ['renamed destructuring', "const { navigate: go } = ctx.layout\ngo('models')"],
    ['an alias', "const frame = ctx.layout\nframe.navigate('models')"],
    ['an alias of an alias', "const again = frame\nconst frame = ctx.layout\nagain.navigate('models')"],
    ['ctx.get', "ctx.get('layout').navigate('models')"],
    ['ctx.get with optional chaining', "ctx.get('layout')?.navigate('models')"],
    ['a typed parameter', "function open(frame: ILayout) { frame.navigate('models') }"],
    ['a destructured typed parameter', "function open({ navigate }: LayoutController) { navigate('models') }"],
    ['a method value', "const go = ctx.layout.navigate\ngo('models')"],
  ])('finds the access spelled with %s', (_spelling, snippet) => {
    expect(layoutNavigateAccesses('probe.ts', snippet)).not.toEqual([])
  })

  it('ignores a navigate that is not the frame\'s', () => {
    const snippet = [
      'actions.navigate(null)',
      "props.navigate('models')",
      "const { navigate } = props\nnavigate('general')",
      "router.navigate('/x')",
      'ctx.layout.toggleSidebar()',
      "ctx.get('settingsPages')?.open('models')",
      'function open(frame: Router) { frame.navigate(1) }',
    ].join('\n')
    expect(layoutNavigateAccesses('probe.tsx', snippet)).toEqual([])
  })
})
