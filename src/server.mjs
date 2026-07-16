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
const DEBUG_REQUESTS = process.env.DEBUG_REQUESTS === '1' || process.env.DEBUG_REQUESTS === 'true'
const DEBUG_DIR = resolve(import.meta.dirname, '..', 'debug-requests')

function maybeLogIncomingRequest(body, req) {
  if (!DEBUG_REQUESTS) return null
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
      systemPreview: Array.isArray(body?.messages)
        ? body.messages
            .filter(m => m?.role === 'system')
            .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 500))
        : [],
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
    console.log(`[debug] saved request ${file} tools=${summary.toolsCount} stream=${summary.stream} model=${summary.model}`)
    return file
  } catch (e) {
    console.error('[debug] failed to log request', e.message)
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
    if (!checkAuthForServer(req)) return error(res, 401, 'Invalid API key')

    let body
    try {
      const rawBody = await readBody(req)
      body = JSON.parse(rawBody)
    } catch {
      return error(res, 400, 'Invalid JSON body')
    }

    maybeLogIncomingRequest(body, req)

    const { model, messages, stream, tools, tool_choice, useSearch } = parseOpenAIRequest(body)

    if (!messages || messages.length === 0) {
      return error(res, 400, 'messages array is required')
    }

    const account = pool.acquire()
    if (!account) return error(res, 503, 'No active accounts')

    const prevChatId = lastChatIds.get(account.id)
    if (prevChatId) {
      await deleteChatFn(account, prevChatId).catch(() => {})
      lastChatIds.delete(account.id)
    }

    const modelCfg = resolveModelFn(model)
    const chatBody = buildChatBodyFn(messages, modelCfg, { useSearch, tools, toolChoice: tool_choice })
    const completionId = newCompletionId()

    let kimiRes
    try {
      kimiRes = await sendChatFn(account, chatBody)
    } catch (e) {
      pool.reportError(account, 0)
      return error(res, 502, `Kimi request failed: ${e.message}`)
    }

    if (!kimiRes.ok) {
      pool.reportError(account, kimiRes.status)
      const txt = await kimiRes.text().catch(() => '')
      return error(res, kimiRes.status, `Kimi returned ${kimiRes.status}: ${txt.slice(0, 200)}`)
    }

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
        return error(res, 502, `Stream parse error: ${e.message}`)
      }

      if (streamError) {
        pool.reportError(account, streamError.code)
        const code = /unauth/i.test(String(streamError.code)) ? 401 : 502
        return error(res, code, `Kimi stream error: ${streamError.code}: ${streamError.message}`)
      }

      pool.reportSuccess(account)
      if (newChatId) lastChatIds.set(account.id, newChatId)
      return json(res, 200, buildCompleteOpenAIResponse(completionId, model, fullText, tools))
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
      console.error('[Stream Error]', e.message)
      streamError = { code: 'stream_error', message: e.message }
    }

    if (streamError) {
      pool.reportError(account, streamError.code)
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

    try {
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        return await handleChatCompletions(req, res)
      }
      if (path === '/v1/models' && req.method === 'GET') {
        return handleModels(req, res)
      }
      if (path === '/status' && req.method === 'GET') {
        return handleStatus(req, res)
      }
      if (path === '/admin/reload' && req.method === 'POST') {
        return await handleAdminReload(req, res)
      }
      if (path === '/admin/reactivate' && req.method === 'POST') {
        return await handleAdminReactivate(req, res)
      }
      if (path === '/' || path === '/health') {
        return json(res, 200, { service: 'proxy-kimi', status: 'running', accounts: pool.count })
      }
      error(res, 404, 'Not found')
    } catch (e) {
      console.error('[Server]', e)
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
  })
}
