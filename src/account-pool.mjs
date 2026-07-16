import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACCOUNTS_FILE = resolve(import.meta.dirname, '..', 'accounts.json')

export class AccountPool {
  constructor() {
    this.accounts = []
    this.index = 0
    this.failures = new Map()
    this.load()
  }

  load() {
    try {
      const raw = readFileSync(ACCOUNTS_FILE, 'utf-8')
      this.accounts = JSON.parse(raw).map((a, i) => {
        const token = a.token.startsWith('Bearer ') ? a.token : `Bearer ${a.token}`
        const jwtPayload = this._decodeJwt(token.replace('Bearer ', ''))
        const sessionId = a.sessionId || jwtPayload?.ssid || ''
        const trafficId = a.trafficId || jwtPayload?.sub || ''
        return {
          id: a.id || `account-${i}`,
          email: a.email || a.id || '',
          token,
          deviceId: a.deviceId || String(Date.now() + i),
          sessionId,
          shieldData: a.shieldData || '',
          trafficId,
          timezone: a.timezone || 'America/Sao_Paulo',
          jwtSub: a.jwtSub || jwtPayload?.sub || null,
          jwtExpiresAt: a.jwtExpiresAt || (jwtPayload?.exp ? new Date(jwtPayload.exp * 1000).toISOString() : null),
          createdAt: a.createdAt || null,
          active: true,
          requestCount: 0,
          errorCount: 0,
        }
      })
    } catch (e) {
      console.error(`[AccountPool] Failed to load accounts: ${e.message}`)
      this.accounts = []
    }
  }

  _decodeJwt(token) {
    try {
      const parts = token.split('.')
      if (parts.length !== 3) return null
      const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
      return JSON.parse(payload)
    } catch {
      return null
    }
  }

  _isJwtExpired(account) {
    if (!account?.jwtExpiresAt) return false
    const expMs = Date.parse(account.jwtExpiresAt)
    if (Number.isNaN(expMs)) return false
    // small skew so nearly-expired tokens are skipped
    return expMs <= Date.now() + 30_000
  }

  get count() {
    return this.accounts.filter(a => a.active && !this._isJwtExpired(a)).length
  }

  acquire() {
    // Prefer non-expired tokens. Expired accounts stay loadable for admin/debug
    // but must not be selected for live chat traffic.
    const active = this.accounts.filter(a => a.active && a.token && a.deviceId && !this._isJwtExpired(a))
    if (active.length === 0) return null
    const account = active[this.index % active.length]
    this.index = (this.index + 1) % active.length
    account.requestCount++
    return account
  }

  reportError(account, status) {
    account.errorCount++
    const key = account.id
    const count = (this.failures.get(key) || 0) + 1
    this.failures.set(key, count)
    // Connect-RPC often returns HTTP 200 with {error:{code:"unauthenticated"}}
    // Treat explicit unauth codes the same as HTTP 401.
    const unauth = status === 401 || status === 'unauthenticated' || status === 'UNAUTHENTICATED'
    if (count >= 3 || unauth) {
      account.active = false
      console.warn(`[AccountPool] Deactivated ${account.id} (${count} failures, last status: ${status})`)
    }
  }

  reportSuccess(account) {
    this.failures.delete(account.id)
  }

  status() {
    return this.accounts.map(a => ({
      id: a.id,
      active: a.active,
      requests: a.requestCount,
      errors: a.errorCount,
    }))
  }

  reactivate(id) {
    const acc = this.accounts.find(a => a.id === id)
    if (acc) {
      acc.active = true
      this.failures.delete(id)
      return true
    }
    return false
  }

  reload() {
    this.index = 0
    this.failures.clear()
    this.load()
    return this.accounts.length
  }
}
