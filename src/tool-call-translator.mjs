import { randomUUID } from 'node:crypto'

const TOOL_END = '</tool_call>'
const TOOL_START_LITERAL = '<tool_call>'

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools.filter(tool => tool?.type === 'function' && tool.function?.name)
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function isDeclaredToolName(name, tools) {
  if (!name) return false
  return tools.some(tool => tool.function?.name === name)
}

function getToolProperties(tool) {
  const props = tool?.function?.parameters?.properties
  return props && typeof props === 'object' ? props : {}
}

function inferToolNameFromArguments(args, tools) {
  const keys = Object.keys(args || {})
  if (keys.length === 0) return ''
  const matches = tools.filter(tool => keys.every(key => Object.prototype.hasOwnProperty.call(getToolProperties(tool), key)))
  return matches.length === 1 ? matches[0].function.name : ''
}

function decodeXmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function coerceXmlValue(rawValue) {
  const value = decodeXmlEntities(String(rawValue || '').trim())
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    const parsed = safeJsonParse(value)
    if (parsed !== null) return parsed
  }
  return value
}

function extractToolNameFromXml(openTag, block) {
  const attrMatch = `${openTag}\n${block}`.match(/<tool_call\b[^>]*\bname\s*=\s*["']([^"']+)["']/i)
  if (attrMatch) return decodeXmlEntities(attrMatch[1].trim())

  const nameMatch = block.match(/<name>([\s\S]*?)<\/name>/i)
  if (nameMatch) return decodeXmlEntities(nameMatch[1].trim())

  return ''
}

function normalizeParsedArguments(value) {
  if (typeof value === 'string') {
    const parsed = safeJsonParse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function parseToolCallObject(parsed, tools) {
  if (!parsed || typeof parsed !== 'object') return null

  const name = parsed.name || parsed.function?.name || parsed.tool_name || parsed.tool
  if (!name || typeof name !== 'string') return null
  if (!isDeclaredToolName(name, tools)) return null

  const args = normalizeParsedArguments(
    parsed.arguments ?? parsed.function?.arguments ?? parsed.args ?? parsed.parameters ?? parsed.input ?? {}
  )

  return {
    id: parsed.id || parsed.tool_call_id || `call_${randomUUID().replace(/-/g, '')}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

function parseJsonToolCalls(text, tools) {
  const results = []
  const parsedWhole = safeJsonParse(text)

  if (Array.isArray(parsedWhole)) {
    for (const item of parsedWhole) {
      const parsed = parseToolCallObject(item, tools)
      if (parsed) results.push(parsed)
    }
    return results
  }

  if (parsedWhole && typeof parsedWhole === 'object') {
    const parsed = parseToolCallObject(parsedWhole, tools)
    if (parsed) results.push(parsed)
    return results
  }

  if (!text.includes('\n')) return results

  for (const line of text.split('\n').map(part => part.trim()).filter(Boolean)) {
    if (!(line.startsWith('{') && line.endsWith('}'))) continue
    const parsed = parseToolCallObject(safeJsonParse(line), tools)
    if (parsed) results.push(parsed)
  }

  return results
}

function parseXmlParameterToolCall(openTag, block, tools) {
  const args = {}
  const parameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi
  let match = parameterRe.exec(block)

  while (match) {
    args[match[1]] = coerceXmlValue(match[2])
    match = parameterRe.exec(block)
  }

  if (Object.keys(args).length === 0) return null

  const name = extractToolNameFromXml(openTag, block) || inferToolNameFromArguments(args, tools)
  if (!isDeclaredToolName(name, tools)) return null

  return {
    id: `call_${randomUUID().replace(/-/g, '')}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

function parseToolCallBlock(openTag, block, tools) {
  const xmlParsed = parseXmlParameterToolCall(openTag, block, tools)
  if (xmlParsed) return xmlParsed

  const jsonParsed = parseJsonToolCalls(block.trim(), tools)
  if (jsonParsed.length > 0) {
    const preferredName = extractToolNameFromXml(openTag, block)
    if (preferredName && isDeclaredToolName(preferredName, tools)) {
      jsonParsed[0].function.name = preferredName
    }
    return jsonParsed[0]
  }

  return null
}

function advanceMarkdownCodeState(text, initialDelimiterLength = 0) {
  let delimiterLength = initialDelimiterLength

  for (let i = 0; i < text.length; ) {
    if (text[i] !== '`') {
      i++
      continue
    }

    let runLength = 1
    while (i + runLength < text.length && text[i + runLength] === '`') runLength++

    if (delimiterLength === 0) delimiterLength = runLength
    else if (runLength >= delimiterLength) delimiterLength = 0

    i += runLength
  }

  return delimiterLength
}

function findNextToolOpenTagOutsideMarkdown(buffer, initialDelimiterLength = 0) {
  let delimiterLength = initialDelimiterLength

  for (let i = 0; i < buffer.length; ) {
    if (buffer[i] === '`') {
      let runLength = 1
      while (i + runLength < buffer.length && buffer[i + runLength] === '`') runLength++

      if (delimiterLength === 0) delimiterLength = runLength
      else if (runLength >= delimiterLength) delimiterLength = 0

      i += runLength
      continue
    }

    if (delimiterLength === 0) {
      const match = buffer.substring(i).match(/^<tool_call\b[^>]*>/i)
      if (match) return { index: i, openTag: match[0] }
    }

    i++
  }

  return null
}

function findPartialToolOpenIndexOutsideMarkdown(buffer, initialDelimiterLength = 0) {
  let delimiterLength = initialDelimiterLength
  const lowerToolStart = TOOL_START_LITERAL.toLowerCase()

  for (let i = 0; i < buffer.length; ) {
    if (buffer[i] === '`') {
      let runLength = 1
      while (i + runLength < buffer.length && buffer[i + runLength] === '`') runLength++

      if (delimiterLength === 0) delimiterLength = runLength
      else if (runLength >= delimiterLength) delimiterLength = 0

      i += runLength
      continue
    }

    if (delimiterLength === 0 && buffer[i] === '<') {
      const tailLower = buffer.substring(i).toLowerCase()
      if (tailLower.startsWith('<tool_call') && tailLower.indexOf('>') === -1) return i
      if (lowerToolStart.startsWith(tailLower)) return i
    }

    i++
  }

  return -1
}

const WORKSPACE_TOOL_PRIORITY = [
  'glob',
  'grep',
  'read',
  'read_file',
  'list_files',
  'bash',
  'shell',
  'execute_command',
  'write',
  'write_file',
  'edit',
  'apply_patch',
  'todowrite',
  'todo_write',
]

function compactSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 3) return schema
  if (Array.isArray(schema)) return schema.map(item => compactSchema(item, depth + 1))

  const out = {}
  if (schema.type) out.type = schema.type
  if (schema.description && String(schema.description).length <= 120) {
    out.description = String(schema.description)
  } else if (schema.description) {
    out.description = `${String(schema.description).slice(0, 117)}...`
  }
  if (Array.isArray(schema.required)) out.required = schema.required
  if (schema.enum) out.enum = schema.enum
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {}
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = compactSchema(value, depth + 1)
    }
  }
  if (schema.items) out.items = compactSchema(schema.items, depth + 1)
  return out
}

