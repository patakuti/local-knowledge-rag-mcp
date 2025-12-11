# Template Customization Guide

Complete guide to creating and customizing report templates for Local Knowledge RAG MCP Server.

---

## Overview

Templates control how RAG search results are formatted into Markdown reports. The system uses a simple variable substitution and loop syntax.

---

## Built-in Templates

### basic

Simple report format with file-based sections.

**Variables:**
- `query` (string): The search query
- `generated_at` (string): Generation timestamp
- `overall_summary` (string): Overall findings summary
- `sections` (array): Array of section objects

**Section object:**
- `file_name_with_line` (string): File path with line numbers
- `file_uri` (string): Clickable file URI
- `section_summary` (string): Section description
- `section_quote` (string): Code/text quote

### paper

Academic paper style with numbered citations.

**Variables:**
- `title` (string): Report title
- `generated_at` (string): Generation timestamp
- `abstract` (string): Abstract summarizing the findings
- `body` (string): Main body text with numbered citations like `[[1]](#ref-1)`
- `references` (array): Array of reference objects

**Reference object:**
- `id` (string): Citation number (e.g., "1", "2")
- `file_path` (string): Relative file path
- `line_range` (string): Line range (e.g., "42-50")
- `file_uri` (string): Full file URI with line anchor
- `quote_preview` (string): Short preview of the quoted content (1-2 lines)

**Important:** Do NOT merge references from the same file - each citation should have its own unique reference number even if they are from the same document.

### bullet_points

Bullet points style for quick summaries.

**Variables:**
- `title` (string): Report title
- `points` (array): Array of bullet point strings

### manual

General manual/handbook style with numbered chapters and sources.

**Variables:**
- `title` (string): Manual title
- `generated_at` (string): Generation timestamp
- `overview` (string): Overview section summary
- `chapters` (array): Array of chapter objects
- `sources` (array): Array of source objects

**Chapter object:**
- `number` (string): Chapter number
- `chapter_title` (string): Chapter title
- `content` (string): Chapter content with citations like `[[1]](#ref-1)`

**Source object:**
- `id` (string): Source number
- `file_path` (string): File path
- `line_range` (string): Line range
- `file_uri` (string): Clickable file URI
- `quote_preview` (string): Short preview of the quoted content (1-2 lines)

**Important:** Do NOT merge sources from the same file - each citation should have its own unique source number even if they are from the same document.

---

## Template Syntax

### Variable Substitution

Simple variables use `{{variable_name}}`:

```markdown
# {{title}}

Generated: {{generated_at}}
```

### Loops

Arrays use `{{#array}}...{{/array}}`:

```markdown
{{#sections}}
## {{file_name}}

{{section_summary}}

{{/sections}}
```

### Nested Objects

Access nested properties with dot notation:

```markdown
{{#sections}}
File: {{metadata.path}}
{{/sections}}
```

---

## Creating Custom Templates

### Step 1: Create Template File

Create `./templates/your-template-name.md`:

```markdown
# {{title}}

**Generated:** {{generated_at}}
**Query:** {{query}}

## Summary

{{overall_summary}}

## Findings

{{#sections}}
### {{file_name_with_line}}

**Summary:** {{section_summary}}

**Code:**
```
{{section_quote}}
```

[View in editor]({{file_uri}})

---

{{/sections}}

## Conclusion

Total findings: {{sections.length}}
```

### Step 2: Create Metadata File (Optional)

Create `./templates/your-template-name.md.json`:

```json
{
  "name": "your-template-name",
  "description": "Brief description of this template",
  "variables": {
    "title": {
      "type": "string",
      "description": "Report title",
      "required": true
    },
    "generated_at": {
      "type": "string",
      "description": "Generation timestamp",
      "required": true
    },
    "query": {
      "type": "string",
      "description": "The search query",
      "required": true
    },
    "overall_summary": {
      "type": "string",
      "description": "Overall findings summary",
      "required": true
    },
    "sections": {
      "type": "array",
      "description": "Array of finding sections",
      "required": true,
      "items": {
        "type": "object",
        "properties": {
          "file_name_with_line": {
            "type": "string",
            "description": "File path with line numbers"
          },
          "file_uri": {
            "type": "string",
            "description": "Clickable file URI"
          },
          "section_summary": {
            "type": "string",
            "description": "Section description"
          },
          "section_quote": {
            "type": "string",
            "description": "Code/text quote"
          }
        }
      }
    }
  }
}
```

### Step 3: Use the Template

```json
{
  "tool": "create_rag_report",
  "arguments": {
    "template": "your-template-name",
    "variables": {
      "title": "My Analysis",
      "generated_at": "2025-11-16 14:30:00",
      "query": "React hooks",
      "overall_summary": "...",
      "sections": [...]
    }
  }
}
```

---

## Template Examples

### Example 1: Minimal Template

`templates/minimal.md`:
```markdown
# {{query}}

{{#sections}}
- {{file_name}}: {{section_summary}}
{{/sections}}
```

