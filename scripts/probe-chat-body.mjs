import { readFileSync } from 'node:fs'
import { resolveModel, buildChatBody, sendChat, buildHeaders } from '../src/kimi-client.mjs'
import { parseConnectStream, isStreamEnd } from '../src/stream-parser.mjs'
import { AccountPool } from '../src/account-pool.mjs'

const pool = new AccountPool()
const acc = pool.acquire()
if (!acc) {
  console.error('no account')
  process.exit(1)
}

const body = buildChatBody(
  [{ role: 'user', content: 'Reply with exactly: PING_OK' }],
  resolveModel('k3'),
  {},
)

// Explicitly probe disabling native plugins if API accepts it
const variants = [
  { label: 'current', body },
  {
    label: 'disable-plugin-false',
    body: {
      ...body,
      options: {
        ...body.options,
        thinking: false,
        enablePlugin: false,
      },
    },
  },
  {
    label: 'tools-empty',
    body: {
      ...body,
      tools: [],
      options: {
        thinking: false,
        enablePlugin: false,
      },
    },
  },
  {
    label: 'scenario-chat',
    body: {
      scenario: 'SCENARIO_CHAT',
      message: {
        role: 'user',
        blocks: body.message.blocks,
        scenario: 'SCENARIO_CHAT',
      },
      options: { thinking: false, enablePlugin: false },
    },
  },
  {
    label: 'scenario-k2',
    body: {
      scenario: 'SCENARIO_K2',
      message: {
        role: 'user',
        blocks: body.message.blocks,
        scenario: 'SCENARIO_K2',
      },
      options: { thinking: false, enablePlugin: false },
    },
  },
]

for (const v of variants) {
  console.log('\n====', v.label, '====')
  console.log('send body keys', Object.keys(v.body), 'options', JSON.stringify(v.body.options))
  try {
    const res = await sendChat(acc, v.body)
    console.log('http', res.status)
    let n = 0
    let firstErr = null
    let sample = null
    for await (const frame of parseConnectStream(res)) {
      n++
      if (frame.error && !firstErr) firstErr = frame.error
      if (!sample && (frame.message || frame.op || frame.chat)) sample = frame
      if (isStreamEnd(frame)) break
      if (n > 8) break
    }
    console.log('frames', n, 'err', firstErr ? JSON.stringify(firstErr) : null)
    if (sample) console.log('sample', JSON.stringify(sample).slice(0, 400))
  } catch (e) {
    console.log('exception', e.message)
  }
}
