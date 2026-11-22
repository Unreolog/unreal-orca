import { describe, expect, it } from 'vitest'
import type { Nodes } from 'hast'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'
import {
  parseMarkdownPreviewDocument,
  renderMarkdownPreviewBlock
} from './markdown-preview-document-tree'
import { resolveMarkdownPreviewAnchor } from '../viewport/markdown-preview-anchor-navigation'

function elements(node: Nodes): Nodes[] {
  return [node, ...('children' in node ? node.children.flatMap(elements) : [])]
}

function highlightClasses(node: Nodes): string[] {
  return elements(node).flatMap((child) =>
    child.type === 'element' && Array.isArray(child.properties.className)
      ? child.properties.className.map(String)
      : []
  )
}

describe('large Markdown preview documents', () => {
  it('resolves authored HTML anchors after sanitization without changing the document', () => {
    const { document } = parseMarkdownPreviewDocument(
      '[Section 31](#mcp-59-preview2)\n\n<a id="mcp-59-preview2"></a>\n\n## Section 31'
    )
    const ids = new Set(document.blocks.flatMap((block) => block.anchors))
    expect(resolveMarkdownPreviewAnchor('mcp-59-preview2', (id) => ids.has(id))).toBe(
      'user-content-mcp-59-preview2'
    )
  })

  it('decodes HTML fragments and preserves exact heading targets when both IDs exist', () => {
    const { document } = parseMarkdownPreviewDocument(
      '<a id="раздел"></a>\n\n<a id="destination"></a>\n\n## Destination'
    )
    const ids = new Set(document.blocks.flatMap((block) => block.anchors))
    expect(
      resolveMarkdownPreviewAnchor('%D1%80%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB', (id) => ids.has(id))
    ).toBe('user-content-раздел')
    expect(resolveMarkdownPreviewAnchor('destination', (id) => ids.has(id))).toBe('destination')
    expect(resolveMarkdownPreviewAnchor('user-content-destination', (id) => ids.has(id))).toBe(
      'user-content-destination'
    )
    expect(resolveMarkdownPreviewAnchor('missing', (id) => ids.has(id))).toBeNull()
  })

  it('invalidates searches on document replacement', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load('needle\n\n'.repeat(100))
    const pending = engine.search('needle')
    engine.load('# Replacement')
    expect(await pending).toBeNull()
    expect(await engine.search('needle')).toEqual({ matches: [], truncated: false })
  })

  it('preserves raw HTML nesting across Markdown blocks and sanitizes executable HTML', () => {
    const { tree } = parseMarkdownPreviewDocument(
      '<details open>\n<summary>Read</summary>\n\n**Nested**\n\n</details>\n\n<script>alert(1)</script>'
    )
    const nodes = elements(tree)
    expect(nodes.some((node) => node.type === 'element' && node.tagName === 'script')).toBe(false)
    const details = nodes.find((node) => node.type === 'element' && node.tagName === 'details')
    expect(details).toMatchObject({
      properties: { open: true },
      children: expect.arrayContaining([expect.objectContaining({ tagName: 'p' })])
    })
  })

  it('finds code and footnote text in later document blocks', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load(
      `# Start\n\n${'Ordinary paragraph.\n\n'.repeat(
        100
      )}\`\`\`javascript\nconst needle = 1\n\`\`\`\n\nLast needle.[^n]\n\n[^n]: Footnote needle\n`
    )
    const result = await engine.search('needle')
    expect(result?.matches).toHaveLength(3)
    expect(result?.matches.every((match) => match.block > 90)).toBe(true)
  })
})

describe('Markdown preview code highlighting', () => {
  it('highlights PowerShell fences', () => {
    const { tree } = parseMarkdownPreviewDocument('```powershell\nGet-ChildItem -Path .\n```')
    const block = tree.children[0]
    if (!block) {
      throw new Error('missing preview block')
    }
    const rendered = renderMarkdownPreviewBlock(block, 0)
    expect(highlightClasses(rendered.tree)).toContain('hljs-built_in')
  })
})
