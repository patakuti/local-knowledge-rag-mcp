import type { SearchResult } from '../types/rag.types.js'

interface FormattedCitation {
  topic: string
  summary: string
  result: SearchResult
}

interface ContentGroup {
  theme: string           // e.g., "Installation", "Configuration", "Usage"
  priority: number        // Display priority (1-10)
  citations: FormattedCitation[]
  description: string     // Group description
}

export class ResponseFormatter {
  /**
   * Format search results into an intelligent, user-friendly response
   */
  formatIntelligentResponse(results: SearchResult[], query: string): string {
    if (results.length === 0) {
      return this.formatNoResults()
    }

    // 1. Filter and deduplicate results
    const filteredResults = this.filterAndDeduplicateResults(results)

    // 2. Create citations with topic analysis
    const citations = this.createCitations(filteredResults, query)

    // 3. Group by semantic themes
    const contentGroups = this.groupByThemes(citations, query)

    // 4. Generate formatted response with intelligent grouping
    return this.generateGroupedResponse(contentGroups, query)
  }

  private formatNoResults(): string {
    return [
      '## Search Results',
      '',
      '❌ No relevant content found.',
      '',
      '💡 **Tips:**',
      '- Try different keywords',
      '- Lower the similarity threshold',
      '- Rebuild the index',
    ].join('\n')
  }

  private filterAndDeduplicateResults(results: SearchResult[]): SearchResult[] {
    // Sort by similarity and take top results
    const sortedResults = results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5) // Limit to top 5 results

