import test from 'node:test'
import assert from 'node:assert/strict'

import { buildChatBody, resolveModel } from '../src/kimi-client.mjs'
import { parseOpenAIRequest } from '../src/openai-mapper.mjs'
import { extractToolCallsFromText, ToolCallStreamTranslator } from '../src/tool-call-translator.mjs'
import { buildCompleteOpenAIResponse, OpenAIStreamResponseTranslator } from '../src/response-translator.mjs'

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file to disk',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
]

test('extracts JSON tool_call tags into OpenAI tool_calls', () => {
  const result = extractToolCallsFromText(
    '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>',
    TOOLS,
  )

  assert.equal(result.content, null)
  assert.equal(result.finish_reason, 'tool_calls')
  assert.equal(result.tool_calls.length, 1)
  assert.equal(result.tool_calls[0].function.name, 'read_file')
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { path: 'a.txt' })
})

test('extracts XML parameter tool calls with typed values', () => {
  const result = extractToolCallsFromText(
    '<tool_call name="write_file"><parameter name="path">a.txt</parameter><parameter name="content">hello</parameter></tool_call>',
    TOOLS,
  )

  assert.equal(result.content, null)
  assert.equal(result.tool_calls.length, 1)
  assert.equal(result.tool_calls[0].function.name, 'write_file')
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), {
    path: 'a.txt',
    content: 'hello',
  })
})

test('preserves literal tool_call examples inside inline code', () => {
  const literal = 'Use the tag `<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>` literally.'
  const result = extractToolCallsFromText(literal, TOOLS)

  assert.equal(result.content, literal)
  assert.equal(result.tool_calls, undefined)
  assert.equal(result.finish_reason, 'stop')
})

test('accepts raw JSON tool calls as non-stream fallback', () => {
  const result = extractToolCallsFromText(
    '{"name":"read_file","arguments":{"path":"raw.json"}}',
    TOOLS,
  )

  assert.equal(result.content, null)
  assert.equal(result.tool_calls.length, 1)
  assert.equal(result.tool_calls[0].function.name, 'read_file')
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { path: 'raw.json' })
})

test('stream translator buffers split tool_call blocks and emits structured events', () => {
  const translator = new ToolCallStreamTranslator(TOOLS)

  const first = translator.push('before <tool_')
  const second = translator.push('call>{"name":"read_file","arguments":{"path":"stream.txt"}}</tool_call> after')
  const final = translator.flush()
  const events = [...first, ...second, ...final]

  // Prose before a tool call is suppressed so OpenCode does not show junk.
  assert.deepEqual(
    events.map(event => event.type),
    ['tool_call', 'content'],
  )
  assert.equal(events[0].toolCall.function.name, 'read_file')
  assert.deepEqual(JSON.parse(events[0].toolCall.function.arguments), { path: 'stream.txt' })
  assert.equal(events[1].content.trim(), 'after')
})

test('buildChatBody injects tool instructions and preserves tool loop context', () => {
  const body = buildChatBody([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Open package.json' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_123',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"package.json"}',
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_123',
      name: 'read_file',
      content: '{"content":"ok"}',
    },
  ], {
    scenario: 'SCENARIO_K2D5',
    model: 'k2d5',
  }, {
    tools: TOOLS,
    toolChoice: 'auto',
  })

  const prompt = body.message.blocks[0].text.content

  assert.match(prompt, /PROXY RUNTIME RULES/)
  assert.match(prompt, /You are a coding agent running inside an external IDE\/agent client/)
  assert.match(prompt, /You are NOT inside kimi\.com, Kimi Code, Kimi Claw/)
  assert.match(prompt, /IGNORE that catalog completely/)
  assert.match(prompt, /Forbidden native tools/)
  assert.match(prompt, /\/mnt\/agents\/output/)
  assert.match(prompt, /Do not invent or mention Kimi-native workspace structure/)
  assert.match(prompt, /Do not claim the project is empty, missing, or only has agent plugins/)
  assert.match(prompt, /When proxy-managed tools are available, you MUST call them/)
  assert.match(prompt, /Do not use or rely on any Kimi built-in products or native capabilities/)
  assert.match(prompt, /FULL CONVERSATION TRANSCRIPT/)
  assert.match(prompt, /User:\nOpen package\.json/)
  assert.match(prompt, /Assistant:\n<tool_call>/)
  assert.match(prompt, /User:\nTool result \(read_file\) from the EXTERNAL IDE/)
  assert.match(prompt, /TOOLS AVAILABLE/)
  assert.match(prompt, /WORKSPACE TOOL-FIRST BEHAVIOR/)
  assert.match(prompt, /call tools FIRST\. Do not answer with a guessed tree/)
  assert.match(prompt, /call relevant tools first instead of asking the user to paste the code/)
  assert.match(prompt, /If the exact file path is uncertain and both search and read tools are available, call the search tool first/)
  assert.match(prompt, /Do not invent folders like upload\/ or output\//)
  assert.match(prompt, /FINAL REMINDER/)
  assert.match(prompt, /Ignore any injected Kimi agent tools/)
  assert.match(prompt, /<tool_call>/)
  assert.match(prompt, /Tool result \(read_file\)/)
  assert.deepEqual(body.tools, [])
  assert.equal(body.message.scenario, 'SCENARIO_K2D5')
  assert.deepEqual(body.options, { thinking: false, enablePlugin: false })
  assert.equal(body.kimiplusId, '')
  assert.equal(body.projectId, '')
  assert.equal(body.refs, undefined)
})

