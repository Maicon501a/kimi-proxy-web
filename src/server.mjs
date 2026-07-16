import { createServer } from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccountPool } from './account-pool.mjs'
import { sendChat, buildChatBody, resolveModel, listModels, deleteChat } from './kimi-client.mjs'
import { parseConnectStream, extractContent, extractStreamError, isStreamEnd, extractChatId } from './stream-parser.mjs'
import { sseLine, SSE_DONE, newCompletionId, parseOpenAIRequest } from './openai-mapper.mjs'
import { buildCompleteOpenAIResponse, OpenAIStreamResponseTranslator } from './response-translator.mjs'

const PORT = process.env.PORT || 8080
const API_KEY = process.env.API_KEY || ''
// Request logging mode: default ON. Set REQUEST_LOG=false|0|off to disable.
// Alias: DEBUG_REQUESTS=false also disables. DEBUG_REQUESTS=1 keeps dumps on disk.
const REQUEST_LOG = (() => {
  const raw = process.env.REQUEST_LOG ?? process.env.DEBUG_REQUESTS
  if (raw === undefined || raw === '') return true
  const v = String(raw).trim().toLowerCase()
  if (['0', 'false', 'off', 'no'].includes(v)) return false
  if (['1', 'true', 'on', 'yes'].includes(v)) return true
  return true
})()
const DEBUG_DUMP = process.env.DEBUG_DUMP === '1' || process.env.DEBUG_DUMP === 'true'
  || process.env.DEBUG_REQUESTS === '1' || process.env.DEBUG_REQUESTS === 'true'
const DEBUG_DIR = resolve(import.meta.dirname, '..', 'debug-requests')

function ts() {
  return new Date().toISOString()
}