    // Simple deduplication by file path
    const seenPaths = new Set<string>()
    return sortedResults.filter(result => {
      if (seenPaths.has(result.path)) {
        return false
      }
      seenPaths.add(result.path)
      return true
    })
  }

  private createCitations(results: SearchResult[], query: string): FormattedCitation[] {
    return results.map(result => ({
      topic: this.generateTopic(result, query),
      summary: this.generateSummary(result),
      result
    }))
  }

  private generateTopic(result: SearchResult, query: string): string {
    const fileName = result.path.split('/').pop()?.replace(/\.(md|txt|ts|js|py)$/, '') || 'Unknown'

    // Simple topic generation based on filename and query
    if (query.includes('install')) {
      return `Installation guide for ${fileName}`
    }
    if (query.includes('config')) {
      return `Configuration for ${fileName}`
    }
    if (query.includes('usage')) {
      return `How to use ${fileName}`
    }
    if (query.includes('error')) {
      return `Troubleshooting ${fileName}`
    }

    return `About ${fileName}`
  }

  private generateSummary(result: SearchResult): string {
    const content = result.content.trim()

    // Generate a brief summary based on content
    if (content.includes('step')) {
      return 'Step-by-step instructions:'
    }
    if (content.includes('config')) {
      return 'Configuration details:'
    }
    if (content.includes('requirement')) {
      return 'System requirements:'
    }
    if (content.includes('error') || content.includes('problem')) {
      return 'Troubleshooting information:'
    }

    return 'Detailed information:'
  }

  private groupByThemes(citations: FormattedCitation[], query: string): ContentGroup[] {
    const groups = new Map<string, FormattedCitation[]>()

    // Classify citations by semantic themes
    citations.forEach(citation => {
      const theme = this.classifyTheme(citation, query)
      if (!groups.has(theme)) {
        groups.set(theme, [])
      }
      groups.get(theme)!.push(citation)
    })

    // Convert to ContentGroup with priorities and descriptions
    const contentGroups: ContentGroup[] = Array.from(groups.entries()).map(([theme, citations]) => ({
      theme,
      priority: this.calculateThemePriority(theme, query),
      citations: this.sortCitationsWithinTheme(citations),
      description: this.generateThemeDescription(theme, citations.length)
    }))

    // Sort groups by priority
    return contentGroups.sort((a, b) => b.priority - a.priority)
  }

  private classifyTheme(citation: FormattedCitation, query: string): string {
    const content = citation.result.content.toLowerCase()
    const fileName = citation.result.path.toLowerCase()

    // Primary classification based on content analysis
    if (this.isInstallationContent(content, fileName)) {
      return 'Installation & Setup'
    }
    if (this.isConfigurationContent(content, fileName)) {
      return 'Configuration & Customization'
    }
    if (this.isUsageContent(content, fileName)) {
      return 'Usage & Operations'
    }
    if (this.isTroubleshootingContent(content, fileName)) {
      return 'Troubleshooting'
    }
    if (this.isReferenceContent(content, fileName)) {
      return 'Reference & Specifications'
    }

    // Fallback to file-based classification
    if (fileName.includes('readme') || fileName.includes('intro')) {
      return 'Overview & Introduction'
    }
    if (fileName.includes('api') || fileName.includes('reference')) {
      return 'Reference & Specifications'
    }

    return 'Related Information'
  }

  private isInstallationContent(content: string, fileName: string): boolean {
    const installKeywords = ['install', 'setup', 'download']
    return installKeywords.some(keyword => content.includes(keyword) || fileName.includes(keyword))
  }

  private isConfigurationContent(content: string, fileName: string): boolean {
    const configKeywords = ['config', 'configuration', 'environment', 'customize']
    return configKeywords.some(keyword => content.includes(keyword) || fileName.includes(keyword))
  }

  private isUsageContent(content: string, fileName: string): boolean {
    const usageKeywords = ['usage', 'how to', 'step']
    return usageKeywords.some(keyword => content.includes(keyword) || fileName.includes(keyword))
  }

  private isTroubleshootingContent(content: string, fileName: string): boolean {
    const troubleKeywords = ['error', 'problem', 'issue', 'trouble', 'debug']
    return troubleKeywords.some(keyword => content.includes(keyword) || fileName.includes(keyword))
  }

  private isReferenceContent(content: string, fileName: string): boolean {
    const refKeywords = ['api', 'reference', 'spec', 'specification', 'document']
    return refKeywords.some(keyword => content.includes(keyword) || fileName.includes(keyword))
  }

  private calculateThemePriority(theme: string, query: string): number {
    const queryLower = query.toLowerCase()

    // Query-specific priority adjustments
    if (queryLower.includes('install')) {
      if (theme === 'Installation & Setup') return 10
      if (theme === 'Configuration & Customization') return 8
      return 5
    }

    if (queryLower.includes('config')) {
      if (theme === 'Configuration & Customization') return 10
      if (theme === 'Installation & Setup') return 8
      return 5
    }

    if (queryLower.includes('usage')) {
      if (theme === 'Usage & Operations') return 10
      if (theme === 'Overview & Introduction') return 8
      return 5
    }

    if (queryLower.includes('error') || queryLower.includes('problem')) {
      if (theme === 'Troubleshooting') return 10
      return 5
    }

    // Default priorities
    const themePriorities: Record<string, number> = {
      'Installation & Setup': 9,
      'Overview & Introduction': 8,
      'Usage & Operations': 7,
      'Configuration & Customization': 6,
      'Troubleshooting': 5,
      'Reference & Specifications': 4,
      'Related Information': 3
    }

    return themePriorities[theme] || 3
  }

  private sortCitationsWithinTheme(citations: FormattedCitation[]): FormattedCitation[] {
    return citations.sort((a, b) => b.result.similarity - a.result.similarity)
  }

  private generateThemeDescription(theme: string, count: number): string {
    const descriptions: Record<string, string> = {
      'Installation & Setup': 'System installation and setup information',
      'Configuration & Customization': 'Configuration files and customization options',
      'Usage & Operations': 'Basic usage and operation procedures',
      'Troubleshooting': 'Problem solving and error handling',
      'Reference & Specifications': 'API specifications and technical details',
      'Overview & Introduction': 'Overview and basic introduction',
      'Related Information': 'Other related information'
    }

    return descriptions[theme] || 'Related information'
  }

  private generateGroupedResponse(contentGroups: ContentGroup[], query: string): string {
    const sections = contentGroups.map(group => [
      `## ${group.theme}`,
      '',
      `*${group.description}*`,
      '',
      ...group.citations.map(citation => [
        `### ${citation.topic}`,
        '',
        citation.summary,
        '',
        `📝 **${citation.result.path}**`,
        '',
        ...(citation.result.fileUri ? [`**Reference**: ${citation.result.path}`, citation.result.fileUri, ''] : []),
        ...this.formatQuotedContent(citation.result.content),
        ''
      ]).flat()
    ]).flat()

    const allCitations = contentGroups.flatMap(group => group.citations)
    const summary = this.generateOverallSummary(allCitations, query)

    return [
      '# Search Results',
      '',
      ...sections,
      '## Summary',
      '',
      summary,
      '',
      this.generateClaudeGuidance(allCitations, query)
    ].join('\n')
  }

  private formatQuotedContent(content: string): string[] {
    const lines = content.trim().split('\n')

    // Limit to 5 lines for readability
    const limitedLines = lines.slice(0, 5)

    return [
      '', // Empty line before quote
      '> ' + limitedLines.join('\n> '),
      '' // Empty line after quote
    ]
  }

  private generateOverallSummary(citations: FormattedCitation[], query: string): string {
    const topics = citations.map(c => c.topic).join(', ')

    if (query.includes('install')) {
      return `Installation instructions and prerequisites are provided for ${topics}. See the quotes above for details.`
    }
    if (query.includes('config')) {
      return `Configuration methods and important notes are explained for ${topics}.`
    }
    if (query.includes('usage')) {
      return `Usage methods and practical information are provided for ${topics}.`
    }

    return `Related information is provided for ${topics}. Open the files for detailed review as needed.`
  }

  private generateClaudeGuidance(_citations: FormattedCitation[], _query: string): string {
    const guidance = []

    // Context for Claude
    guidance.push('---')
    guidance.push('🔥 **[IMPORTANT] Required Answer Format for Claude:**')
    guidance.push('')
    guidance.push('**When using these search results, strictly follow this format:**')
    guidance.push('')
    guidance.push('```')
    guidance.push('## Heading 1')
    guidance.push('Brief description.')
    guidance.push('')
    guidance.push('**Reference**: filename.md')
    guidance.push('file:///encoded/path')
    guidance.push('> Important quote')
    guidance.push('> (displayed as blockquote)')
    guidance.push('')
    guidance.push('## Heading 2')
    guidance.push('Brief description.')
    guidance.push('')
    guidance.push('**Reference**: filename.md')
    guidance.push('file:///encoded/path')
    guidance.push('> Related quote')
    guidance.push('')
    guidance.push('## Summary')
    guidance.push('Brief overall summary')
    guidance.push('```')
    guidance.push('')
    guidance.push('**Mandatory rules:**')
    guidance.push('1. Add heading (##) for each paragraph')
    guidance.push('2. Always include "**Reference**: filename" and "file://path" in each paragraph')
    guidance.push('3. Display quotes as blockquotes (>)')
    guidance.push('4. Maximum 5 lines of quotes per paragraph')
    guidance.push('5. Add a brief overall summary at the end')
    guidance.push('')
    guidance.push('**Apply this answer format consistently, regardless of context presence.**')

    return guidance.join('\n')
  }
}