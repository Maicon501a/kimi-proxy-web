export async function* parseConnectStream(response) {
  const reader = response.body.getReader()
  let buffer = Buffer.alloc(0)

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer = Buffer.concat([buffer, Buffer.from(value)])

    while (buffer.length >= 5) {
      const flags = buffer[0]
      const length = buffer.readUInt32BE(1)
      const totalFrame = 5 + length

      if (buffer.length < totalFrame) break

      const payload = buffer.subarray(5, totalFrame)
      buffer = buffer.subarray(totalFrame)
      const isEnd = (flags & 0x02) !== 0

      if (payload.length === 0 && isEnd) {
        yield { _end: true }
        return
      }

      if (payload.length === 0) continue

      let json
      try {
        json = JSON.parse(payload.toString('utf-8'))
      } catch {
        continue
      }

      yield json

      if (isEnd && json?.done !== undefined) {
        yield { _end: true }
        return
      }
    }
  }

  if (buffer.length > 5) {
    try {
      yield JSON.parse(buffer.subarray(5).toString('utf-8'))
    } catch {}
  }
}

export function extractStreamError(frame) {
  if (!frame || frame._end) return null
  if (!frame.error) return null
  const err = frame.error
  if (typeof err === 'string') return { code: err, message: err }
  if (typeof err === 'object') {
    return {
      code: err.code || err.status || 'error',
      message: err.message || err.code || JSON.stringify(err),
    }
  }
  return { code: 'error', message: String(err) }
}

export function extractContent(frame) {
  if (!frame || frame._end) return null
  if (frame.heartbeat) return null
  if (frame.done) return null
  if (frame.error) return null

  if ((frame.op === 'set' || frame.op === 'append') && frame.block?.text?.content !== undefined) {
    return { op: frame.op, content: frame.block.text.content }
  }

  return null
}

export function isTextBlockFrame(frame) {
  return (frame?.op === 'set' || frame?.op === 'append') && frame?.block?.text?.content !== undefined
}

export function extractChatId(frame) {
  if (!frame || frame._end) return null
  if (frame.chat?.id) return frame.chat.id
  return null
}

export function isStreamEnd(frame) {
  if (!frame) return false
  if (frame._end) return true
  if (frame.done !== undefined) return true
  return false
}
