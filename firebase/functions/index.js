const { setGlobalOptions } = require('firebase-functions/v2')
const { onRequest } = require('firebase-functions/v2/https')
const admin = require('firebase-admin')

admin.initializeApp()
setGlobalOptions({ region: 'us-central1', maxInstances: 20, memory: '256MiB' })

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
const geoCache = new Map()
const rateHits = new Map()
const GEO_TTL = 24 * 60 * 60 * 1000
const MAX_EVENTS = 100

function safeName(code) {
  try {
    return regionNames.of(String(code).toUpperCase()) || String(code).toUpperCase()
  } catch {
    return String(code).toUpperCase()
  }
}

function safeKey(text) {
  return Buffer.from(String(text || '')).toString('base64url').slice(0, 500)
}

function clamp(value, max) {
  const number = Number(value)
  if (!isFinite(number) || number <= 0) return 0
  return Math.min(number, max)
}

function validCell(cell) {
  return /^\d{1,2}_\d{1,2}$/.test(String(cell || ''))
}

function isPrivateIp(ip) {
  if (!ip) return true
  const address = String(ip).replace(/^::ffff:/, '')
  if (address === '::1' || address === '127.0.0.1') return true
  if (address.startsWith('10.') || address.startsWith('192.168.')) return true
  if (address.startsWith('169.254.')) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true
  if (address.includes(':')) return true
  return false
}

async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 900)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'orbit/1.0' },
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function lookupIp(ip) {
  const ipapi = await fetchJson(`https://ipapi.co/${encodeURIComponent(ip)}/json/`)
  if (ipapi && /^[A-Za-z]{2}$/.test(ipapi.country_code || '')) {
    const code = ipapi.country_code.toUpperCase()
    return { code, name: ipapi.country_name || safeName(code) }
  }

  const ipinfo = await fetchJson(`https://ipinfo.io/${encodeURIComponent(ip)}/json`)
  if (ipinfo && /^[A-Za-z]{2}$/.test(ipinfo.country || '')) {
    const code = ipinfo.country.toUpperCase()
    return { code, name: safeName(code) }
  }

  return { code: 'XX', name: 'Unknown' }
}

function headerCountry(headers) {
  const value =
    headers['cf-ipcountry'] ||
    headers['x-vercel-ip-country'] ||
    headers['x-country-code'] ||
    headers['x-geo-country'] ||
    ''
  if (/^[A-Za-z]{2}$/.test(String(value)) && String(value).toUpperCase() !== 'XX') {
    const code = String(value).toUpperCase()
    return { code, name: safeName(code) }
  }
  return null
}

async function resolveGeo(req) {
  const fromHeader = headerCountry(req.headers)
  if (fromHeader) return fromHeader

  let ip = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  if (!ip) ip = String(req.ip || '')
  ip = ip.replace(/^::ffff:/, '')

  if (isPrivateIp(ip)) return { code: 'LOCAL', name: 'Local / Unknown' }

  const cached = geoCache.get(ip)
  if (cached && Date.now() - cached.at < GEO_TTL) return cached.value

  const value = await lookupIp(ip)
  geoCache.set(ip, { at: Date.now(), value })
  if (geoCache.size > 2000) geoCache.clear()
  return value
}

function rateLimited(ip) {
  const key = ip || 'unknown'
  const now = Date.now()
  let entry = rateHits.get(key)
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + 60000 }
  }
  entry.count += 1
  rateHits.set(key, entry)
  if (rateHits.size > 5000) rateHits.clear()
  return entry.count > 120
}

class Writer {
  constructor() {
    this.docs = new Map()
  }

  entry(path) {
    if (!this.docs.has(path)) {
      this.docs.set(path, { ref: db.doc(path), data: {}, inc: {} })
    }
    return this.docs.get(path)
  }

  set(path, data) {
    Object.assign(this.entry(path).data, data)
  }

  inc(path, field, amount) {
    const entry = this.entry(path)
    entry.inc[field] = (entry.inc[field] || 0) + amount
  }

  commit(batch) {
    for (const { ref, data, inc } of this.docs.values()) {
      const final = { ...data }
      for (const [field, amount] of Object.entries(inc)) {
        final[field] = FieldValue.increment(amount)
      }
      if (Object.keys(final).length) batch.set(ref, final, { merge: true })
    }
  }
}