function stringifyToolForPrompt(tool) {
  const description = String(tool.function.description || '')
  return {
    name: tool.function.name,
    description: description.length > 180 ? `${description.slice(0, 177)}...` : description,
    parameters: compactSchema(tool.function.parameters || { type: 'object', properties: {} }),
  }
}

function prioritizeTools(tools) {
  const rank = new Map(WORKSPACE_TOOL_PRIORITY.map((name, index) => [name, index]))
  return [...tools].sort((a, b) => {
    const an = a.function?.name || ''
    const bn = b.function?.name || ''
    const ar = rank.has(an) ? rank.get(an) : 1000
    const br = rank.has(bn) ? rank.get(bn) : 1000
    if (ar !== br) return ar - br
    return an.localeCompare(bn)
  })
}

export function buildToolInstructions(tools, toolChoice) {
  const normalizedTools = prioritizeTools(normalizeTools(tools))
  if (normalizedTools.length === 0 || toolChoice === 'none') return ''

  // OpenCode can send 50+ tools (MCPs). Dumping full schemas blows the Kimi
  // context and causes the model to ignore tool-first rules. Keep a compact
  // primary list + name-only catalog for the rest.
  const primaryLimit = 16
  const primary = normalizedTools.slice(0, primaryLimit).map(stringifyToolForPrompt)
  const restNames = normalizedTools.slice(primaryLimit).map(t => t.function.name)

  const jsonTools = JSON.stringify(primary, null, 2)
  const toolOpen = '<' + 'tool_call>'
  const toolClose = '</' + 'tool_call>'

  let instructions =
    'TOOLS AVAILABLE (compact — real IDE tools, not Kimi sandbox tools)\n' +
    `${jsonTools}\n\n`

  if (restNames.length > 0) {
    instructions +=
      `ADDITIONAL TOOL NAMES (${restNames.length}): ${restNames.join(', ')}\n` +
      'You may call those names too when needed; keep arguments minimal JSON objects.\n\n'
  }

  instructions +=
    'WORKSPACE TOOL-FIRST BEHAVIOR\n' +
    'You have real local workspace tools from the IDE client. They are the only way to see files.\n' +
    'For ANY question about the project, files, folders, package name, code, workspace, "o que tem aqui", "o site", or "olha o projeto": call tools FIRST. Do not answer with a guessed tree.\n' +
    'Typical first step: glob/list the working directory, then read the relevant files (package.json, src/*, README).\n' +
    'If the user asks you to inspect, verify, review, fix, compare, or evaluate code or files, call relevant tools first instead of asking the user to paste the code.\n' +
    'If file search tools are available, use them to locate likely files before concluding that a file cannot be found.\n' +
    'If the exact file path is uncertain and both search and read tools are available, call the search tool first and only call the read tool after you have a likely path.\n' +
    'Do not invent folders like upload/ or output/. Do not describe a fictional empty agent workspace.\n' +
    'Do not reply with multiple-choice menus asking where the project is when tools can list the workspace.\n\n' +
    'TOOL CALLING FORMAT\n' +
    'When you need a tool, answer with tool calls instead of prose. Preferred format:\n' +
    `${toolOpen}\n` +
    '{"name":"tool_name","arguments":{"param":"value"}}\n' +
    `${toolClose}\n\n` +
    'Alternative XML format also accepted:\n' +
    '<tool_call name="tool_name">\n' +
    '<parameter name="param">value</parameter>\n' +
    '</tool_call>\n\n' +
    'RULES\n' +
    '1. Only call declared tools.\n' +
    '2. Arguments must be valid JSON-compatible values.\n' +
    '3. If calling tools, stop after emitting the tool call blocks. No explanatory prose before the first tool call when inspection is needed.\n' +
    '4. You may emit multiple consecutive tool_call blocks when needed.\n' +
    '5. Do not wrap tool calls in Markdown code fences.\n'

  if (toolChoice === 'required') {
    instructions += '6. You must call at least one tool in this response.\n'
  } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function?.name) {
    instructions += `6. You must call the tool \"${toolChoice.function.name}\" in this response.\n`
  }

  return instructions
}

