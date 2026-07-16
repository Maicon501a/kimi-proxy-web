import { createProxyServer } from '../src/server.mjs'
import { AccountPool } from '../src/account-pool.mjs'
import { buildChatBody, resolveModel } from '../src/kimi-client.mjs'

const OPENCODE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search content',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
]

const userMsg = [
  'entende o meu projeto ai o site ve ele',
  '<environment_details>',
  'Current time: 2026-07-16T12:20:10-03:00',
  'Working directory: C:\\Users\\maicon2\\Documents\\dev\\proxy-kimi',
  'Workspace root folder: /',
  '</environment_details>',
].join('\n')

const messages = [
  {
    role: 'system',
    content: 'You are OpenCode, an interactive CLI agent. Use tools to solve tasks.',
  },
  { role: 'user', content: userMsg },
]

// Sanity: prompt includes final reminder + path
const preview = buildChatBody(messages, resolveModel('k3'), {
  tools: OPENCODE_TOOLS,
  toolChoice: 'auto',
})
const prompt = preview.message.blocks[0].text.content
console.log('has FINAL REMINDER', prompt.includes('FINAL REMINDER'))
console.log('has working dir', prompt.includes('C:\\Users\\maicon2\\Documents\\dev\\proxy-kimi'))
console.log('ends with reminder', prompt.trimEnd().slice(-180))

const pool = new AccountPool()
const { server } = createProxyServer({ port: 0, pool })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function run(label, tools) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'k3',
      stream: false,
      tools,
      tool_choice: tools?.length ? 'auto' : undefined,
      messages,
    }),
  })
  const json = await res.json()
  const choice = json.choices?.[0]
  console.log(`\n== ${label} ==`)
  console.log('status', res.status)
  console.log('finish', choice?.finish_reason)
  console.log('content', JSON.stringify(choice?.message?.content || '').slice(0, 600))
  console.log(
    'tools',
    JSON.stringify(
      (choice?.message?.tool_calls || []).map(t => ({
        n: t.function.name,
        a: t.function.arguments,
      })),
      null,
      2,
    ).slice(0, 1000),
  )
  if (json.error) console.log('error', json.error)
}

try {
  await run('WITH OPENCODE TOOLS', OPENCODE_TOOLS)
  await run('NO TOOLS', undefined)
} finally {
  await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
}