exports.omberIngest = onRequest(
  { cors: true, timeoutSeconds: 20 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'POST required' })
      return
    }

    const body = req.body || {}
    const siteId = String(body.siteId || '').trim()
    const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : []

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(siteId) || events.length === 0) {
      res.status(400).json({ error: 'Invalid payload' })
      return
    }

    const forwardedIp = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim()
    const ip = forwardedIp || String(req.ip || '')
    if (rateLimited(ip)) {
      res.status(429).json({ error: 'Too many requests' })
      return
    }

    try {
      const siteSnapshot = await db.collection('sites').doc(siteId).get()
      const site = siteSnapshot.exists ? siteSnapshot.data() : {}

      if (site.active === false) {
        res.status(403).json({ error: 'Site is disabled' })
        return
      }

      const origin = String(req.headers.origin || '')
      const allowed = Array.isArray(site.allowedOrigins) ? site.allowedOrigins : []
      if (
        allowed.length > 0 &&
        !allowed.includes('*') &&
        origin &&
        !allowed.includes(origin)
      ) {
        res.status(403).json({ error: 'Origin not allowed' })
        return
      }

      const geo = await resolveGeo(req)
      const day = new Date().toISOString().slice(0, 10)
      const dayPath = `sites/${siteId}/daily/${day}`
      const sitePath = `sites/${siteId}`
      const writer = new Writer()

      for (const event of events) {
        if (!event || typeof event !== 'object') continue

        const type = String(event.type || '')
        const page = String(event.page || '/').slice(0, 300)
        const pageId = safeKey(page)
        const sessionId = String(
          event.sessionId || (event.meta && event.meta.sessionId) || 'unknown',
        )
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 80) || 'unknown'
        const sessionPath = `sites/${siteId}/sessions/${sessionId}`
        const heatPath = `sites/${siteId}/heatmaps/${pageId}`

        switch (type) {
          case 'session_start': {
            const meta = event.meta || {}
            writer.set(sessionPath, {
              sessionId,
              startedAt: FieldValue.serverTimestamp(),
              lastSeen: FieldValue.serverTimestamp(),
              countryCode: geo.code,
              countryName: geo.name,
              referrer: String(meta.referrer || '').slice(0, 200),
              screen: String(meta.screen || '').slice(0, 40),
              device: String(meta.device || 'unknown').slice(0, 40),
              browser: String(meta.browser || 'unknown').slice(0, 40),
              language: String(meta.language || '').slice(0, 40),
              timezone: String(meta.timezone || '').slice(0, 80),
              pages: [page],
              endedAt: null,
            })
            writer.inc(dayPath, 'visits', 1)
            writer.inc(dayPath, `countries.${geo.code}`, 1)
            writer.inc(dayPath, `devices.${String(meta.device || 'unknown').slice(0, 40)}`, 1)
            writer.inc(sitePath, 'totalVisits', 1)
            writer.set(sitePath, { lastVisitAt: FieldValue.serverTimestamp() })
            break
          }

          case 'pageview':
            writer.inc(dayPath, 'pageviews', 1)
            writer.inc(dayPath, `pages.${pageId}`, 1)
            writer.inc(dayPath, 'views', 1)
            break

          case 'heartbeat': {
            const delta = clamp(event.deltaMs, 300000)
            if (delta > 0) {
              writer.inc(sessionPath, 'durationMs', delta)
              writer.inc(sessionPath, 'lastActiveMs', delta)
              writer.inc(dayPath, 'durationMs', delta)
              writer.set(sessionPath, { lastSeen: FieldValue.serverTimestamp() })
            }
            break
          }

          case 'click': {
            const label = String(event.label || 'element')
              .replace(/\s+/g, ' ')
              .slice(0, 120)
            writer.inc(sessionPath, 'clickCount', 1)
            writer.inc(dayPath, 'clicks', 1)
            writer.inc(`sites/${siteId}/elements/${safeKey(label)}`, 'count', 1)
            writer.set(`sites/${siteId}/elements/${safeKey(label)}`, {
              label,
              lastSeen: FieldValue.serverTimestamp(),
            })
            const cell = event.cell
            if (validCell(cell)) writer.inc(heatPath, `clicks.${cell}`, 1)
            writer.set(sessionPath, { lastSeen: FieldValue.serverTimestamp() })
            break
          }

          case 'moves': {
            const counts = event.counts && typeof event.counts === 'object' ? event.counts : {}
            let total = 0
            for (const [cell, rawCount] of Object.entries(counts)) {
              const amount = clamp(rawCount, 1000)
              if (!validCell(cell) || !amount) continue
              writer.inc(heatPath, `moves.${cell}`, amount)
              total += amount
            }
            if (total > 0) {
              writer.inc(sessionPath, 'moveCount', total)
              writer.inc(dayPath, 'moves', total)
              writer.set(sessionPath, { lastSeen: FieldValue.serverTimestamp() })
            }
            break
          }

          case 'scroll':
            writer.set(sessionPath, {
              maxScroll: clamp(event.depth, 100),
              lastSeen: FieldValue.serverTimestamp(),
            })
            break

          case 'session_end':
            writer.set(sessionPath, {
              endedAt: FieldValue.serverTimestamp(),
              lastSeen: FieldValue.serverTimestamp(),
            })
            break

          default:
            break
        }
      }

      const batch = db.batch()
      writer.commit(batch)
      await batch.commit()

      res.status(200).json({ ok: true, country: geo.code })
    } catch (error) {
      console.error('[omberIngest] failed', error)
      res.status(500).json({ error: 'Could not store analytics' })
    }
  },
)
