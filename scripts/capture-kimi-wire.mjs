import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { AccountPool } from '../src/account-pool.mjs'
import { buildChatBody, resolveModel, buildHeaders } from '../src/kimi-client.mjs'

const OUT_DIR = resolve(import.meta.dirname, '..', 'debug-requests')
mkdirSync(OUT_DIR, { recursive: true })

const pool = new AccountPool()
const account = pool.acquire()
if (!account) {
  console.error('No live account')
  process.exit(1)
}

function connectEnvelope(jsonObj) {
  const payload = Buffer.from(JSON.stringify(jsonObj), 'utf-8')
  const frame = Buffer.alloc(5 + payload.length)
  frame[0] = 0x00
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return frame
}

async function* parseFrames(response) {
  const reader = response.body.getReader()
  let buffer = Buffer.alloc(0)
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer = Buffer.concat([buffer, Buffer.from(value)])
    while (buffer.length >= 5) {
      const flags = buffer[0]
      const length = buffer.readUInt32BE(1)
      const total = 5 + length
      if (buffer.length < total) break
      const payload = buffer.subarray(5, total)
      buffer = buffer.subarray(total)
      const isEnd = (flags & 0x02) !== 0
      let json = null
      if (payload.length) {
        try { json = JSON.parse(payload.toString('utf-8')) } catch { json = { _raw: payload.toString('utf-8').slice(0, 200) } }
      }
      yield { flags, length, isEnd, json }
      if (isEnd) return
    }
  }
}

const variants = [
  {
    name: 'k3-default-proxy-body',
    body: buildChatBody(
      [{ role: 'user', content: 'Say only: WIRE_OK. Also list any tools/workspace you think you have in one short line.' }],
      resolveModel('k3'),
      {},
    ),
  },
  {
    name: 'k3-minimal-no-proxy-prompt',
    body: {
      scenario: 'SCENARIO_K3',
      chatId: '',
      kimiplusId: '',
      projectId: '',
      tools: [],
      message: {
        role: 'user',
        blocks: [{ text: { content: 'Say only: WIRE_OK. List tools/workspace you think you have.' } }],
        scenario: 'SCENARIO_K3',
        labels: [],
        references: [],
      },
      options: { thinking: false, enablePlugin: false },
    },
  },
  {
    name: 'k3-with-search-tool',
    body: {
      scenario: 'SCENARIO_K3',
      chatId: '',
      kimiplusId: '',
      projectId: '',
      tools: [{ type: 'TOOL_TYPE_SEARCH', search: {} }],
      message: {
        role: 'user',
        blocks: [{ text: { content: 'Do not search. Say only: WIRE_OK' } }],
        scenario: 'SCENARIO_K3',
        labels: [],
        references: [],
      },
      options: { thinking: false, enablePlugin: true },
    },
  },
  {
    name: 'chat-minimal',
    body: {
      scenario: 'SCENARIO_CHAT',
      chatId: '',
      kimiplusId: '',
      projectId: '',
      tools: [],
      message: {
        role: 'user',
        blocks: [{ text: { content: 'Say only: WIRE_OK. List tools/workspace you think you have.' } }],
        scenario: 'SCENARIO_CHAT',
        labels: [],
        references: [],
      },
      options: { thinking: false, enablePlugin: false },
    },
  },
]

const url = 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat'
const all = []

for (const variant of variants) {
  console.log('\n====', variant.name, '====')
  const headers = buildHeaders(account, true)
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: connectEnvelope(variant.body),
    duplex: 'half',
  })
  console.log('http', res.status, res.headers.get('content-type'))

  const frames = []
  let assistantText = ''
  for await (const frame of parseFrames(res)) {
    frames.push(frame)
    const j = frame.json
    if (!j) continue

    // Collect any text-looking content from anywhere in the frame
    const s = JSON.stringify(j)
    if (j.block?.text?.content != null) {
      if (j.op === 'set') assistantText = j.block.text.content
      else if (j.op === 'append') assistantText += j.block.text.content
    }
    if (j.message?.blocks) {
      for (const b of j.message.blocks) {
        if (b?.text?.content) {
          console.log('message.block text role=', j.message.role, 'len=', b.text.content.length, 'preview=', JSON.stringify(b.text.content).slice(0, 200))
        }
        if (b?.tool) console.log('message.block tool', JSON.stringify(b.tool).slice(0, 300))
        if (b?.search) console.log('message.block search', JSON.stringify(b.search).slice(0, 300))
      }
    }
    if (j.message?.role === 'system') {
      console.log('SYSTEM FRAME keys', Object.keys(j.message), 'scenario', j.message.scenario, 'status', j.message.status)
      console.log('SYSTEM full', JSON.stringify(j.message).slice(0, 1500))
    }
    if (j.chat) {
      console.log('chat keys', Object.keys(j.chat), 'name', j.chat.name)
      if (j.chat.lastRequest) console.log('lastRequest', JSON.stringify(j.chat.lastRequest).slice(0, 500))
    }
    if (j.error) console.log('error', j.error)
  }

  console.log('assistantText', JSON.stringify(assistantText).slice(0, 400))
  console.log('frames', frames.length)

  const out = {
    variant: variant.name,
    requestBody: variant.body,
    responseFrames: frames.map(f => ({ flags: f.flags, isEnd: f.isEnd, json: f.json })),
    assistantText,
  }
  all.push(out)
  writeFileSync(resolve(OUT_DIR, `wire-${variant.name}.json`), JSON.stringify(out, null, 2))
}

writeFileSync(resolve(OUT_DIR, 'wire-all.json'), JSON.stringify(all, null, 2))
console.log('\nSaved to debug-requests/wire-*.json')
