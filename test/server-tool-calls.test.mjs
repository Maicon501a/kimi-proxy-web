import test from 'node:test'
import assert from 'node:assert/strict'

import { createProxyServer } from '../src/server.mjs'

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
]

function createMockPool() {
  return {
    count: 1,
    acquire() {
      return { id: 'acct-1', token: 'token', deviceId: 'device', timezone: 'UTC' }
    },
    reportError() {},
    reportSuccess() {},
    status() { return [{ id: 'acct-1', active: true }] },
    reload() { return 1 },
    reactivate() { return true },
  }
}

function connectEnvelope(jsonObj, isEnd = false) {
  const payload = Buffer.from(JSON.stringify(jsonObj), 'utf-8')
  const frame = Buffer.alloc(5 + payload.length)
  frame[0] = isEnd ? 0x02 : 0x00
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return frame
}

function connectEndFrame() {
  const frame = Buffer.alloc(5)
  frame[0] = 0x02
  frame.writeUInt32BE(0, 1)
  return frame
}

function createConnectResponse(frames) {
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame)
      controller.close()
    },
  })

  return new Response(stream, { status: 200 })
}

async function withServer(sendChatFn, run) {
  const { server } = createProxyServer({
    port: 0,
    pool: createMockPool(),
    sendChatFn,
    deleteChatFn: async () => {},
  })

  await new Promise(resolve => server.listen(0, resolve))
  const { port } = server.address()

  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
}

test('POST /v1/chat/completions non-stream emits tool_calls in JSON response', async () => {
  await withServer(async () => createConnectResponse([
    connectEnvelope({ op: 'set', block: { text: { content: '<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</tool_call>' } } }),
    connectEndFrame(),
  ]), async baseUrl => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-latest',
        stream: false,
        tools: TOOLS,
        messages: [{ role: 'user', content: 'read package.json' }],
      }),
    })

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.choices[0].finish_reason, 'tool_calls')
    assert.equal(body.choices[0].message.content, null)
    assert.equal(body.choices[0].message.tool_calls.length, 1)
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'read_file')
    assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { path: 'package.json' })
  })
})

test('POST /v1/chat/completions stream emits SSE tool_call deltas and finish_reason', async () => {
  await withServer(async () => createConnectResponse([
    connectEnvelope({ op: 'set', block: { text: { content: 'Antes <tool_' } } }),
    connectEnvelope({ op: 'append', block: { text: { content: 'call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' } } }),
    connectEndFrame(),
  ]), async baseUrl => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-latest',
        stream: true,
        tools: TOOLS,
        messages: [{ role: 'user', content: 'read a.txt' }],
      }),
    })

    assert.equal(response.status, 200)
    const text = await response.text()
    const lines = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    const chunks = lines.map(line => JSON.parse(line.slice(6)))

    assert.equal(chunks[0].choices[0].delta.role, 'assistant')
    // Leading prose before tool_call must not leak into SSE content.
    const contentChunks = chunks.filter(chunk => chunk.choices[0].delta.content)
    assert.equal(contentChunks.length, 0)
    const toolNameChunk = chunks.find(chunk => chunk.choices[0].delta.tool_calls?.[0]?.function?.name)
    const toolArgsChunk = chunks.find(chunk => chunk.choices[0].delta.tool_calls?.[0]?.function?.arguments)
    assert.equal(toolNameChunk.choices[0].delta.tool_calls[0].function.name, 'read_file')
    assert.equal(toolArgsChunk.choices[0].delta.tool_calls[0].function.arguments, '{"path":"a.txt"}')
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
  })
})
