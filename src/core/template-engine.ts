import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { existsSync } from 'fs'
import type { SearchResult, AnswerTemplate, GenerateAnswerParams, GenerateReportParams, ReportSection, RAGConfig, TemplateMetadata, GenerateAnswerParamsV2 } from '../types/rag.types.js'
import { sanitizePathGeneric } from '../utils/log-sanitizer.js'

export type TemplateData = {
  query: string
  generated_at: string
  summary: string
  sections: Array<{
    title: string
    content: string
    file_name: string
    file_name_with_line?: string
    file_uri: string
    section_summary?: string
    section_quote?: string
    start_line?: number
    quotes: Array<{ line: string }>
  }>
}

export class TemplateEngine {
  private templatesDir: string
  private config?: RAGConfig

  constructor(templatesDir = './templates', config?: RAGConfig) {
    this.templatesDir = templatesDir
    this.config = config
  }

  setConfig(config: RAGConfig) {
    this.config = config
  }

  async generateAnswer(
    query: string,
    searchResults: SearchResult[],
    params: GenerateAnswerParams
  ): Promise<{ filePath: string; content: string }> {
    // Load template
    const templateName = params.template || 'basic'
    const template = await this.loadTemplate(templateName)

    // Prepare data (async)
    const templateData = await this.prepareTemplateData(query, searchResults)

    // Process template
    const content = this.processTemplate(template.content, templateData)

    // Save report
    const filePath = await this.saveReport(content, params, query)

    return { filePath, content }
  }

  async generateAnswerWithSummaries(
    query: string,
    searchResults: SearchResult[],
    overallSummary: string,
    sectionSummaries: Array<{ file_path: string; summary: string; relevant_quote?: string; start_line?: number }>,
    params: GenerateAnswerParams
  ): Promise<{ filePath: string; content: string }> {
    // Load template
    const templateName = params.template || 'basic'
    const template = await this.loadTemplate(templateName)

    // Prepare data (using summaries)
    const templateData = this.prepareTemplateDataWithSummaries(
      query,
      searchResults,
      overallSummary,
      sectionSummaries
    )

    // Process template
    const content = this.processTemplate(template.content, templateData)

    // Save report
    const filePath = await this.saveReport(content, params, query)

    return { filePath, content }
  }

  async generateReport(
    query: string,
    overallSummary: string,
    sections: ReportSection[],
    params: {
      template?: string
      outputDir?: string
      fileName?: string
    }
  ): Promise<{ filePath: string; content: string }> {
    // Load template
    const templateName = params.template || 'basic'
    const template = await this.loadTemplate(templateName)

    // Prepare section data
    const processedSections = sections.map(section => {
      const fileName = this.extractFileName(section.filePath)
      const absolutePath = resolve(section.filePath)

      // Process citations
      let quote = section.quote
      if (this.config?.report?.removeBlankLines !== false) {
        const lines = quote.split('\n')
        const nonEmptyLines = lines.filter(line => line.trim().length > 0)
        const maxLines = this.config?.report?.maxQuoteLines || 5
        quote = nonEmptyLines.slice(0, maxLines).join('\n')
      }

      // Generate line number link
      const fileUri = section.startLine
        ? `file://${absolutePath}#L${section.startLine}`
        : `file://${absolutePath}`

      return {
        file_name: fileName,
        section_summary: section.summary,
        section_quote: quote,
        file_uri: fileUri,
        start_line: section.startLine,
        end_line: section.endLine
      }
    })

    // Template data
    const templateData = {
      query,
      generated_at: new Date().toLocaleString('ja-JP'),
      summary: overallSummary,
      sections: processedSections
    }

    // Process template
    const content = this.processReportTemplate(template.content, templateData)

    // Save file
    const filePath = await this.saveReport(content, {
      resultIds: [],
      template: params.template,
      outputDir: params.outputDir,
      fileName: params.fileName
    }, query)

    return { filePath, content }
  }