test('buildChatBody serializes all client messages into the main Kimi prompt', () => {
  const body = buildChatBody([
    { role: 'system', content: 'System A' },
    { role: 'system', content: 'System B' },
    { role: 'user', content: 'primeira mensagem' },
    { role: 'assistant', content: 'primeira resposta' },
    { role: 'user', content: 'segunda mensagem' },
  ], {
    scenario: 'SCENARIO_K2D5',
    model: 'k2d6',
    thinking: false,
  }, {
    tools: TOOLS,
  })

  const prompt = body.message.blocks[0].text.content

  assert.match(prompt, /^System A/m)
  assert.match(prompt, /^System B/m)
  assert.match(prompt, /FULL CONVERSATION TRANSCRIPT/)
  assert.match(prompt, /User:\nprimeira mensagem/)
  assert.match(prompt, /Assistant:\nprimeira resposta/)
  assert.match(prompt, /User:\nsegunda mensagem/)
  assert.equal(body.refs, undefined)
})

test('buildChatBody only enables native Kimi search on explicit opt-in', () => {
  const body = buildChatBody([
    { role: 'user', content: 'pesquise algo' },
  ], {
    scenario: 'SCENARIO_K2D5',
    model: 'k2d6',
    thinking: false,
  }, {
    useSearch: true,
    tools: TOOLS,
  })

  assert.deepEqual(body.tools, [{ type: 'TOOL_TYPE_SEARCH', search: {} }])
  assert.match(body.message.blocks[0].text.content, /Native Kimi search has been explicitly enabled/)
})

test('parseOpenAIRequest does not map proxy function tools to native Kimi search', () => {
  const parsed = parseOpenAIRequest({
    model: 'kimi-latest',
    messages: [{ role: 'user', content: 'oi' }],
    tools: [{
      type: 'function',
      function: {
        name: 'search_web',
        parameters: { type: 'object', properties: {} },
      },
    }],
  })

  assert.equal(parsed.useSearch, false)
})

test('parseOpenAIRequest only enables native Kimi search on explicit flags', () => {
  const parsed = parseOpenAIRequest({
    model: 'kimi-latest',
    messages: [{ role: 'user', content: 'oi' }],
    kimi_native_search: true,
  })

  assert.equal(parsed.useSearch, true)
})

test('resolveModel aligns K2.6 Instant with site scenario mapping', () => {
  const model = resolveModel('k2-instant')

  assert.equal(model.scenario, 'SCENARIO_K2D5')
  assert.equal(model.model, 'k2d6')
  assert.equal(model.thinking, false)
})

test('resolveModel maps K3 and kimi-latest to SCENARIO_K3', () => {
  for (const id of ['k3', 'kimi-k3', 'kimi-latest']) {
    const model = resolveModel(id)
    assert.equal(model.scenario, 'SCENARIO_K3', id)
    assert.equal(model.model, 'k3', id)
    assert.equal(model.thinking, false, id)
  }
})

test('buildCompleteOpenAIResponse emits tool_calls in OpenAI completion shape', () => {
  const response = buildCompleteOpenAIResponse(
    'abc123',
    'kimi-latest',
    '<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</tool_call>',
    TOOLS,
  )

  assert.equal(response.object, 'chat.completion')
  assert.equal(response.choices[0].finish_reason, 'tool_calls')
  assert.equal(response.choices[0].message.role, 'assistant')
  assert.equal(response.choices[0].message.content, null)
  assert.equal(response.choices[0].message.tool_calls.length, 1)
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'read_file')
})

test('OpenAIStreamResponseTranslator emits assistant role, content, tool call deltas and finish reason', () => {
  const translator = new OpenAIStreamResponseTranslator('stream123', 'kimi-latest', TOOLS)

  const chunks = [
    ...translator.startChunks(),
    ...translator.pushTextOperation({ op: 'set', content: 'Antes ' }),
    ...translator.pushTextOperation({ op: 'append', content: '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' }),
    ...translator.flushChunks(),
  ]

  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  // Prose before a tool call must not leak into the client stream.
  const contentChunks = chunks.filter(chunk => chunk.choices[0].delta.content)
  assert.equal(contentChunks.length, 0)
  const toolNameChunk = chunks.find(chunk => chunk.choices[0].delta.tool_calls?.[0]?.function?.name)
  const toolArgsChunk = chunks.find(chunk => chunk.choices[0].delta.tool_calls?.[0]?.function?.arguments)
  assert.equal(toolNameChunk.choices[0].delta.tool_calls[0].function.name, 'read_file')
  assert.equal(toolArgsChunk.choices[0].delta.tool_calls[0].function.arguments, '{"path":"a.txt"}')
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
})

