/*
 * orbit tracker
 * Add to any page with:
 * <script async src="https://orbit.omber.space/tracker.js"
 *   data-site-id="my-site"
 *   data-endpoint="https://us-central1-PROJECT.cloudfunctions.net/omberIngest"></script>
 *
 * Optional data attributes: data-heatmap="false", data-sample-rate="0.5",
 * data-include-query="true", data-respect-dnt="false", data-debug="true"
 */
(function (window, document) {
  'use strict'

  var script = document.currentScript
  var attrs = script && script.dataset ? script.dataset : {}
  var globalConfig = window.orbit || window.OmbersOrbit || window.OmberAnalytics || {}

  function option(name, fallback) {
    if (attrs[name] !== undefined && attrs[name] !== '') return attrs[name]
    if (globalConfig[name] !== undefined) return globalConfig[name]
    return fallback
  }

  function isTrue(value) {
    return value === true || value === 'true' || value === '1'
  }

  var endpoint = option('endpoint', '')
  var siteId = option('siteId', '')
  if (!endpoint || !siteId) {
    if (window.console) {
      console.warn("[orbit] Missing data-endpoint or data-site-id. Tracking disabled.")
    }
    return
  }

  var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack
  if (isTrue(option('respectDnt', true)) && String(dnt) === '1') return

  var sampleRate = parseFloat(option('sampleRate', 1))
  if (!isFinite(sampleRate) || sampleRate <= 0) return
  if (sampleRate < 1 && Math.random() > sampleRate) return

  var heatmapOption = option('heatmap', true)
  var trackHeatmap = heatmapOption !== false && heatmapOption !== 'false'
  var includeQuery = isTrue(option('includeQuery', false))
  var debug = isTrue(option('debug', false))
  var GRID = 50
  var MAX_EVENTS_PER_BATCH = 200

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID()
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
      var random = (Math.random() * 16) | 0
      var value = char === 'x' ? random : (random & 0x3) | 0x8
      return value.toString(16)
    })
  }

  function storeGet(key) {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  }

  function storeSet(key, value) {
    try {
      window.sessionStorage.setItem(key, value)
    } catch {
      /* private mode: keep the id in memory only */
    }
  }

  var sessionId = storeGet('omber_session_id')
  if (!sessionId) {
    sessionId = uuid()
    storeSet('omber_session_id', sessionId)
  }

  function currentPath() {
    var path = window.location.pathname || '/'
    if (includeQuery && window.location.search) path += window.location.search
    return path.slice(0, 300)
  }

  function safeReferrer() {
    var referrer = document.referrer || ''
    if (!referrer) return ''
    try {
      var url = new URL(referrer)
      if (url.host === window.location.host) return ''
      return url.origin
    } catch {
      return ''
    }
  }

  function deviceType() {
    var width = window.innerWidth
    if (width < 640) return 'mobile'
    if (width < 1024) return 'tablet'
    return 'desktop'
  }

  function browserName() {
    var agent = navigator.userAgent || ''
    if (/Edg\//.test(agent)) return 'Edge'
    if (/OPR\/|Opera/.test(agent)) return 'Opera'
    if (/Firefox\//.test(agent)) return 'Firefox'
    if (/Chrome\//.test(agent)) return 'Chrome'
    if (/Safari\//.test(agent)) return 'Safari'
    return 'Other'
  }

  function cleanToken(value) {
    return String(value || '')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 40)
  }

  function describeElement(element) {
    var tag = (element.tagName || 'element').toLowerCase()
    var id = element.id ? '#' + cleanToken(element.id) : ''
    var classes = ''
    var className = element.className
    if (typeof className === 'string' && className.trim()) {
      classes = '.' + className.trim().split(/\s+/).slice(0, 2).map(cleanToken).join('.')
    }
    var rawText =
      element.innerText || element.textContent || element.getAttribute('value') || ''
    var text = String(rawText).replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!text && tag === 'input') {
      text = String(element.getAttribute('placeholder') || '').trim().slice(0, 40)
    }
    return (tag + id + classes + (text ? ' "' + text + '"' : '')).slice(0, 120)
  }

  function percentage(value, total) {
    return Math.max(0, Math.min(100, Math.round((value / Math.max(1, total)) * 100)))
  }

  function cellKey(x, y) {
    var gx = Math.max(0, Math.min(GRID - 1, Math.floor((x / Math.max(1, window.innerWidth)) * GRID)))
    var gy = Math.max(0, Math.min(GRID - 1, Math.floor((y / Math.max(1, window.innerHeight)) * GRID)))
    return gx + '_' + gy
  }

  var page = currentPath()
  var queue = []
  var moveCells = {}
  var flushing = false
  var activeMs = 0
  var reportedMs = 0
  var lastTick = Date.now()
  var visible = !document.hidden
  var maxScroll = 0

  function push(type, extra) {
    var event = { type: type, ts: Date.now(), page: page, sessionId: sessionId }
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) event[key] = extra[key]
      }
    }
    queue.push(event)
    if (queue.length >= MAX_EVENTS_PER_BATCH) flush()
  }

  function accumulate() {
    var now = Date.now()
    if (visible) activeMs += Math.max(0, now - lastTick)
    lastTick = now
  }

  function send(payload) {
    if (debug && window.console) console.debug("[orbit]", payload)
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' })
        if (navigator.sendBeacon(endpoint, blob)) return
      }
    } catch {
      /* fall through to fetch */
    }
    try {
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
        mode: 'cors',
      }).catch(function (error) {
        if (debug && window.console) console.warn("[orbit] delivery failed", error)
      })
    } catch (error) {
      if (debug && window.console) console.warn("[orbit] delivery failed", error)
    }
  }

  function flush() {
    if (flushing) return
    flushing = true
    try {
      accumulate()
      var delta = activeMs - reportedMs
      if (delta > 0) {
        delta = Math.min(delta, 300000)
        push('heartbeat', { deltaMs: delta })
        reportedMs += delta
      }

      var cells = Object.keys(moveCells)
      if (cells.length) {
        push('moves', { counts: moveCells })
        moveCells = {}
      }

      if (!queue.length) return
      var payload = JSON.stringify({ siteId: siteId, events: queue })
      queue = []
      send(payload)
    } finally {
      flushing = false
    }
  }

  push('session_start', {
    meta: {
      referrer: safeReferrer(),
      screen: window.screen ? window.screen.width + 'x' + window.screen.height : '',
      device: deviceType(),
      browser: browserName(),
      language: navigator.language || '',
      timezone: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '',
      startedAt: Date.now(),
      sessionId: sessionId,
    },
  })
  push('pageview')

  document.addEventListener(
    'click',
    function (event) {
      var target = event.target
      if (!target) return
      if (target.nodeType !== 1 && target.parentElement) target = target.parentElement
      push('click', {
        label: describeElement(target),
        x: percentage(event.clientX, window.innerWidth),
        y: percentage(event.clientY, window.innerHeight),
        cell: cellKey(event.clientX, event.clientY),
      })
    },
    true,
  )

  if (trackHeatmap) {
    var lastMove = 0
    document.addEventListener(
      'mousemove',
      function (event) {
        var now = Date.now()
        if (now - lastMove < 120) return
        lastMove = now
        var key = cellKey(event.clientX, event.clientY)
        moveCells[key] = (moveCells[key] || 0) + 1
      },
      { passive: true },
    )
  }

  var lastScroll = 0
  window.addEventListener(
    'scroll',
    function () {
      var now = Date.now()
      if (now - lastScroll < 200) return
      lastScroll = now
      var root = document.documentElement || document.body
      var scrollable = Math.max(1, (root.scrollHeight || 0) - window.innerHeight)
      var offset = window.pageYOffset || root.scrollTop || 0
      var depth = Math.max(0, Math.min(100, Math.round((offset / scrollable) * 100)))
      if (depth > maxScroll) {
        maxScroll = depth
        push('scroll', { depth: depth })
      }
    },
    { passive: true },
  )

  function routeChanged() {
    var next = currentPath()
    if (next === page) return
    page = next
    maxScroll = 0
    moveCells = {}
    push('pageview')
    flush()
  }

  var originalPushState = history.pushState
  var originalReplaceState = history.replaceState
  history.pushState = function () {
    var result = originalPushState.apply(this, arguments)
    window.setTimeout(routeChanged, 0)
    return result
  }
  history.replaceState = function () {
    var result = originalReplaceState.apply(this, arguments)
    window.setTimeout(routeChanged, 0)
    return result
  }
  window.addEventListener('popstate', routeChanged)
  window.addEventListener('hashchange', routeChanged)

  document.addEventListener('visibilitychange', function () {
    accumulate()
    visible = !document.hidden
    lastTick = Date.now()
    if (!visible) flush()
  })

  window.addEventListener('pagehide', function () {
    accumulate()
    push('session_end', { ended: true })
    flush()
  })

  window.setInterval(flush, 5000)
})(window, document)