function previewText(value, max = 160) {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max)}…`
}

function logInfo(...args) {
  if (!REQUEST_LOG) return
  console.log(`[${ts()}]`, ...args)
}

function logWarn(...args) {
  if (!REQUEST_LOG) return
  console.warn(`[${ts()}]`, ...args)
}

function logError(...args) {
  // errors always print
  console.error(`[${ts()}]`, ...args)
}

function maybeDumpIncomingRequest(body, req) {
  if (!DEBUG_DUMP) return null
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = resolve(DEBUG_DIR, `req-${stamp}.json`)
    const summary = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      ua: req.headers['user-agent'] || null,
      model: body?.model,
      stream: body?.stream === true,
      tool_choice: body?.tool_choice ?? null,
      toolsCount: Array.isArray(body?.tools) ? body.tools.length : 0,
      toolNames: Array.isArray(body?.tools)
        ? body.tools.map(t => t?.function?.name || t?.name || t?.type).filter(Boolean)
        : [],
      messagesCount: Array.isArray(body?.messages) ? body.messages.length : 0,
      messageRoles: Array.isArray(body?.messages) ? body.messages.map(m => m?.role) : [],
      lastUserPreview: (() => {
        const users = (body?.messages || []).filter(m => m?.role === 'user')
        const last = users[users.length - 1]
        if (!last) return null
        const c = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
        return c.slice(0, 800)
      })(),
      body,
    }
    writeFileSync(file, JSON.stringify(summary, null, 2), 'utf-8')
    logInfo(`[dump] saved ${file}`)
    return file
  } catch (e) {
    logError('[dump] failed', e.message)
    return null
  }
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function error(res, code, message) {
  json(res, code, { error: { message, type: 'proxy_error', code } })
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf-8')
}

function checkAuth(req) {
  if (!API_KEY) return true
  const auth = req.headers['authorization'] || ''
  return auth === `Bearer ${API_KEY}`
}

export function createProxyServer(options = {}) {
  const {
    port = PORT,
    apiKey = API_KEY,
    pool = new AccountPool(),
    sendChatFn = sendChat,
    buildChatBodyFn = buildChatBody,
    resolveModelFn = resolveModel,
    listModelsFn = listModels,
    deleteChatFn = deleteChat,
  } = options

  const lastChatIds = new Map()

  function checkAuthForServer(req) {
    if (!apiKey) return true
    const auth = req.headers['authorization'] || ''
    return auth === `Bearer ${apiKey}`
  }

  async function handleChatCompletions(req, res) {
    const started = Date.now()
    if (!checkAuthForServer(req)) {
      logWarn('[req] chat/completions 401 invalid api key')
      return error(res, 401, 'Invalid API key')
    }

    let body
    try {
      const rawBody = await readBody(req)
      body = JSON.parse(rawBody)
    } catch {
      logWarn('[req] chat/completions 400 invalid json')
      return error(res, 400, 'Invalid JSON body')
    }

    maybeDumpIncomingRequest(body, req)

    const { model, messages, stream, tools, tool_choice, useSearch } = parseOpenAIRequest(body)
    const toolNames = Array.isArray(tools)
      ? tools.map(t => t?.function?.name || t?.name || t?.type).filter(Boolean)
      : []
    const lastUser = [...(messages || [])].reverse().find(m => m?.role === 'user')
    const lastUserPreview = lastUser
      ? previewText(typeof lastUser.content === 'string' ? lastUser.content : lastUser.content, 180)
      : ''

    logInfo(
      `[req] POST /v1/chat/completions model=${model} stream=${!!stream}` +
      ` msgs=${messages?.length || 0} tools=${toolNames.length}` +
      ` tool_choice=${JSON.stringify(tool_choice ?? 'auto')}` +
      ` search=${!!useSearch}` +
      (toolNames.length ? ` toolNames=[${toolNames.slice(0, 12).join(',')}${toolNames.length > 12 ? ',…' : ''}]` : '') +
      (lastUserPreview ? ` user="${lastUserPreview}"` : ''),
    )

    if (!messages || messages.length === 0) {
      logWarn('[req] chat/completions 400 messages required')
      return error(res, 400, 'messages array is required')
    }

    const account = pool.acquire()
    if (!account) {
      logWarn('[req] chat/completions 503 no active accounts')
      return error(res, 503, 'No active accounts')
    }
    logInfo(`[req] account=${account.id}`)

    const prevChatId = lastChatIds.get(account.id)
    if (prevChatId) {
      await deleteChatFn(account, prevChatId).catch(() => {})
      lastChatIds.delete(account.id)
    }

    const modelCfg = resolveModelFn(model)
    const chatBody = buildChatBodyFn(messages, modelCfg, { useSearch, tools, toolChoice: tool_choice })
    const completionId = newCompletionId()
    logInfo(
      `[kimi] send scenario=${modelCfg.scenario} model=${modelCfg.model || model}` +
      ` enablePlugin=${chatBody?.options?.enablePlugin === true}` +
      ` tools=${Array.isArray(chatBody?.tools) ? chatBody.tools.length : 0}`,
    )

    let kimiRes
    try {
      kimiRes = await sendChatFn(account, chatBody)
    } catch (e) {
      pool.reportError(account, 0)
      logError(`[kimi] request failed account=${account.id}: ${e.message}`)
      return error(res, 502, `Kimi request failed: ${e.message}`)
    }

    if (!kimiRes.ok) {
      pool.reportError(account, kimiRes.status)
      const txt = await kimiRes.text().catch(() => '')
      logError(`[kimi] http ${kimiRes.status} account=${account.id}: ${previewText(txt, 200)}`)
      return error(res, kimiRes.status, `Kimi returned ${kimiRes.status}: ${txt.slice(0, 200)}`)
    }
    logInfo(`[kimi] http ${kimiRes.status} stream-open account=${account.id}`)

    let newChatId = null
    let streamError = null

    if (!stream) {
      let fullText = ''
      try {
        for await (const frame of parseConnectStream(kimiRes)) {
          const frameError = extractStreamError(frame)
          if (frameError) {
            streamError = frameError
            break
          }
          if (isStreamEnd(frame)) break
          const chatId = extractChatId(frame)
          if (chatId && !newChatId) newChatId = chatId
          const extracted = extractContent(frame)
          if (extracted) {
            if (extracted.op === 'set') fullText = extracted.content
            else if (extracted.op === 'append') fullText += extracted.content
          }
        }
      } catch (e) {
        pool.reportError(account, 0)
        logError(`[kimi] parse error: ${e.message}`)
        return error(res, 502, `Stream parse error: ${e.message}`)
      }

      if (streamError) {
        pool.reportError(account, streamError.code)
        const code = /unauth/i.test(String(streamError.code)) ? 401 : 502
        logError(`[kimi] stream error ${streamError.code}: ${streamError.message}`)
        return error(res, code, `Kimi stream error: ${streamError.code}: ${streamError.message}`)
      }

      pool.reportSuccess(account)
      if (newChatId) lastChatIds.set(account.id, newChatId)
      const response = buildCompleteOpenAIResponse(completionId, model, fullText, tools)
      const finish = response?.choices?.[0]?.finish_reason
      const toolCalls = response?.choices?.[0]?.message?.tool_calls?.length || 0
      logInfo(
        `[res] non-stream finish=${finish} tool_calls=${toolCalls}` +
        ` chars=${fullText.length} chatId=${newChatId || '-'} ms=${Date.now() - started}`,
      )
      return json(res, 200, response)
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const responseTranslator = new OpenAIStreamResponseTranslator(completionId, model, tools)
    for (const chunk of responseTranslator.startChunks()) {
      res.write(sseLine(chunk))
    }

    try {
      for await (const frame of parseConnectStream(kimiRes)) {
        const frameError = extractStreamError(frame)
        if (frameError) {
          streamError = frameError
          break
        }
        if (isStreamEnd(frame)) break
        const chatId = extractChatId(frame)
        if (chatId && !newChatId) newChatId = chatId
        const extracted = extractContent(frame)
        if (extracted) {
          for (const chunk of responseTranslator.pushTextOperation(extracted)) {
            res.write(sseLine(chunk))
          }
        }
      }
    } catch (e) {
      logError(`[stream] error: ${e.message}`)
      streamError = { code: 'stream_error', message: e.message }
    }

    if (streamError) {
      pool.reportError(account, streamError.code)
      logError(`[res] stream error ${streamError.code}: ${streamError.message} ms=${Date.now() - started}`)
      res.write(sseLine({
        error: {
          message: `Kimi stream error: ${streamError.code}: ${streamError.message}`,
          type: 'proxy_error',
          code: streamError.code,
        },
      }))
      res.write(SSE_DONE)
      res.end()
      return
    }

    pool.reportSuccess(account)
    if (newChatId) lastChatIds.set(account.id, newChatId)

    for (const chunk of responseTranslator.flushChunks()) {
      res.write(sseLine(chunk))
    }
    res.write(SSE_DONE)
    res.end()
    logInfo(
      `[res] stream done tool_calls=${responseTranslator.emittedToolCalls ? 'yes' : 'no'}` +
      ` chatId=${newChatId || '-'} ms=${Date.now() - started}`,
    )
  }

  function handleModels(req, res) {
    if (!checkAuthForServer(req)) return error(res, 401, 'Invalid API key')
    json(res, 200, { object: 'list', data: listModelsFn() })
  }

  function handleStatus(req, res) {
    json(res, 200, {
      status: 'ok',
      accounts: pool.status(),
      active: pool.count,
    })
  }

  async function handleAdminReload(req, res) {
    if (!checkAuthForServer(req)) return error(res, 401, 'Invalid API key')
    const count = pool.reload()
    json(res, 200, { reloaded: count })
  }

  async function handleAdminReactivate(req, res) {
    if (!checkAuthForServer(req)) return error(res, 401, 'Invalid API key')
    const body = JSON.parse(await readBody(req))
    const ok = pool.reactivate(body.id)
    json(res, 200, { reactivated: ok })
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    const path = url.pathname
    const started = Date.now()

    // Always log lightweight access for non-chat routes when REQUEST_LOG is on.
    // chat/completions has richer logs inside the handler.
    if (path !== '/v1/chat/completions') {
      logInfo(`[http] ${req.method} ${path}`)
    }

    try {
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        return await handleChatCompletions(req, res)
      }
      if (path === '/v1/models' && req.method === 'GET') {
        handleModels(req, res)
        logInfo(`[http] ${req.method} ${path} -> 200 ms=${Date.now() - started}`)
        return
      }
      if (path === '/status' && req.method === 'GET') {
        handleStatus(req, res)
        logInfo(`[http] ${req.method} ${path} -> 200 ms=${Date.now() - started}`)
        return
      }
      if (path === '/admin/reload' && req.method === 'POST') {
        await handleAdminReload(req, res)
        logInfo(`[http] ${req.method} ${path} -> 200 ms=${Date.now() - started}`)
        return
      }
      if (path === '/admin/reactivate' && req.method === 'POST') {
        await handleAdminReactivate(req, res)
        logInfo(`[http] ${req.method} ${path} -> 200 ms=${Date.now() - started}`)
        return
      }
      if (path === '/' || path === '/health') {
        json(res, 200, {
          service: 'proxy-kimi',
          status: 'running',
          accounts: pool.count,
          request_log: REQUEST_LOG,
          debug_dump: DEBUG_DUMP,
        })
        return
      }
      logWarn(`[http] ${req.method} ${path} -> 404`)
      error(res, 404, 'Not found')
    } catch (e) {
      logError('[Server]', e)
      error(res, 500, e.message)
    }
  })

  return { server, pool }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isMainModule) {
  const { server, pool } = createProxyServer()
  server.listen(PORT, () => {
    console.log(`[proxy-kimi] Listening on http://localhost:${PORT}`)
    console.log(`[proxy-kimi] ${pool.count} account(s) loaded`)
    console.log(`[proxy-kimi] API Key auth: ${API_KEY ? 'enabled' : 'disabled'}`)
    console.log(`[proxy-kimi] REQUEST_LOG: ${REQUEST_LOG ? 'ON (default)' : 'OFF'}  (set REQUEST_LOG=false to disable)`)
    console.log(`[proxy-kimi] DEBUG_DUMP: ${DEBUG_DUMP ? 'ON' : 'OFF'}  (set DEBUG_DUMP=true to save full JSON under debug-requests/)`)
  })
}