  private processReportTemplate(template: string, data: any): string {
    let result = template

    // Simple variable substitution (outside sections)
    result = result.replace(/\{\{query\}\}/g, data.query)
    result = result.replace(/\{\{generated_at\}\}/g, data.generated_at)
    result = result.replace(/\{\{overall_summary\}\}/g, data.summary)

    // Section processing
    const sectionPattern = /\{\{#sections\}\}([\s\S]*?)\{\{\/sections\}\}/g
    result = result.replace(sectionPattern, (_, sectionTemplate) => {
      return data.sections.map((section: any) => {
        let sectionContent = sectionTemplate
        sectionContent = sectionContent.replace(/\{\{file_name\}\}/g, section.file_name)
        sectionContent = sectionContent.replace(/\{\{section_summary\}\}/g, section.section_summary)
        sectionContent = sectionContent.replace(/\{\{section_quote\}\}/g, section.section_quote)
        sectionContent = sectionContent.replace(/\{\{file_uri\}\}/g, section.file_uri)

        // Conditional line numbers (kept for backward compatibility)
        const startLinePattern = /\{\{#start_line\}\}([\s\S]*?)\{\{\/start_line\}\}/g
        sectionContent = sectionContent.replace(startLinePattern, (_: string, content: string) => {
          return section.start_line ? content.replace(/\{\{start_line\}\}/g, section.start_line) : ''
        })

        return sectionContent
      }).join('\n')
    })

    return result
  }

  private async loadTemplate(templateName: string): Promise<AnswerTemplate> {
    const templatePath = join(this.templatesDir, `${templateName}.md`)

    if (!existsSync(templatePath)) {
      throw new Error(`Template not found: ${templateName}`)
    }

    const content = await readFile(templatePath, 'utf-8')

    // Load metadata file (optional)
    const metadataPath = join(this.templatesDir, `${templateName}.md.json`)
    let metadata: TemplateMetadata | undefined

    if (existsSync(metadataPath)) {
      try {
        const metadataContent = await readFile(metadataPath, 'utf-8')
        metadata = JSON.parse(metadataContent) as TemplateMetadata
      } catch (error) {
        console.warn(`Failed to load metadata for template ${templateName}:`, error)
      }
    }

    return {
      name: templateName,
      description: metadata?.description || `Template: ${templateName}`,
      content,
      metadata
    }
  }

  async getTemplateMetadata(templateName: string = 'basic'): Promise<TemplateMetadata> {
    const template = await this.loadTemplate(templateName)

    if (!template.metadata) {
      throw new Error(`Template ${templateName} does not have metadata. Please create ${templateName}.md.json file.`)
    }

    return template.metadata
  }

  async listTemplates(): Promise<Array<{ name: string; description: string }>> {
    const files = await readdir(this.templatesDir)
    const templates: Array<{ name: string; description: string }> = []

    for (const file of files) {
      if (file.endsWith('.md') && !file.endsWith('.md.json')) {
        const templateName = file.replace(/\.md$/, '')
        try {
          const template = await this.loadTemplate(templateName)
          templates.push({
            name: templateName,
            description: template.description
          })
        } catch (error) {
          console.warn(`Failed to load template ${templateName}:`, error)
        }
      }
    }

    return templates
  }

  async generateAnswerV2(
    params: GenerateAnswerParamsV2
  ): Promise<{ filePath: string; content: string }> {
    const templateName = params.template || 'basic'

    // Load template with error handling
    let template: AnswerTemplate
    try {
      template = await this.loadTemplate(templateName)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to load template '${templateName}': ${errorMessage}`)
    }

    // Process template (inject variables) with error handling
    let content: string
    try {
      content = this.processTemplateV2(template.content, params.variables)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to process template: ${errorMessage}`)
    }

    // Save file
    const outputDir = params.outputDir || process.env.RAG_REPORT_OUTPUT_DIR || './rag-reports'
    const fileName = params.fileName || this.generateFileNameFromVariables(params.variables)

    // Create output directory with error handling
    try {
      if (!existsSync(outputDir)) {
        await mkdir(outputDir, { recursive: true })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to create output directory '${outputDir}': ${errorMessage}`)
    }

    // Generate timestamped filename
    const now = new Date()
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')

    const finalFileName = `${timestamp}_${fileName}`
    const filePath = resolve(join(outputDir, finalFileName))

    // Write file with error handling
    try {
      await writeFile(filePath, content, 'utf-8')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to write report file '${filePath}': ${errorMessage}`)
    }

    return { filePath, content }
  }

  private processTemplateV2(template: string, variables: Record<string, any>): string {
    let result = template

    // Safety check: limit template size to prevent memory issues
    const MAX_TEMPLATE_SIZE = 10 * 1024 * 1024 // 10MB
    if (template.length > MAX_TEMPLATE_SIZE) {
      throw new Error(`Template size exceeds maximum allowed size (${MAX_TEMPLATE_SIZE} bytes)`)
    }

    // Simple variable substitution {{variable_name}}
    for (const [key, value] of Object.entries(variables)) {
      try {
        // Escape special regex characters in variable name
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp(`\\{\\{${escapedKey}\\}\\}`, 'g')

        if (typeof value === 'string') {
          // Multi-line case: preserve indentation for substitution
          result = result.replace(regex, (match: string, offset: number) => {
            return this.preserveIndent(result, offset, value)
          })
        } else if (Array.isArray(value)) {
          // Array case: JSON stringify
          result = result.replace(regex, JSON.stringify(value, null, 2))
        } else if (typeof value === 'object' && value !== null) {
          result = result.replace(regex, JSON.stringify(value, null, 2))
        } else {
          result = result.replace(regex, String(value))
        }
      } catch (error) {
        // Silently skip failed substitutions to avoid excessive logging
        // Continue with other variables
      }
    }

    // Array loop processing {{#array_name}}...{{/array_name}}
    const loopPattern = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g
    result = result.replace(loopPattern, (_, arrayName, loopTemplate) => {
      const arrayData = variables[arrayName]

      if (!Array.isArray(arrayData)) {
        return ''
      }

      // Safety check: limit array size to prevent performance issues
      const MAX_ARRAY_SIZE = 10000
      const dataToProcess = arrayData.length > MAX_ARRAY_SIZE
        ? arrayData.slice(0, MAX_ARRAY_SIZE)
        : arrayData

      return dataToProcess.map((item: any) => {
        let itemContent = loopTemplate

        // If array element is object, substitute its properties
        if (typeof item === 'object' && item !== null) {
          for (const [key, value] of Object.entries(item)) {
            try {
              // Escape special regex characters in variable name
              const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              const itemRegex = new RegExp(`\\{\\{${escapedKey}\\}\\}`, 'g')

              if (typeof value === 'string') {
                // Multi-line case: preserve indentation for substitution
                itemContent = itemContent.replace(itemRegex, (match: string, offset: number) => {
                  return this.preserveIndent(itemContent, offset, value)
                })
              } else {
                itemContent = itemContent.replace(itemRegex, String(value))
              }
            } catch (error) {
              // Silently skip failed substitutions to avoid excessive logging
            }
          }
        } else {
          // Primitive value case: referenced with {{.}}
          itemContent = itemContent.replace(/\{\{\.\}\}/g, String(item))
        }

        return itemContent
      }).join('')
    })

    return result
  }

  private preserveIndent(template: string, offset: number, value: string): string {
    // offset is the position of the placeholder in the template
    if (offset === -1) return value

    // Find line start position of placeholder
    const lineStart = template.lastIndexOf('\n', offset) + 1
    const beforePlaceholder = template.substring(lineStart, offset)

    // Get indentation (whitespace only)
    const indentMatch = beforePlaceholder.match(/^(\s*)/)
    const indent = indentMatch ? indentMatch[1] : ''

    // If value is multi-line, add indentation from line 2 onwards
    const lines = value.split('\n')
    if (lines.length === 1) {
      return value
    }

    return lines.map((line, i) => {
      if (i === 0) {
        return line
      }
      return indent + line
    }).join('\n')
  }

  private generateFileNameFromVariables(variables: Record<string, any>): string {
    // Generate filename from title or query
    const title = variables.title || variables.query || 'report'

    const cleanTitle = String(title)
      .slice(0, 50)
      .replace(/[^\x00-\x7F]/g, '') // Remove non-ASCII characters
      .replace(/[\/\\:*?"<>|]/g, '') // Remove characters not allowed in filenames
      .trim()
      .replace(/\s+/g, '_') // Convert spaces to underscores
      .toLowerCase() // Unify to lowercase

    return `${cleanTitle || 'report'}.md`
  }

  private prepareTemplateDataWithSummaries(
    query: string,
    searchResults: SearchResult[],
    overallSummary: string,
    sectionSummaries: Array<{ file_path: string; summary: string; relevant_quote?: string; start_line?: number }>
  ): TemplateData {
    // Group by file
    const fileGroups = new Map<string, SearchResult[]>()

    for (const result of searchResults) {
      if (!fileGroups.has(result.path)) {
        fileGroups.set(result.path, [])
      }
      fileGroups.get(result.path)!.push(result)
    }

    // Generate sections (only files in section_summaries)
    const sections = sectionSummaries.map(sectionSummary => {
      const path = sectionSummary.file_path
      const results = fileGroups.get(path)

      // Skip if no search results for this file
      if (!results || results.length === 0) {
        console.warn(`Warning: No search results found for file: ${sanitizePathGeneric(path)}`)
        return null
      }

      const summary = sectionSummary.summary

      // Generate citation and get line number
      let quote: string
      let quoteStartLine: number | undefined
      let quoteEndLine: number | undefined

      const firstResult = results[0]
      const chunkStartLine = firstResult.metadata?.startLine

      if (sectionSummary.relevant_quote) {
        // Use Claude-provided relevant part (preserve empty lines)
        const quoteLines = sectionSummary.relevant_quote.split('\n')
        const limitedLines = quoteLines.slice(0, 10) // Max 10 lines (including empty lines)
        quote = limitedLines.join('\n')

        // Use Claude Code provided start_line (it should be the actual quote start line, not chunk start)
        if (sectionSummary.start_line !== undefined) {
          quoteStartLine = sectionSummary.start_line
          quoteEndLine = quoteStartLine + limitedLines.length - 1
        } else if (chunkStartLine !== undefined) {
          // Fallback: if start_line not provided, use chunk start (not ideal but better than nothing)
          console.warn(`Warning: start_line not provided for quote in ${sanitizePathGeneric(path)}, using chunk start line`)
          quoteStartLine = chunkStartLine
          quoteEndLine = chunkStartLine + limitedLines.length - 1
        }
      } else {
        // Default: quote from chunk start (preserve empty lines)
        const lines = firstResult.content.split('\n')
        const limitedLines = lines.slice(0, 10) // Max 10 lines (including empty lines)
        quote = limitedLines.join('\n')
        quoteStartLine = chunkStartLine
        quoteEndLine = quoteStartLine !== undefined ? quoteStartLine + limitedLines.length - 1 : undefined
      }

      const fileName = this.extractFileName(path)
      const absolutePath = resolve(path)

      // Generate file:// format URI (encode path with encodeURI)
      const encodedPath = encodeURI(absolutePath.replace(/\\/g, '/'))
      let fileUri: string
      
      if (quoteStartLine !== undefined && quoteEndLine !== undefined && quoteStartLine !== quoteEndLine) {
        // Line range for multi-line quotes
        fileUri = `file://${encodedPath}#L${quoteStartLine}-L${quoteEndLine}`
      } else if (quoteStartLine !== undefined) {
        // Single line
        fileUri = `file://${encodedPath}#L${quoteStartLine}`
      } else {
        // No line number
        fileUri = `file://${encodedPath}`
      }

      // Generate filename with line number
      const fileNameWithLine = quoteStartLine !== undefined
        ? (quoteEndLine !== undefined && quoteStartLine !== quoteEndLine 
            ? `${fileName}:${quoteStartLine}-${quoteEndLine}`
            : `${fileName}:${quoteStartLine}`)
        : fileName

      return {
        title: fileName,
        content: summary,
        file_name: fileName,
        file_name_with_line: fileNameWithLine,
        section_summary: summary,
        section_quote: quote,
        file_uri: fileUri,
        start_line: quoteStartLine,
        end_line: quoteEndLine,
        quotes: [{ line: quote }] // For backward compatibility
      }
    }).filter(section => section !== null) // Exclude nulls

    return {
      query,
      generated_at: new Date().toLocaleString('ja-JP'),
      summary: overallSummary,
      sections
    }
  }

  private async prepareTemplateData(query: string, searchResults: SearchResult[]): Promise<TemplateData> {
    // Fallback method (not used when Claude provides summaries)
    const fileGroups = new Map<string, SearchResult[]>()

    for (const result of searchResults) {
      if (!fileGroups.has(result.path)) {
        fileGroups.set(result.path, [])
      }
      fileGroups.get(result.path)!.push(result)
    }

    const sections = Array.from(fileGroups.entries()).map(([path, results]) => {
      const quotes = results.slice(0, 5).map(result => {
        const lines = result.content.trim().split('\n')
        const limitedLines = lines.slice(0, 5)
        return {
          line: limitedLines.join('\n')
        }
      })

      return {
        title: this.extractFileName(path),
        content: 'Contains relevant information.',
        file_name: this.extractFileName(path),
        file_uri: results[0].fileUri || `file://${resolve(path)}`,
        quotes
      }
    })

    return {
      query,
      generated_at: new Date().toLocaleString('en-US'),
      summary: 'Please review the search results.',
      sections
    }
  }

  private processTemplate(template: string, data: TemplateData): string {
    let result = template

    // Simple variable substitution
    result = result.replace(/\{\{query\}\}/g, data.query)
    result = result.replace(/\{\{generated_at\}\}/g, data.generated_at)
    result = result.replace(/\{\{summary\}\}/g, data.summary)
    result = result.replace(/\{\{overall_summary\}\}/g, data.summary) // Also support overall_summary

    // Section processing (basic loop)
    const sectionPattern = /\{\{#sections\}\}([\s\S]*?)\{\{\/sections\}\}/g
    result = result.replace(sectionPattern, (_, sectionTemplate) => {
      return data.sections.map(section => {
        let sectionContent = sectionTemplate
        sectionContent = sectionContent.replace(/\{\{title\}\}/g, section.title)
        sectionContent = sectionContent.replace(/\{\{content\}\}/g, section.content)
        sectionContent = sectionContent.replace(/\{\{file_name\}\}/g, section.file_name)
        sectionContent = sectionContent.replace(/\{\{file_name_with_line\}\}/g, section.file_name_with_line || section.file_name)
        sectionContent = sectionContent.replace(/\{\{file_uri\}\}/g, section.file_uri)
        // Also support new format variables
        sectionContent = sectionContent.replace(/\{\{section_summary\}\}/g, section.section_summary || section.content)
        sectionContent = sectionContent.replace(/\{\{section_quote\}\}/g, section.section_quote || '')

        // Citation processing
        const quotesPattern = /\{\{#quotes\}\}([\s\S]*?)\{\{\/quotes\}\}/g
        sectionContent = sectionContent.replace(quotesPattern, (_: string, quoteTemplate: string) => {
          return section.quotes.map((quote) => {
            return quoteTemplate.replace(/\{\{line\}\}/g, quote.line)
          }).join('')
        })

        return sectionContent
      }).join('\n')
    })

    return result
  }

  private async saveReport(
    content: string,
    params: GenerateAnswerParams,
    query: string
  ): Promise<string> {
    const outputDir = params.outputDir || process.env.RAG_REPORT_OUTPUT_DIR || './rag-reports'

    // Create directory
    if (!existsSync(outputDir)) {
      await mkdir(outputDir, { recursive: true })
    }

    // Generate filename (add timestamp even if file_name is specified)
    let fileName: string
    if (params.fileName) {
      // Generate timestamp
      const now = new Date()
      const timestamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        '_',
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join('')

      // Separate extension
      const extMatch = params.fileName.match(/^(.+)(\.[^.]+)$/)
      if (extMatch) {
        fileName = `${timestamp}_${extMatch[1]}${extMatch[2]}`
      } else {
        fileName = `${timestamp}_${params.fileName}`
      }
    } else {
      fileName = this.generateFileName(query)
    }

    const filePath = join(outputDir, fileName)

    // Write file
    await writeFile(filePath, content, 'utf-8')

    return resolve(filePath)
  }

  private generateFileName(query: string): string {
    // Timestamp in YYYYMMDD_HHMMSS format
    const now = new Date()
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')

    // Generate title (ASCII only, exclude Japanese)
    const cleanQuery = query
      .slice(0, 50)
      .replace(/[^\x00-\x7F]/g, '') // Remove non-ASCII characters (Japanese, etc.)
      .replace(/[\/\\:*?"<>|]/g, '') // Remove characters not allowed in filenames
      .trim()
      .replace(/\s+/g, '_') // Convert spaces to underscores

    const title = cleanQuery || 'search'
    return `${timestamp}_${title}.md`
  }

  private extractFileName(path: string): string {
    return path.split('/').pop() || path
  }
}