### Example 2: Detailed Technical Report

`templates/technical.md`:
```markdown
# Technical Analysis: {{query}}

**Date:** {{generated_at}}

---

## Executive Summary

{{overall_summary}}

---

## Detailed Findings

{{#sections}}
### Finding {{@index}}: {{section_summary}}

**Location:** `{{file_name_with_line}}`

**Relevance Score:** {{similarity_score}}

**Code Sample:**

\`\`\`{{language}}
{{section_quote}}
\`\`\`

**Analysis:**
{{analysis}}

[→ Open in editor]({{file_uri}})

---

{{/sections}}

## Statistics

- Total Findings: {{sections.length}}
- Avg Similarity: {{avg_similarity}}
- Time Taken: {{duration}}
```

### Example 3: Comparison Report

`templates/comparison.md`:
```markdown
# Comparison Report: {{query}}

## Approach A

{{#approach_a_sections}}
- {{file_name}}: {{section_summary}}
{{/approach_a_sections}}

## Approach B

{{#approach_b_sections}}
- {{file_name}}: {{section_summary}}
{{/approach_b_sections}}

## Recommendation

{{recommendation}}
```

---

## Advanced Features

### Conditional Rendering

Check if array has items:

```markdown
{{#sections}}
Found {{sections.length}} results.
{{/sections}}

{{^sections}}
No results found.
{{/sections}}
```

### Index Access

Access loop index with `{{@index}}`:

```markdown
{{#sections}}
{{@index}}. {{file_name}}
{{/sections}}
```

### Escaping

Prevent variable substitution:

```markdown
\{{this_will_not_be_replaced}}
```

---

## Best Practices

### 1. Provide Clear Structure

Use headers and sections to organize content:

```markdown
# {{title}}

## Summary
...

## Details
...

## References
...
```

### 2. Include Metadata

Always include generation metadata:

```markdown
**Generated:** {{generated_at}}
**Query:** {{query}}
**Results:** {{sections.length}}
```

### 3. Make Content Clickable

Use file URIs for easy navigation:

```markdown
[View source]({{file_uri}})
```

### 4. Format Code Properly

Use code blocks with language hints:

```markdown
\`\`\`{{language}}
{{section_quote}}
\`\`\`
```

### 5. Provide Context

Include summaries before details:

```markdown
## {{section_title}}

{{section_summary}}

### Details

{{section_details}}
```

---

## Template Variables Reference

### Common Variables

| Variable | Type | Description |
|----------|------|-------------|
| `query` | string | The search query |
| `generated_at` | string | Generation timestamp |
| `overall_summary` | string | Overall findings summary |
| `sections` | array | Array of finding sections |

### Section Object Properties

| Property | Type | Description |
|----------|------|-------------|
| `file_name` | string | File name only |
| `file_path` | string | Full file path |
| `file_name_with_line` | string | File path with line numbers |
| `file_uri` | string | Clickable VS Code URI |
| `section_summary` | string | Section description |
| `section_quote` | string | Code/text quote |
| `similarity_score` | number | Similarity score (0.0-1.0) |
| `language` | string | Detected programming language |

---

## Troubleshooting

### Template Not Found

**Problem:**
```
Error: Template 'custom' not found
```

**Solutions:**
1. Check file exists: `ls -la templates/custom.md`
2. Verify file name matches (case-sensitive)
3. Use built-in template names: `basic`, `paper`, `bullet_points`

### Missing Variables Error

**Problem:**
```
Error: Required variable 'sections' is missing
```

**Solution:**

Get template schema to see required variables:
```json
{
  "tool": "get_template_schema",
  "arguments": {
    "template": "your-template-name"
  }
}
```

### Template Rendering Issues

**Problem:** Variables not being substituted

**Solutions:**
1. Check variable names match exactly (case-sensitive)
2. Verify syntax: `{{variable}}` not `{variable}`
3. Check array syntax: `{{#array}}...{{/array}}`

---

## Template Development Workflow

### 1. Plan Your Template

Decide:
- What information to include
- How to organize sections
- Visual hierarchy

### 2. Create Template File

Start with a working template and modify:

```bash
cp templates/basic.md templates/my-template.md
```

### 3. Create Metadata (Optional)

Define expected variables:

```bash
cat > templates/my-template.md.json <<EOF
{
  "name": "my-template",
  "description": "My custom template",
  "variables": {
    ...
  }
}
EOF
```

### 4. Test Template

Generate a report with sample data:

```json
{
  "tool": "create_rag_report",
  "arguments": {
    "template": "my-template",
    "variables": {
      "title": "Test Report",
      ...
    }
  }
}
```

### 5. Iterate and Refine

Review generated report and adjust template as needed.

---

## See Also

- [MCP Tools Reference](mcp-tools.md) - Using `create_rag_report` tool
- [Configuration Guide](configuration.md) - Setting default template
- [Troubleshooting](troubleshooting.md) - Common template issues