export function toolCallsToTaggedText(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return ''
  return toolCalls
    .map(toolCall => {
      const args = normalizeParsedArguments(toolCall?.function?.arguments ?? {})
      return `<tool_call>\n${JSON.stringify({ name: toolCall.function.name, arguments: args })}\n</tool_call>`
    })
    .join('\n')
}

const TOOL_ECHO_MARKERS = [
  'Tool result (',
  'from the EXTERNAL IDE',
  '<path>',
  '</path>',
  '<type>file</type>',
  '<content>',
  '</content>',
  'Read my-',
  'Read docs\\',
  'Read noxstream',
  'Glob "',
  'User:\nTool result',
  'call_',
]

export function stripToolEchoFromContent(text) {
  if (!text) return text
  let out = String(text)

  // Drop fenced dumps that re-print prior tool transcripts
  out = out.replace(/```[\s\S]*?(?:Tool result \(|<path>|Read [^\n]+\n)[\s\S]*?```/gi, '')

  // Drop lines that clearly re-echo tool plumbing
  out = out
    .split('\n')
    .filter(line => {
      const t = line.trim()
      if (!t) return true
      if (/^Tool result \(/i.test(t)) return false
      if (/^from the EXTERNAL IDE/i.test(t)) return false
      if (/^Treat the lines above as ground truth/i.test(t)) return false
      if (/^Do NOT re-print this tool dump/i.test(t)) return false
      if (/^Summarize or act with another tool call only/i.test(t)) return false
      if (/^<\/?(?:path|type|content)>/i.test(t)) return false
      if (/^Read\s+\S+\.(?:js|ts|tsx|mjs|cjs|json|md|html|css)\b/i.test(t)) return false
      if (/^Glob\s+"/i.test(t)) return false
      if (/^\(Results are truncated/i.test(t)) return false
      if (/^User:\s*$/i.test(t)) return false
      if (/^Assistant:\s*$/i.test(t)) return false
      return true
    })
    .join('\n')

  // If the model mostly pasted a tool dump, drop the whole content
  const markerHits = TOOL_ECHO_MARKERS.reduce((n, marker) => (out.includes(marker) ? n + 1 : n), 0)
  if (markerHits >= 2 && out.length > 400) {
    // Keep only the prefix before the first strong dump marker
    const cutPoints = [
      out.indexOf('Tool result ('),
      out.indexOf('<path>'),
      out.search(/\nRead\s+\S+\./i),
      out.indexOf('from the EXTERNAL IDE'),
    ].filter(i => i >= 0)
    if (cutPoints.length > 0) {
      out = out.slice(0, Math.min(...cutPoints)).trim()
    }
  }

  out = out.replace(/\n{3,}/g, '\n\n').trim()
  return out
}

export class ToolCallStreamTranslator {
  constructor(tools) {
    this.tools = normalizeTools(tools)
    this.buffer = ''
    this.markdownDelimiterLength = 0
    this.currentOpenTag = null
    this.insideTool = false
    this.seenToolCalls = []
  }

  emitContent(events, content) {
    if (!content) return
    const cleaned = stripToolEchoFromContent(content)
    if (!cleaned) return
    events.push({ type: 'content', content: cleaned })
    this.markdownDelimiterLength = advanceMarkdownCodeState(cleaned, this.markdownDelimiterLength)
  }

  emitToolCall(events, toolCall) {
    this.seenToolCalls.push(toolCall)
    events.push({ type: 'tool_call', toolCall })
  }

  push(chunk) {
    if (!chunk) return []
    this.buffer += chunk
    return this.drain(false)
  }

  flush() {
    return this.drain(true)
  }

  drain(isFinal) {
    const events = []

    if (this.tools.length === 0) {
      const content = this.buffer
      this.buffer = ''
      this.emitContent(events, content)
      return events
    }

    while (this.buffer) {
      if (!this.insideTool) {
        const open = findNextToolOpenTagOutsideMarkdown(this.buffer, this.markdownDelimiterLength)

        if (!open) {
          const partialIndex = isFinal ? -1 : findPartialToolOpenIndexOutsideMarkdown(this.buffer, this.markdownDelimiterLength)
          if (partialIndex !== -1) {
            // Hold prose before a likely tool open so we can drop it if a tool call follows.
            break
          }

          if (!isFinal) {
            // Hold trailing content while stream is open: Kimi often emits prose then a tool call.
            // Emitting early causes OpenCode to show junk before structured tool_calls.
            break
          }

          const visible = this.buffer
          this.buffer = ''
          this.emitContent(events, visible)
          break
        }

        // Structured tool call found: drop any leading monologue for this turn.
        // Clients already show tool_calls; prose before them is usually sandbox noise.
        this.buffer = this.buffer.slice(open.index + open.openTag.length)
        this.currentOpenTag = open.openTag
        this.insideTool = true
        continue
      }

      const closeIndex = this.buffer.toLowerCase().indexOf(TOOL_END)
      if (closeIndex === -1) {
        if (!isFinal) break

        const recovered = parseToolCallBlock(this.currentOpenTag || TOOL_START_LITERAL, this.buffer, this.tools)
        if (recovered) this.emitToolCall(events, recovered)
        // If recovery fails, do not leak raw <tool_call>... as assistant content.

        this.buffer = ''
        this.currentOpenTag = null
        this.insideTool = false
        break
      }

      const block = this.buffer.slice(0, closeIndex)
      this.buffer = this.buffer.slice(closeIndex + TOOL_END.length)

      const parsed = parseToolCallBlock(this.currentOpenTag || TOOL_START_LITERAL, block, this.tools)
      if (parsed) this.emitToolCall(events, parsed)
      // Do not re-emit unparsed tool tags as visible content.

      this.currentOpenTag = null
      this.insideTool = false
    }

    return events
  }
}

export function extractToolCallsFromText(text, tools) {
  const normalizedTools = normalizeTools(tools)
  const translator = new ToolCallStreamTranslator(tools)
  const events = [...translator.push(text || ''), ...translator.flush()]

  let content = ''
  const toolCalls = []
  for (const event of events) {
    if (event.type === 'content') content += event.content
    else if (event.type === 'tool_call') toolCalls.push(event.toolCall)
  }

  if (toolCalls.length === 0 && normalizedTools.length > 0) {
    const trimmed = String(text || '').trim()
    const rawJsonToolCalls = parseJsonToolCalls(trimmed, normalizedTools)
    if (rawJsonToolCalls.length > 0) {
      return {
        content: null,
        tool_calls: rawJsonToolCalls,
        finish_reason: 'tool_calls',
      }
    }
  }

  // If the model emitted tool calls, drop residual prose for this turn.
  // OpenCode/Roo only need structured tool_calls until the next user/tool step.
  if (toolCalls.length > 0) {
    return {
      content: null,
      tool_calls: toolCalls,
      finish_reason: 'tool_calls',
    }
  }

  const cleaned = stripToolEchoFromContent(content)
  const normalizedContent = cleaned.trim() === '' ? null : cleaned

  return {
    content: normalizedContent,
    tool_calls: undefined,
    finish_reason: 'stop',
  }
}
