import { randomUUID } from 'node:crypto'

export function toOpenAIChunk(id, model, delta = {}, finish = null) {
  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finish,
    }],
  }
}

export function toOpenAIComplete(id, model, content) {
  const message = typeof content === 'string'
    ? { role: 'assistant', content }
    : { role: 'assistant', content: null, ...content }

  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  }
}

export function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

export const SSE_DONE = 'data: [DONE]\n\n'

export function newCompletionId() {
  return randomUUID().replace(/-/g, '').slice(0, 24)
}

export function parseOpenAIRequest(body) {
  const {
    model = 'kimi-latest',
    messages = [],
    stream = false,
    temperature,
    max_tokens,
    tools,
    tool_choice,
    kimi_native_search,
    enable_kimi_native_search,
    use_native_search,
  } = body

  const useSearch =
    kimi_native_search === true ||
    enable_kimi_native_search === true ||
    use_native_search === true

  return { model, messages, stream, temperature, max_tokens, tools, tool_choice, useSearch }
}
