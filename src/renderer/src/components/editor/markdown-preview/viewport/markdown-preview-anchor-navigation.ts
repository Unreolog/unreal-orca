import { elementScroll, type Virtualizer } from '@tanstack/react-virtual'
import type { ProgrammaticScrollMarks } from '@/lib/list-interaction/virtualized-scrolling/programmatic-scroll-marks'

export function getMarkdownPreviewAnchorScrollTop(
  container: Pick<HTMLElement, 'getBoundingClientRect' | 'scrollTop'>,
  target: Pick<HTMLElement, 'getBoundingClientRect'>,
  align: 'start' | 'center' = 'start'
): number {
  const viewport = container.getBoundingClientRect()
  const bounds = target.getBoundingClientRect()
  const offset = align === 'center' ? (viewport.height - bounds.height) / 2 : 12
  return Math.max(0, bounds.top - viewport.top + container.scrollTop - offset)
}

export function decodeMarkdownPreviewAnchor(rawAnchor: string): string {
  try {
    return decodeURIComponent(rawAnchor)
  } catch {
    return rawAnchor
  }
}

export function resolveMarkdownPreviewAnchor(
  rawAnchor: string,
  hasAnchor: (id: string) => boolean
): string | null {
  const id = decodeMarkdownPreviewAnchor(rawAnchor)
  if (hasAnchor(id)) {
    return id
  }
  // Sanitization prefixes authored HTML IDs; generated heading IDs retain their original form.
  const sanitizedId = `user-content-${id}`
  return hasAnchor(sanitizedId) ? sanitizedId : null
}

export function scrollMarkdownPreviewVirtualizer(
  offset: number,
  options: { adjustments?: number; behavior?: ScrollBehavior },
  instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
  marks: ProgrammaticScrollMarks
): void {
  const element = instance.scrollElement
  const previous = element?.scrollTop
  elementScroll(offset, options, instance)
  const landing = element?.scrollTop
  if (landing !== undefined && landing !== previous) {
    marks.mark(landing)
  }
}

export function scrollMarkdownPreviewTo(
  container: HTMLDivElement,
  top: number,
  marks: ProgrammaticScrollMarks
): void {
  const previous = container.scrollTop
  container.scrollTo({ top })
  if (container.scrollTop !== previous) {
    marks.mark(container.scrollTop)
  }
}
