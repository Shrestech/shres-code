import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from 'react'
import { render as testingRender, type RenderResult } from '@testing-library/react'

type DisclosureProps = { expanded: boolean; onExpandedChange: (expanded: boolean) => void }

/** Marker callback replaced by the stateful owner harness below. */
export const testDisclosurePlaceholder = (_expanded: boolean): void => {}

/** Controlled owner disclosure props for direct renderer tests. */
export function toolDisclosureProps(): DisclosureProps {
  return { expanded: false, onExpandedChange: testDisclosurePlaceholder }
}

/** Render an atomic Tool view with the same controlled owner state as ToolCall. */
export function renderWithToolDisclosure(ui: ReactElement): RenderResult {
  const result = testingRender(<ControlledDisclosure ui={ui} />)
  return {
    ...result,
    rerender: (next: ReactNode) => {
      result.rerender(<ControlledDisclosure ui={next} />)
    },
  }
}

function ControlledDisclosure({ ui }: { ui: ReactNode }): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  if (!isValidElement<DisclosureProps>(ui)) return null
  if (ui.props.onExpandedChange !== testDisclosurePlaceholder) return ui
  return cloneElement(ui, {
    expanded,
    onExpandedChange: setExpanded,
  })
}