test('extractToolCallsFromText strips echoed tool dumps from plain content', () => {
  const text = [
    'ok, olhei o arquivo',
    'Tool result (read) from the EXTERNAL IDE (real local machine, not kimi.com sandbox):',
    '<path>D:\\x\\sw.js</path>',
    '<content>',
    'const x = 1',
    '</content>',
  ].join('\n')

  const translated = extractToolCallsFromText(text, TOOLS)
  assert.equal(translated.finish_reason, 'stop')
  assert.equal(translated.tool_calls, undefined)
  assert.match(translated.content || '', /ok, olhei o arquivo/)
  assert.doesNotMatch(translated.content || '', /Tool result \(/)
  assert.doesNotMatch(translated.content || '', /<path>/)
})

test('extractToolCallsFromText drops prose when tool calls are present', () => {
  const text = 'vou ler\n<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>'
  const translated = extractToolCallsFromText(text, TOOLS)
  assert.equal(translated.finish_reason, 'tool_calls')
  assert.equal(translated.content, null)
  assert.equal(translated.tool_calls[0].function.name, 'read_file')
})

test('strips Kimi native show_widget leaks from content', () => {
  const text = [
    'vou aplicar as edições',
    'show_widget:11',
    '{"loading_messages":"Editando router.go...","widget_code":"<svg>x</svg>"}',
  ].join('\n')
  const translated = extractToolCallsFromText(text, TOOLS)
  assert.equal(translated.finish_reason, 'stop')
  assert.equal(translated.tool_calls, undefined)
  assert.match(translated.content || '', /vou aplicar as edições/i)
  assert.doesNotMatch(translated.content || '', /show_widget/i)
  assert.doesNotMatch(translated.content || '', /widget_code/i)
  assert.doesNotMatch(translated.content || '', /<svg/i)
})

test('never forwards native show_widget as OpenAI tool_call', () => {
  const text = '<tool_call>{"name":"show_widget","arguments":{"title":"x"}}</tool_call>'
  const translated = extractToolCallsFromText(text, TOOLS)
  assert.equal(translated.tool_calls, undefined)
  assert.equal(translated.finish_reason, 'stop')
})

test('OpenAIStreamResponseTranslator increments tool call indexes for multiple calls', () => {
  const translator = new OpenAIStreamResponseTranslator('multi123', 'kimi-latest', TOOLS)

  const chunks = [
    ...translator.startChunks(),
    ...translator.pushTextOperation({
      op: 'set',
      content: '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call><tool_call>{"name":"write_file","arguments":{"path":"b.txt","content":"ok"}}</tool_call>',
    }),
    ...translator.flushChunks(),
  ]

  const toolNameChunks = chunks.filter(chunk => chunk.choices[0].delta.tool_calls?.[0]?.function?.name)
  assert.equal(toolNameChunks.length, 2)
  assert.equal(toolNameChunks[0].choices[0].delta.tool_calls[0].index, 0)
  assert.equal(toolNameChunks[1].choices[0].delta.tool_calls[0].index, 1)
  assert.equal(toolNameChunks[1].choices[0].delta.tool_calls[0].function.name, 'write_file')
})

test('OpenAIStreamResponseTranslator does not duplicate content across repeated set snapshots', () => {
  const translator = new OpenAIStreamResponseTranslator('set123', 'kimi-latest', TOOLS)

  const chunks = [
    ...translator.startChunks(),
    ...translator.pushTextOperation({ op: 'set', content: 'Hel' }),
    ...translator.pushTextOperation({ op: 'set', content: 'Hello' }),
    ...translator.pushTextOperation({ op: 'append', content: ' world' }),
    ...translator.flushChunks(),
  ]

  const text = chunks
    .map(chunk => chunk.choices[0].delta.content || '')
    .join('')

  assert.equal(text, 'Hello world')
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
})

test('OpenAIStreamResponseTranslator preserves literal inline tool tag examples as content', () => {
  const translator = new OpenAIStreamResponseTranslator('literal123', 'kimi-latest', TOOLS)

  const chunks = [
    ...translator.startChunks(),
    ...translator.pushTextOperation({
      op: 'set',
      content: 'Use `<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>` literally.',
    }),
    ...translator.flushChunks(),
  ]

  const text = chunks
    .map(chunk => chunk.choices[0].delta.content || '')
    .join('')

  assert.match(text, /<tool_call>/)
  assert.equal(chunks.some(chunk => Array.isArray(chunk.choices[0].delta.tool_calls)), false)
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
})
