import { toOpenAIChunk, toOpenAIComplete } from './openai-mapper.mjs'
import { extractToolCallsFromText, ToolCallStreamTranslator } from './tool-call-translator.mjs'

function normalizeAssistantPayload(translated) {
  // Never ship both tool_calls and residual monologue/tool-echo content.
  if (translated.tool_calls?.length) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: translated.tool_calls,
    }
  }
  return {
    role: 'assistant',
    content: translated.content,
    tool_calls: undefined,
  }
}

function toolCallDeltaChunks(completionId, model, toolCall, index) {
  return [
    toOpenAIChunk(completionId, model, {
      tool_calls: [{
        index,
        id: toolCall.id,
        type: 'function',
        function: { name: toolCall.function.name },
      }],
    }),
    toOpenAIChunk(completionId, model, {
      tool_calls: [{
        index,
        function: { arguments: toolCall.function.arguments },
      }],
    }),
  ]
}

export function buildCompleteOpenAIResponse(completionId, model, fullText, tools) {
  const translated = extractToolCallsFromText(fullText, tools)
  return toOpenAIComplete(completionId, model, normalizeAssistantPayload(translated))
}

export class OpenAIStreamResponseTranslator {
  constructor(completionId, model, tools) {
    this.completionId = completionId
    this.model = model
    this.toolTranslator = new ToolCallStreamTranslator(tools)
    this.snapshot = ''
    this.toolCallCount = 0
    this.emittedToolCalls = false
  }

  startChunks() {
    return [toOpenAIChunk(this.completionId, this.model, { role: 'assistant' })]
  }

  pushTextOperation(extracted) {
    const deltaText = this.computeDeltaText(extracted)
    if (!deltaText) return []

    const events = this.toolTranslator.push(deltaText)
    return this.eventsToChunks(events)
  }

  flushChunks() {
    const chunks = this.eventsToChunks(this.toolTranslator.flush())
    chunks.push(
      toOpenAIChunk(
        this.completionId,
        this.model,
        {},
        this.emittedToolCalls ? 'tool_calls' : 'stop',
      ),
    )
    return chunks
  }

  computeDeltaText(extracted) {
    if (!extracted?.content) return ''

    if (extracted.op === 'append') {
      this.snapshot += extracted.content
      return extracted.content
    }

    if (extracted.op === 'set') {
      const nextSnapshot = extracted.content
      let delta = nextSnapshot

      if (nextSnapshot.startsWith(this.snapshot)) {
        delta = nextSnapshot.slice(this.snapshot.length)
      } else if (this.snapshot.startsWith(nextSnapshot)) {
        delta = ''
      }

      this.snapshot = nextSnapshot
      return delta
    }

    return extracted.content
  }

  eventsToChunks(events) {
    const chunks = []
    const batchHasToolCall = events.some(event => event.type === 'tool_call')

    for (const event of events) {
      if (event.type === 'content') {
        // Once any tool call exists (this batch or earlier), never leak prose.
        if (batchHasToolCall || this.emittedToolCalls) continue
        if (event.content) {
          chunks.push(toOpenAIChunk(this.completionId, this.model, { content: event.content }))
        }
        continue
      }

      if (event.type === 'tool_call') {
        this.emittedToolCalls = true
        chunks.push(...toolCallDeltaChunks(this.completionId, this.model, event.toolCall, this.toolCallCount++))
      }
    }

    return chunks
  }
}
