'use strict';

(() => {
  const DATA = JSON.parse(document.getElementById('dashboard-data').textContent)
  const app = document.getElementById('app')
  const issues = new Map(DATA.issues.map((issue) => [`${issue.targetId}/${issue.id}`, issue]))
  for (const run of DATA.runs) run.issues = run.issueIds.map((id) => issues.get(`${run.targetId}/${id}`)).filter(Boolean)
  const runs = new Map(DATA.runs.map((run) => [run.id, run]))
  const targets = new Map(DATA.targets.map((target) => [target.id, target]))
  const targetColors = ['#67e8c1', '#77a7ff', '#f4bf62', '#dd8cff', '#fb7185']
  const svgNs = 'http://www.w3.org/2000/svg'

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null) continue
      if (key === 'class') node.className = value
      else if (key === 'checked') node.checked = Boolean(value)
      else if (key === 'disabled') node.disabled = Boolean(value)
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, String(value))
    }
    for (const child of children.flat()) {
      if (child == null) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }

  const svg = (tag, attrs = {}, ...children) => {
    const node = document.createElementNS(svgNs, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    for (const child of children.flat()) if (child != null) node.append(child)
    return node
  }

  const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
  const fmt = (value, kind = 'number') => {
    if (value == null || !Number.isFinite(value)) return 'N/A'
    if (kind === 'money') return '$' + value.toFixed(value < 10 ? 2 : 1)
    if (kind === 'percent') return (value * 100).toFixed(1) + '%'
    if (kind === 'minutes') return number.format(value / 60000) + ' min'
    if (kind === 'compact') return compact.format(value)
    if (kind === 'ratio') return value.toFixed(2) + '×'
    return number.format(value)
  }

  const total = (items, getter) => {
    const values = items.map(getter).filter((value) => value != null && Number.isFinite(value))
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null
  }

  const badge = (text, type = '') => el('span', { class: `badge ${type}`.trim() }, text)
  const hashLink = (label, hash, className) => el('a', { href: hash, class: className }, label)
  const externalLink = (label, href) => {
    try {
      const url = new URL(href)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol')
      return el('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, label)
    } catch (_) {
      return el('span', {}, label)
    }
  }

  const field = (label, control, extraClass = '') => el('div', { class: `field ${extraClass}`.trim() }, el('label', { for: control.id }, label), control)
  const option = (value, label, selected) => el('option', { value, selected: selected ? '' : null }, label)
  const select = (id, choices, selected, onChange) => {
    const control = el('select', { id, onchange: onChange })
    for (const [value, label] of choices) control.append(option(value, label, value === selected))
    control.value = selected
    return control
  }

  function frame(content) {
    app.replaceChildren(
      el('div', { class: 'shell' },
        el('header', { class: 'topbar' },
          hashLink('', '#overview', 'brand'),
          el('nav', { class: 'header-actions', 'aria-label': 'Dashboard navigation' },
            hashLink('Overview', '#overview'),
            el('a', { href: './review-bakeoff.md' }, 'Benchmark report'),
          ),
        ),
        el('main', { id: 'main' }, content),
        el('footer', { class: 'footer' }, 'Generated from tracked benchmark artifacts · no network requests · no transcript scanning'),
      ),
    )
    const brand = document.querySelector('.brand')
    brand.append(el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'RX'))
    brand.append(el('span', {}, el('strong', {}, 'Run Explorer'), el('small', {}, 'Review-tool benchmark')))
  }

  function route() {
    const raw = location.hash.slice(1) || 'overview'
    const [path, query = ''] = raw.split('?')
    const parts = path.split('/').map(decodeURIComponent)
    if (parts[0] === 'run' && parts.length >= 3) renderRun(`${parts[1]}/${parts[2]}`)
    else if (parts[0] === 'compare' && parts.length >= 5) renderComparison(`${parts[1]}/${parts[2]}`, `${parts[3]}/${parts[4]}`)
    else renderOverview(new URLSearchParams(query))
    window.scrollTo({ top: 0, behavior: 'auto' })
  }

  const runHash = (run) => `#run/${encodeURIComponent(run.targetId)}/${encodeURIComponent(run.toolId)}`
  const compareHash = (left, right) => `#compare/${encodeURIComponent(left.targetId)}/${encodeURIComponent(left.toolId)}/${encodeURIComponent(right.targetId)}/${encodeURIComponent(right.toolId)}`

  function hero(eyebrow, title, text, crumbs = []) {
    const trail = crumbs.length ? el('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' }, crumbs) : null
    return el('section', { class: 'hero' }, el('div', { class: 'eyebrow' }, eyebrow), el('h1', {}, title), el('p', {}, text), trail)
  }

  function kpi(label, value, note) {
    return el('div', { class: 'kpi' }, el('span', {}, label), el('strong', {}, value), note ? el('small', {}, note) : null)
  }

  function overviewParams(params, patch) {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '') next.delete(key)
      else next.set(key, value)
    }
    location.hash = 'overview' + (next.toString() ? '?' + next.toString() : '')
  }

  function matchesOverviewDimensions(run, params) {
    const target = params.get('target') || 'all'
    const tool = params.get('tool') || 'all'
    const q = (params.get('q') || '').toLowerCase()
    if (target !== 'all' && run.targetId !== target) return false
    if (tool !== 'all' && run.toolId !== tool) return false
    if (q && !`${run.targetId} ${run.toolId} ${run.toolLabel} ${run.toolSource || ''}`.toLowerCase().includes(q)) return false
    return true
  }

  function filteredRuns(params) {
    const status = params.get('status') || 'recommended'
    return DATA.runs.filter((run) => {
      if (!matchesOverviewDimensions(run, params)) return false
      if (status === 'recommended' && !(['complete', 'salvaged'].includes(run.status) && run.metrics.real > 0 && run.usage.total != null && run.usage.total <= DATA.defaultTokenLimit)) return false
      return ['all', 'recommended'].includes(status) || run.status === status
    })
  }

  const sortValues = {
    run: (run) => run.id,
    status: (run) => run.status,
    cost: (run) => run.usage.costUsd,
    wall: (run) => run.wallMs,
    tokens: (run) => run.usage.total,
    claims: (run) => run.metrics.claims,
    real: (run) => run.metrics.real,
    precision: (run) => run.metrics.precision,
  }

  function sortedRuns(items, params) {
    const key = params.get('sort') || 'run'
    const direction = params.get('dir') === 'desc' ? -1 : 1
    const getter = sortValues[key] || sortValues.run
    return [...items].sort((a, b) => {
      const av = getter(a), bv = getter(b)
      if (av == null && bv == null) return a.id.localeCompare(b.id)
      if (av == null) return 1
      if (bv == null) return -1
      return direction * (typeof av === 'string' ? av.localeCompare(bv) : av - bv) || a.id.localeCompare(b.id)
    })
  }

  function renderOverview(params) {
    const visible = filteredRuns(params)
    const analysisItems = DATA.runs.filter((run) => matchesOverviewDimensions(run, params) && ['complete', 'salvaged'].includes(run.status) && run.metrics.real > 0)
    const ordered = sortedRuns(visible, params)
    const picked = (params.get('pick') || '').split(',').filter((id) => runs.has(id)).slice(0, 2)
    const controls = el('div', { class: 'controls' })
    const targetChoices = [['all', 'All targets'], ...DATA.targets.map((item) => [item.id, `${item.id} · ${item.language}`])]
    const toolChoices = [['all', 'All tools'], ...DATA.tools.filter((tool) => DATA.runs.some((run) => run.toolId === tool.id)).map((tool) => [tool.id, tool.label])]
    controls.append(
      field('Target', select('target-filter', targetChoices, params.get('target') || 'all', (event) => overviewParams(params, { target: event.target.value === 'all' ? '' : event.target.value }))),
      field('Tool', select('tool-filter', toolChoices, params.get('tool') || 'all', (event) => overviewParams(params, { tool: event.target.value === 'all' ? '' : event.target.value }))),
      field('Runs', select('status-filter', [['recommended', 'Useful only'], ['all', 'All runs'], ['complete', 'Complete'], ['salvaged', 'Salvaged'], ['failed', 'Failed'], ['dnf', 'DNF']], params.get('status') || 'recommended', (event) => overviewParams(params, { status: event.target.value === 'recommended' ? '' : event.target.value }))),
    )
    const search = el('input', { id: 'run-search', type: 'search', value: params.get('q') || '', placeholder: 'Tool or target…', onchange: (event) => overviewParams(params, { q: event.target.value.trim() }) })
    controls.append(field('Search', search, 'search'))

    const content = el('div', {},
      hero('Offline benchmark dashboard', 'Every run, without the black box.', 'Inspect cost, time, token composition, extracted claims, and verified outcomes. All figures come from committed artifacts embedded in this file.'),
      el('section', { class: 'kpis', 'aria-label': 'Filtered run totals' },
        kpi('Runs', fmt(visible.length), `${DATA.runs.length} stored`),
        kpi('Recorded cost', fmt(total(visible, (run) => run.usage.costUsd), 'money'), 'stored cell totals'),
        kpi('Wall time', fmt(total(visible, (run) => run.wallMs), 'minutes'), 'across available runs'),
        kpi('Tokens', fmt(total(visible, (run) => run.usage.total), 'compact'), 'all token classes'),
        kpi('Confirmed', fmt(total(visible, (run) => run.metrics.real)), 'reported real findings'),
        kpi('Failures', fmt(visible.filter((run) => ['failed', 'dnf'].includes(run.status)).length), 'failed or did not finish'),
      ),
      el('section', { class: 'panel' },
        el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Run matrix'), el('p', {}, `Default: successful runs with ≥1 real finding and ≤${compact.format(DATA.defaultTokenLimit)} tokens. Select two rows to compare.`))),
        controls,
        runTable(ordered, params, picked),
      ),
      comparisonDock(picked, params),
      skillModelAnalysis(analysisItems, params),
      chartGrid(visible, params),
    )
    frame(content)
  }

  function sortHeading(label, key, params, numeric = false) {
    const active = (params.get('sort') || 'run') === key
    const dir = active && params.get('dir') !== 'desc' ? 'desc' : 'asc'
    const mark = active ? (params.get('dir') === 'desc' ? ' ↓' : ' ↑') : ''
    return el('th', { class: numeric ? 'num' : '' }, el('button', { class: 'sort-button', onclick: () => overviewParams(params, { sort: key, dir }), 'aria-label': `Sort by ${label}` }, label + mark))
  }

  function runTable(items, params, picked) {
    const table = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, el('span', { class: 'sr-only' }, 'Compare')),
        sortHeading('Run', 'run', params), sortHeading('Status', 'status', params),
        sortHeading('Cost', 'cost', params, true), sortHeading('Wall', 'wall', params, true),
        sortHeading('Tokens', 'tokens', params, true), sortHeading('Claims', 'claims', params, true),
        sortHeading('Real', 'real', params, true), sortHeading('Precision', 'precision', params, true),
      )),
    )
    const body = el('tbody')
    for (const run of items) {
      const checked = picked.includes(run.id)
      const box = el('input', { type: 'checkbox', checked, 'aria-label': `Select ${run.id} for comparison`, disabled: !checked && picked.length >= 2 })
      box.addEventListener('change', () => {
        const next = checked ? picked.filter((id) => id !== run.id) : [...picked, run.id]
        overviewParams(params, { pick: next.join(',') })
      })
      body.append(el('tr', {},
        el('td', {}, box),
        el('td', {}, hashLink(run.toolLabel, runHash(run), 'run-link'), el('span', { class: 'subline' }, `${run.targetId} · ${run.toolId} · ${run.toolSource || 'source unavailable'}`)),
        el('td', {}, badge(run.status, run.status)),
        el('td', { class: 'num' }, fmt(run.usage.costUsd, 'money'), el('span', { class: 'subline' }, run.usage.source)),
        el('td', { class: 'num' }, fmt(run.wallMs, 'minutes')),
        el('td', { class: 'num' }, fmt(run.usage.total, 'compact')),
        el('td', { class: 'num' }, fmt(run.metrics.claims)),
        el('td', { class: 'num' }, fmt(run.metrics.real)),
        el('td', { class: 'num' }, fmt(run.metrics.precision, 'percent')),
      ))
    }
    table.append(body)
    return el('div', { class: 'table-wrap' }, items.length ? table : el('div', { class: 'empty' }, 'No runs match these filters.'))
  }

  function comparisonDock(picked, params) {
    if (!picked.length) return null
    const names = picked.map((id) => runs.get(id).toolLabel).join(' ↔ ')
    const compare = el('button', { class: 'primary', disabled: picked.length !== 2, onclick: () => { location.hash = compareHash(runs.get(picked[0]), runs.get(picked[1])) } }, 'Compare runs')
    return el('aside', { class: 'compare-dock', 'aria-live': 'polite' }, el('div', {}, el('strong', {}, `${picked.length}/2 selected`), el('span', { class: 'subline' }, names)), el('div', {}, el('button', { onclick: () => overviewParams(params, { pick: '' }) }, 'Clear'), ' ', compare))
  }

  function chartGrid(items, params) {
    const xKey = params.get('x') || 'cost'
    const yKey = params.get('y') || 'real'
    const metricKey = params.get('metric') || 'real'
    const scatterControls = el('div', { class: 'compact-controls' },
      field('X axis', select('scatter-x', [['cost', 'Cost'], ['wall', 'Wall time'], ['tokens', 'Tokens']], xKey, (event) => overviewParams(params, { x: event.target.value === 'cost' ? '' : event.target.value }))),
      field('Y axis', select('scatter-y', [['real', 'Real findings'], ['inScope', 'In-scope real'], ['precision', 'Precision']], yKey, (event) => overviewParams(params, { y: event.target.value === 'real' ? '' : event.target.value }))),
    )
    const metricControls = field('Metric', select('tool-metric', [['real', 'Real findings'], ['precision', 'Precision'], ['claims', 'Extracted claims'], ['cost', 'Cost'], ['wall', 'Wall time']], metricKey, (event) => overviewParams(params, { metric: event.target.value === 'real' ? '' : event.target.value })))
    return el('section', { class: 'charts' },
      el('div', { class: 'panel chart-panel' }, el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Efficiency field'), el('p', {}, 'Each point is a run; activate a point to open it.')), scatterControls), el('div', { class: 'panel-body' }, scatterChart(items, xKey, yKey), chartLegend())),
      el('div', { class: 'panel chart-panel' }, el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Tool × target'), el('p', {}, 'Compare one explicit metric across the matrix.')), metricControls), el('div', { class: 'panel-body' }, toolChart(items, metricKey), chartLegend())),
    )
  }

  function chartLegend() {
    return el('div', { class: 'chart-key' }, DATA.targets.map((target, index) => el('span', {}, el('i', { class: 'key-dot', style: `background:${targetColors[index % targetColors.length]}` }), target.id)))
  }

  const chartAccessors = {
    cost: [(run) => run.usage.costUsd, 'Recorded cost (USD)'],
    wall: [(run) => run.wallMs == null ? null : run.wallMs / 60000, 'Wall time (minutes)'],
    tokens: [(run) => run.usage.total, 'Tokens'],
    real: [(run) => run.metrics.real, 'Real findings'],
    inScope: [(run) => run.metrics.inScope, 'In-scope real findings'],
    precision: [(run) => run.metrics.precision, 'Precision'],
    claims: [(run) => run.metrics.claims, 'Extracted claims'],
  }

  function scale(value, max, start, span) { return start + (max > 0 ? value / max : 0) * span }

  function scatterChart(items, xKey, yKey) {
    const width = 680, height = 340, pad = { left: 62, right: 20, top: 20, bottom: 48 }
    const [getX, xLabel] = chartAccessors[xKey]
    const [getY, yLabel] = chartAccessors[yKey]
    const points = items.map((run) => ({ run, x: getX(run), y: getY(run) })).filter((point) => point.x != null && point.y != null)
    const maxX = Math.max(0, ...points.map((point) => point.x))
    const maxY = Math.max(0, ...points.map((point) => point.y))
    const graph = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${yLabel} by ${xLabel}` })
    for (let i = 0; i <= 4; i++) {
      const x = pad.left + i * (width - pad.left - pad.right) / 4
      const y = pad.top + i * (height - pad.top - pad.bottom) / 4
      graph.append(svg('line', { class: 'grid', x1: x, y1: pad.top, x2: x, y2: height - pad.bottom }))
      graph.append(svg('line', { class: 'grid', x1: pad.left, y1: y, x2: width - pad.right, y2: y }))
      const xText = svg('text', { x, y: height - 25, 'text-anchor': 'middle' })
      xText.textContent = compact.format(maxX * i / 4)
      graph.append(xText)
      const yText = svg('text', { x: pad.left - 9, y: height - pad.bottom - i * (height - pad.top - pad.bottom) / 4 + 4, 'text-anchor': 'end' })
      yText.textContent = yKey === 'precision' ? Math.round(maxY * i * 25) + '%' : compact.format(maxY * i / 4)
      graph.append(yText)
    }
    graph.append(svg('line', { class: 'axis', x1: pad.left, y1: height - pad.bottom, x2: width - pad.right, y2: height - pad.bottom }))
    graph.append(svg('line', { class: 'axis', x1: pad.left, y1: pad.top, x2: pad.left, y2: height - pad.bottom }))
    for (const point of points) {
      const cx = scale(point.x, maxX, pad.left, width - pad.left - pad.right)
      const cy = height - pad.bottom - (maxY > 0 ? point.y / maxY : 0) * (height - pad.top - pad.bottom)
      const circle = svg('circle', { class: 'point', cx, cy, r: 6, tabindex: 0, role: 'link', fill: targetColors[DATA.targets.findIndex((target) => target.id === point.run.targetId) % targetColors.length], 'aria-label': `${point.run.toolLabel} on ${point.run.targetId}: ${fmt(point.x)}, ${fmt(point.y)}` })
      circle.addEventListener('click', () => { location.hash = runHash(point.run) })
      circle.addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); location.hash = runHash(point.run) } })
      const title = svg('title'); title.textContent = `${point.run.toolLabel} · ${point.run.targetId}\n${xLabel}: ${fmt(point.x)} · ${yLabel}: ${fmt(point.y, yKey === 'precision' ? 'percent' : 'number')}`
      circle.append(title); graph.append(circle)
    }
    if (!points.length) {
      const text = svg('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle' }); text.textContent = 'No available values'; graph.append(text)
    }
    return graph
  }

  function toolChart(items, key) {
    const width = 680, rowHeight = 31, left = 190, right = 46
    const toolsInView = DATA.tools.filter((tool) => items.some((run) => run.toolId === tool.id))
    const height = Math.max(300, 55 + toolsInView.length * rowHeight)
    const [getter, label] = chartAccessors[key]
    const value = (run) => key === 'wall' ? (run.wallMs == null ? null : run.wallMs / 60000) : key === 'cost' ? run.usage.costUsd : getter(run)
    const values = items.map(value).filter((item) => item != null)
    const max = Math.max(0, ...values)
    const graph = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${label} by tool and target` })
    for (let i = 0; i <= 4; i++) {
      const x = left + i * (width - left - right) / 4
      graph.append(svg('line', { class: 'grid', x1: x, y1: 18, x2: x, y2: height - 30 }))
      const text = svg('text', { x, y: height - 10, 'text-anchor': 'middle' }); text.textContent = key === 'precision' ? Math.round(max * i * 25) + '%' : compact.format(max * i / 4); graph.append(text)
    }
    toolsInView.forEach((tool, row) => {
      const y = 31 + row * rowHeight
      const labelText = svg('text', { x: left - 10, y: y + 4, 'text-anchor': 'end' }); labelText.textContent = tool.label.length > 27 ? tool.label.slice(0, 25) + '…' : tool.label; graph.append(labelText)
      DATA.targets.forEach((target, targetIndex) => {
        const run = items.find((item) => item.toolId === tool.id && item.targetId === target.id)
        const metric = run ? value(run) : null
        const circle = svg('circle', { cx: metric == null ? left : scale(metric, max, left, width - left - right), cy: y + (targetIndex - (DATA.targets.length - 1) / 2) * 6, r: 4, fill: metric == null ? '#3a4553' : targetColors[targetIndex % targetColors.length] })
        const title = svg('title'); title.textContent = `${tool.label} · ${target.id}: ${fmt(metric, key === 'precision' ? 'percent' : key === 'cost' ? 'money' : 'number')}`; circle.append(title); graph.append(circle)
      })
    })
    return graph
  }

  function eligibleTargets(toolId, params) {
    const selected = params.get('target')
    const tool = DATA.tools.find((item) => item.id === toolId)
    return DATA.targets.filter((target) =>
      (!selected || selected === 'all' || target.id === selected) &&
      (!tool || !tool.languages || tool.languages.includes(target.language)),
    ).map((target) => target.id)
  }

  function issueKey(targetId, issue) { return `${targetId}/${issue.id}` }

  function issueUniverse(targetIds, scope) {
    const found = new Set()
    for (const run of DATA.runs) {
      if (!['complete', 'salvaged'].includes(run.status) || !targetIds.includes(run.targetId)) continue
      for (const issue of run.issues) {
        if (issue.verdict !== 'real' || (scope === 'in' && issue.scope !== 'in-scope')) continue
        found.add(issueKey(run.targetId, issue))
      }
    }
    return found
  }

  function skillModelGroups(items, params) {
    const grouped = new Map()
    const usable = items.filter((run) => ['complete', 'salvaged'].includes(run.status) && run.metrics.real > 0 && run.usage.costUsd > 0)
    for (const run of usable) {
      const modelNames = Object.keys(run.usage.models || {}).sort()
      const modelMix = modelNames.length ? modelNames.join(' + ') : 'model unavailable'
      const key = `${run.toolId}::${modelMix}`
      if (!grouped.has(key)) grouped.set(key, { key, toolId: run.toolId, label: run.toolLabel, source: run.toolSource, modelMix, runs: [], cost: 0, issues: new Map() })
      const group = grouped.get(key)
      group.runs.push(run)
      group.cost += run.usage.costUsd
      for (const issue of run.issues) group.issues.set(issueKey(run.targetId, issue), { issue, targetId: run.targetId })
    }
    const groups = []
    for (const group of grouped.values()) {
      const targetIds = eligibleTargets(group.toolId, params)
      const rows = [...group.issues.values()].filter((row) => targetIds.includes(row.targetId))
      const real = rows.filter((row) => row.issue.verdict === 'real')
      const inScope = real.filter((row) => row.issue.scope === 'in-scope')
      const falsePositive = rows.filter((row) => row.issue.verdict === 'false-positive').length
      const decided = real.length + falsePositive
      const universeAll = issueUniverse(targetIds, 'all').size
      const universeIn = issueUniverse(targetIds, 'in').size
      const severity = (allowed) => real.filter((row) => allowed.includes(row.issue.severity)).length
      const perTarget = targetIds.map((targetId) => {
        const targetRuns = group.runs.filter((run) => run.targetId === targetId)
        if (!targetRuns.length) return { targetId, completeness: null, efficiency: null }
        const targetCost = total(targetRuns, (run) => run.usage.costUsd)
        const targetReal = new Set()
        for (const run of targetRuns) for (const issue of run.issues) if (issue.verdict === 'real') targetReal.add(issueKey(targetId, issue))
        const denominator = issueUniverse([targetId], 'all').size
        return {
          targetId,
          completeness: denominator ? targetReal.size / denominator : null,
          efficiency: targetCost > 0 ? targetReal.size / targetCost : null,
        }
      })
      groups.push({
        ...group,
        targetIds,
        coverage: new Set(group.runs.map((run) => run.targetId).filter((id) => targetIds.includes(id))).size,
        allReal: real.length,
        inReal: inScope.length,
        efficiencyAll: group.cost > 0 ? real.length / group.cost : null,
        efficiencyIn: group.cost > 0 ? inScope.length / group.cost : null,
        severityHigh: group.cost > 0 ? severity(['high']) / group.cost : null,
        severityMedium: group.cost > 0 ? severity(['high', 'medium']) / group.cost : null,
        severityLow: group.cost > 0 ? severity(['high', 'medium', 'low']) / group.cost : null,
        completenessAll: universeAll ? real.length / universeAll : null,
        completenessIn: universeIn ? inScope.length / universeIn : null,
        falsePositiveRate: decided ? falsePositive / decided : null,
        falsePositive,
        decided,
        perTarget,
      })
    }
    return groups
  }

  const analysisColors = ['#67e8c1', '#77a7ff', '#f4bf62']

  function analysisLabel(group) {
    return el('div', { class: 'analysis-label' },
      el('strong', {}, group.label),
      el('span', {}, `${group.source || 'source unavailable'} · ${group.modelMix} · ${group.coverage}/${group.targetIds.length} targets · ${fmt(group.cost, 'money')}`),
    )
  }

  function metricOrder(groups, getter, ascending = false) {
    return [...groups].sort((a, b) => {
      const av = getter(a), bv = getter(b)
      if (av == null && bv == null) return a.label.localeCompare(b.label)
      if (av == null) return 1
      if (bv == null) return -1
      return (ascending ? av - bv : bv - av) || a.label.localeCompare(b.label)
    })
  }

  function seriesChart(groups, series, kind = 'number', fixedMax = null, sortIndex = series.length - 1, ascending = false) {
    const values = groups.flatMap((group) => series.map((item) => item.get(group))).filter((value) => value != null)
    const max = fixedMax == null ? Math.max(0, ...values) : fixedMax
    const ordered = metricOrder(groups, series[sortIndex].get, ascending)
    return el('div', { class: 'series-chart' },
      el('div', { class: 'series-key' }, series.map((item, index) => el('span', {}, el('i', { style: `background:${analysisColors[index % analysisColors.length]}` }), item.label))),
      ...(ordered.length ? ordered.map((group) => el('div', { class: 'series-row' },
        analysisLabel(group),
        el('div', { class: 'series-bars' }, series.map((item, index) => {
          const value = item.get(group)
          return el('div', { class: 'series-bar', title: `${item.label}: ${fmt(value, kind)}` },
            el('span', { style: `width:${value == null || !max ? 0 : Math.min(100, value / max * 100)}%;background:${analysisColors[index % analysisColors.length]}` }),
            el('b', {}, fmt(value, kind)),
          )
        })),
      )) : [el('div', { class: 'empty' }, 'No successful useful runs match current filters.')]),
    )
  }

  function analysisPanel(title, note, chart) {
    return el('section', { class: 'panel chart-panel' },
      el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, title), el('p', {}, note))),
      el('div', { class: 'panel-body' }, chart),
    )
  }

  function paretoChart(groups) {
    const points = groups.filter((group) => group.cost > 0 && group.completenessAll != null)
    const frontier = points.filter((point) => !points.some((other) => other !== point && other.cost <= point.cost && other.completenessAll >= point.completenessAll && (other.cost < point.cost || other.completenessAll > point.completenessAll)))
    const width = 680, height = 360, pad = { left: 60, right: 25, top: 25, bottom: 50 }
    const maxCost = Math.max(0, ...points.map((point) => point.cost))
    const graph = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Cost versus completeness Pareto frontier' })
    for (let i = 0; i <= 4; i++) {
      const x = pad.left + i * (width - pad.left - pad.right) / 4
      const y = height - pad.bottom - i * (height - pad.top - pad.bottom) / 4
      graph.append(svg('line', { class: 'grid', x1: x, y1: pad.top, x2: x, y2: height - pad.bottom }))
      graph.append(svg('line', { class: 'grid', x1: pad.left, y1: y, x2: width - pad.right, y2: y }))
      const xt = svg('text', { x, y: height - 25, 'text-anchor': 'middle' }); xt.textContent = '$' + number.format(maxCost * i / 4); graph.append(xt)
      const yt = svg('text', { x: pad.left - 8, y: y + 4, 'text-anchor': 'end' }); yt.textContent = i * 25 + '%'; graph.append(yt)
    }
    const frontierPoints = [...frontier].sort((a, b) => a.cost - b.cost).map((point) => `${scale(point.cost, maxCost, pad.left, width - pad.left - pad.right)},${height - pad.bottom - point.completenessAll * (height - pad.top - pad.bottom)}`).join(' ')
    if (frontierPoints) graph.append(svg('polyline', { class: 'frontier', points: frontierPoints }))
    points.forEach((point, index) => {
      const cx = scale(point.cost, maxCost, pad.left, width - pad.left - pad.right)
      const cy = height - pad.bottom - point.completenessAll * (height - pad.top - pad.bottom)
      const radius = 5 + (point.falsePositiveRate || 0) * 18
      const circle = svg('circle', { class: `analysis-point${frontier.includes(point) ? ' frontier-point' : ''}`, cx, cy, r: radius, fill: analysisColors[index % analysisColors.length] })
      const title = svg('title'); title.textContent = `${point.label}\n${point.modelMix}\nCost: ${fmt(point.cost, 'money')} · completeness: ${fmt(point.completenessAll, 'percent')} · false-positive rate: ${fmt(point.falsePositiveRate, 'percent')}`; circle.append(title); graph.append(circle)
    })
    return el('div', {}, graph, el('div', { class: 'chart-key' }, 'Line = non-dominated frontier · bubble size = false-positive rate'))
  }

  function rangeChart(groups, key, kind) {
    const rows = groups.map((group) => {
      const values = group.perTarget.map((row) => row[key]).filter((value) => value != null).sort((a, b) => a - b)
      if (!values.length) return { group, min: null, median: null, max: null }
      const middle = Math.floor(values.length / 2)
      const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
      return { group, min: values[0], median, max: values[values.length - 1] }
    }).sort((a, b) => {
      if (a.median == null && b.median == null) return a.group.label.localeCompare(b.group.label)
      if (a.median == null) return 1
      if (b.median == null) return -1
      return b.median - a.median || a.group.label.localeCompare(b.group.label)
    })
    const maxValue = kind === 'percent' ? 1 : Math.max(0, ...rows.map((row) => row.max || 0))
    return el('div', { class: 'range-chart' }, rows.map((row) => el('div', { class: 'range-row' },
      analysisLabel(row.group),
      el('div', { class: 'range-track' },
        row.min == null ? el('span', { class: 'muted' }, 'N/A') : el('span', { class: 'range-line', style: `left:${row.min / maxValue * 100}%;width:${(row.max - row.min) / maxValue * 100}%` }),
        row.median == null ? null : el('i', { style: `left:${row.median / maxValue * 100}%` }),
      ),
      el('span', { class: 'range-values' }, row.min == null ? 'N/A' : `${fmt(row.min, kind)} / ${fmt(row.median, kind)} / ${fmt(row.max, kind)}`),
    )))
  }

  function skillModelAnalysis(items, params) {
    const groups = skillModelGroups(items, params)
    const robustKey = params.get('robust') || 'completeness'
    const robustControl = field('Metric', select('robustness-metric', [['completeness', 'Completeness'], ['efficiency', 'Findings / dollar']], robustKey, (event) => overviewParams(params, { robust: event.target.value === 'completeness' ? '' : event.target.value })))
    return el('section', { class: 'analysis-section' },
      el('div', { class: 'analysis-intro' },
        el('div', {}, el('div', { class: 'eyebrow' }, 'Skill + model analysis'), el('h2', {}, 'Quality-adjusted economics'), el('p', {}, 'Charts include every complete or salvaged run with real findings, including token-heavy runs hidden from default table. Each row groups one skill with its exact model mix. Multi-model findings cannot be attributed to one model, so full run cost and outcomes stay together. Completeness uses unique real judgement IDs found by all complete or salvaged runs on eligible targets.')),
      ),
      el('div', { class: 'analysis-grid' },
        analysisPanel('Finding / price efficiency', 'Sorted best-first by all-scope unique real findings per dollar.', seriesChart(groups, [{ label: 'In scope', get: (group) => group.efficiencyIn }, { label: 'All scopes', get: (group) => group.efficiencyAll }])),
        analysisPanel('Severity yield / price', 'Sorted best-first by ≥low yield; cumulative thresholds exclude nits.', seriesChart(groups, [{ label: '≥ high', get: (group) => group.severityHigh }, { label: '≥ medium', get: (group) => group.severityMedium }, { label: '≥ low', get: (group) => group.severityLow }])),
        analysisPanel('Completeness', 'Sorted best-first by all-scope unique-issue completeness.', seriesChart(groups, [{ label: 'In scope', get: (group) => group.completenessIn }, { label: 'All scopes', get: (group) => group.completenessAll }], 'percent', 1)),
        analysisPanel('False-positive rate', 'Sorted best-first: lowest false ÷ (real + false); unproven excluded.', seriesChart(groups, [{ label: 'False-positive rate', get: (group) => group.falsePositiveRate }], 'percent', 1, 0, true)),
        analysisPanel('Cost / completeness frontier', 'Upper-left points dominate: lower cost and higher completeness.', paretoChart(groups)),
        el('section', { class: 'panel chart-panel' }, el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Target robustness'), el('p', {}, 'Sorted best-first by median; bars show min / median / max across targets.')), robustControl), el('div', { class: 'panel-body' }, rangeChart(groups, robustKey, robustKey === 'completeness' ? 'percent' : 'number'))),
      ),
    )
  }

  function renderRun(id) {
    const run = runs.get(id)
    if (!run) return renderNotFound('Run not found', id)
    const target = targets.get(run.targetId)
    const content = el('div', {},
      hero('Run detail', run.toolLabel, `${run.targetId} · ${run.toolSource || run.toolId}`, [hashLink('Overview', '#overview'), ' / ', run.id]),
      runSummary(run, target),
      runMetrics(run),
      issueSection(run),
      claimSection(run),
      rawSection(run),
      upstreamSection(target),
    )
    frame(content)
  }

  function summaryItem(label, value, note) {
    return el('div', { class: 'summary-item' }, el('dt', {}, label), el('dd', {}, value, note ? el('small', {}, note) : null))
  }

  function runSummary(run, target) {
    const modelEntries = Object.entries(run.usage.models || {})
    const modelText = modelEntries.length ? modelEntries.map(([name, cost]) => `${name}: ${fmt(cost, 'money')}`).join(' · ') : 'N/A'
    const stats = run.subagentStats
    const subagentText = stats ? `${fmt(stats.spawned)} spawned · ${fmt(stats.completed)} completed · ${fmt(stats.failed)} failed` : run.usage.subagentTranscripts == null ? 'N/A' : `${fmt(run.usage.subagentTranscripts)} transcript files`
    return el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Execution record'), el('p', {}, 'Missing measurements stay unavailable; they are never converted to zero.')), badge(run.status, run.status)),
      el('div', { class: 'panel-body' },
        run.dnfReason ? el('div', { class: 'notice' }, run.dnfReason) : null,
        el('dl', { class: 'summary-grid' },
          summaryItem('Target', externalLink(`${target.id} PR #${target.pr}`, target.prUrl), target.title),
          summaryItem('Status', run.status, run.salvaged ? 'report salvaged from stored run data' : null),
          summaryItem('Wall time', fmt(run.wallMs, 'minutes'), run.wallMsDerived ? 'derived' : 'recorded'),
          summaryItem('Recorded cost', fmt(run.usage.costUsd, 'money'), `source: ${run.usage.source}`),
          summaryItem('Tokens', fmt(run.usage.total), 'input + output + cache classes'),
          summaryItem('Sessions', fmt(run.usage.sessions), run.sessionId ? `parent ${run.sessionId}` : null),
          summaryItem('Turns', fmt(run.numTurns), `exit ${fmt(run.exitCode)}`),
          summaryItem('Subagents', subagentText),
          summaryItem('Model costs', modelText),
          summaryItem('Finished', run.finishedAt ? new Date(run.finishedAt).toLocaleString() : 'N/A'),
          summaryItem('Attempts', fmt(run.attempts), run.attempts ? 'DNF attempts' : null),
          summaryItem('Usage provenance', badge(run.usage.source, 'source')),
        ),
        tokenComposition(run),
      ),
    )
  }

  function tokenComposition(run) {
    const fields = [['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache read'], ['cacheCreation', 'Cache creation'], ['thinking', 'Thinking (within output)']]
    const max = Math.max(0, ...fields.map(([key]) => run.usage[key] || 0))
    return el('div', { class: 'token-bars', style: 'margin-top:1rem' },
      el('div', {}, el('h3', {}, 'Token composition'), fields.map(([key, label]) =>
        el('div', { class: 'token-row' },
          el('span', {}, label),
          el('div', { class: 'track' }, el('span', { style: `width:${max ? (run.usage[key] || 0) / max * 100 : 0}%` })),
          el('strong', {}, fmt(run.usage[key], 'compact')),
        ),
      )),
      el('div', {}, el('h3', {}, 'Field provenance'), fields.slice(0, 4).map(([key, label]) =>
        el('div', { class: 'token-row' },
          el('span', {}, label),
          el('div', {}, badge(run.usage.sources[key] || 'unavailable', 'source')),
          el('strong', {}, fmt(run.usage[key], 'compact')),
        ),
      )),
    )
  }

  function runMetrics(run) {
    const m = run.metrics
    return el('section', { class: 'kpis', 'aria-label': 'Run quality metrics' },
      kpi('Extracted claims', fmt(m.claims)), kpi('Real', fmt(m.real), `${fmt(m.inScope)} in scope`),
      kpi('False positive', fmt(m.falsePositive)), kpi('Unproven', fmt(m.unproven), 'excluded from precision'),
      kpi('Precision', fmt(m.precision, 'percent'), 'real / (real + false)'),
      kpi('Real / dollar', fmt(m.realPerDollar), `${fmt(m.costPerReal, 'money')} per real`),
    )
  }

  function issueCard(issue, showReason = true) {
    const where = issue.file ? `${issue.file}${issue.line ? ':' + issue.line : ''}` : 'No file location'
    return el('article', { class: 'issue' },
      el('div', { class: 'issue-head' }, el('div', {}, el('h3', {}, issue.title), el('div', { class: 'where' }, where)), el('span', { class: 'muted' }, issue.id)),
      el('div', { class: 'badges' }, badge(issue.verdict, issue.verdict), badge(issue.scope, issue.scope), badge(issue.severity), issue.introducedByPr ? badge('PR-introduced', 'in-scope') : badge('pre-existing')),
      showReason && issue.verdictReason ? el('p', {}, issue.verdictReason) : null,
      showReason && issue.scopeReason ? el('p', { class: 'muted' }, `Scope: ${issue.scopeReason}`) : null,
    )
  }

  function issueSection(run) {
    const list = el('div', { class: 'issue-list' })
    const controls = el('div', { class: 'compact-controls' })
    const filters = { severity: 'all', verdict: 'all', scope: 'all', text: '', file: '', reason: '' }
    const update = () => {
      const q = filters.text.toLowerCase()
      const fileQuery = filters.file.toLowerCase()
      const reasonQuery = filters.reason.toLowerCase()
      const visible = run.issues.filter((issue) =>
        (filters.severity === 'all' || issue.severity === filters.severity) &&
        (filters.verdict === 'all' || issue.verdict === filters.verdict) &&
        (filters.scope === 'all' || issue.scope === filters.scope) &&
        (!q || issue.title.toLowerCase().includes(q)) &&
        (!fileQuery || String(issue.file || '').toLowerCase().includes(fileQuery)) &&
        (!reasonQuery || `${issue.verdictReason || ''} ${issue.scopeReason || ''}`.toLowerCase().includes(reasonQuery)),
      )
      list.replaceChildren(...(visible.length ? visible.map((issue) => issueCard(issue)) : [el('div', { class: 'empty' }, 'No judged issues match these filters.')]))
    }
    controls.append(
      field('Severity', select('issue-severity', [['all', 'All'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['nit', 'Nit']], 'all', (event) => { filters.severity = event.target.value; update() })),
      field('Verdict', select('issue-verdict', [['all', 'All'], ['real', 'Real'], ['false-positive', 'False positive'], ['unproven', 'Unproven']], 'all', (event) => { filters.verdict = event.target.value; update() })),
      field('Scope', select('issue-scope', [['all', 'All'], ['in-scope', 'In scope'], ['out-of-scope', 'Out of scope']], 'all', (event) => { filters.scope = event.target.value; update() })),
    )
    controls.append(
      field('Title', el('input', { id: 'issue-search', type: 'search', placeholder: 'Issue title…', oninput: (event) => { filters.text = event.target.value; update() } })),
      field('File', el('input', { id: 'issue-file', type: 'search', placeholder: 'Path…', oninput: (event) => { filters.file = event.target.value; update() } })),
      field('Reason', el('input', { id: 'issue-reason', type: 'search', placeholder: 'Verdict or scope reason…', oninput: (event) => { filters.reason = event.target.value; update() } })),
    )
    update()
    return el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Judged issues'), el('p', {}, `${run.issues.length} stable target-level issues attributed to this run.`)), controls), el('div', { class: 'panel-body' }, list))
  }

  function claimSection(run) {
    const list = el('div', { class: 'issue-list' })
    const filters = { severity: 'all', text: '' }
    const update = () => {
      const q = filters.text.toLowerCase()
      const visible = run.claims.filter((claim) => (filters.severity === 'all' || claim.severity === filters.severity) && (!q || `${claim.title} ${claim.file || ''} ${claim.claim || ''}`.toLowerCase().includes(q)))
      list.replaceChildren(...(visible.length ? visible.map((claim) => el('article', { class: 'issue' },
        el('div', { class: 'issue-head' }, el('div', {}, el('h3', {}, claim.title), el('div', { class: 'where' }, `${claim.file || 'No file'}${claim.line ? ':' + claim.line : ''}`))),
        el('div', { class: 'badges' }, badge(claim.severity || 'unspecified'), badge(claim.kind || 'finding'), claim.selfRejected ? badge('self-rejected', 'unproven') : null),
        el('p', {}, claim.claim || ''),
      )) : [el('div', { class: 'empty' }, 'No extracted claims match these filters.')]))
    }
    const claimSeverities = [...new Set(run.claims.map((claim) => claim.severity).filter(Boolean))].sort()
    const severity = select('claim-severity', [['all', 'All severities'], ...claimSeverities.map((value) => [value, value])], 'all', (event) => { filters.severity = event.target.value; update() })
    const search = el('input', { id: 'claim-search', type: 'search', placeholder: 'File, title, or claim…', oninput: (event) => { filters.text = event.target.value; update() } })
    update()
    return el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Extracted claims'), el('p', {}, `${run.claims.length} claims before merging and verification.`)), el('div', { class: 'compact-controls' }, field('Severity', severity), field('Search', search))), run.extractError ? el('div', { class: 'notice' }, `Extraction error: ${run.extractError}`) : null, el('div', { class: 'panel-body' }, list))
  }

  function searchableRaw(title, text, open = false, note = null) {
    const source = String(text || '')
    const output = el('pre', {}, source || 'Unavailable')
    const input = el('input', { type: 'search', placeholder: 'Filter matching lines…', 'aria-label': `Search ${title}`, oninput: (event) => {
      const q = event.target.value.toLowerCase()
      output.textContent = q ? source.split('\n').filter((line) => line.toLowerCase().includes(q)).join('\n') || 'No matching lines.' : source || 'Unavailable'
    } })
    return el('details', { class: 'raw', open: open ? '' : null }, el('summary', {}, title, note ? ` · ${note}` : ''), el('div', { class: 'raw-tools' }, input), output)
  }

  function rawSection(run) {
    return el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Raw artifacts'), el('p', {}, 'Plain text only. Searches filter to matching lines.'))),
      searchableRaw('Report', run.report, true),
      searchableRaw('Prompt', run.prompt, false, run.promptSource),
      searchableRaw('Standard error', run.stderr),
      searchableRaw('Metadata', JSON.stringify(run.metadata, null, 2)),
    )
  }

  function upstreamSection(target) {
    const truth = target.groundtruth
    if (!truth) return null
    const author = String(truth.author || '').toLowerCase()
    const human = (comment) => !/\[bot\]$/.test(comment.user || '') && String(comment.user || '').toLowerCase() !== author
    const comments = [
      ...((truth.review && truth.review.inline) || []).filter(human).map((comment) => ({ ...comment, type: 'inline' })),
      ...((truth.review && truth.review.issue) || []).filter(human).map((comment) => ({ ...comment, type: 'thread' })),
    ]
    return el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Upstream human review'), el('p', {}, 'Context only—not ground truth and never included in run scoring.')), externalLink('Open upstream PR ↗', truth.url)),
      el('div', { class: 'panel-body' },
        el('div', { class: 'notice info' }, 'The benchmark used the merged revision, after upstream review changes. Absence of one of these comments is not a miss.'),
        comments.length ? comments.map((comment) => el('article', { class: 'upstream-comment' }, el('strong', {}, comment.user), el('span', { class: 'subline' }, comment.type === 'inline' ? `${comment.path || 'file'}${comment.line ? ':' + comment.line : ''}` : 'PR thread'), el('p', {}, comment.body || ''))) : el('div', { class: 'empty' }, 'No human review comments stored.'),
      ),
    )
  }

  const comparisonMetrics = [
    ['Cost', (run) => run.usage.costUsd, 'money', 'lower'],
    ['Wall time', (run) => run.wallMs, 'minutes', 'lower'],
    ['Tokens', (run) => run.usage.total, 'number', 'lower'],
    ['Extracted claims', (run) => run.metrics.claims, 'number', 'neutral'],
    ['Real findings', (run) => run.metrics.real, 'number', 'higher'],
    ['False positives', (run) => run.metrics.falsePositive, 'number', 'lower'],
    ['Unproven', (run) => run.metrics.unproven, 'number', 'neutral'],
    ['In-scope real', (run) => run.metrics.inScope, 'number', 'higher'],
    ['PR-introduced real', (run) => run.metrics.prIntroduced, 'number', 'higher'],
    ['Unique real', (run) => run.metrics.uniqueReal, 'number', 'higher'],
    ['Precision', (run) => run.metrics.precision, 'percent', 'higher'],
    ['Real / dollar', (run) => run.metrics.realPerDollar, 'number', 'higher'],
    ['Cost / real', (run) => run.metrics.costPerReal, 'money', 'lower'],
    ['Minutes / real', (run) => run.metrics.minutesPerReal, 'number', 'lower'],
  ]

  function renderComparison(leftId, rightId) {
    const left = runs.get(leftId), right = runs.get(rightId)
    if (!left || !right) return renderNotFound('Comparison not found', `${leftId} ↔ ${rightId}`)
    const overlap = comparisonData(left, right)
    const content = el('div', {},
      hero('Two-run comparison', `${left.toolLabel} vs ${right.toolLabel}`, `${left.targetId} ↔ ${right.targetId}`, [hashLink('Overview', '#overview'), ' / ', 'Comparison']),
      el('section', { class: 'panel' },
        el('div', { class: 'panel-body compare-head' }, compareRun(left), el('div', { class: 'versus' }, 'VERSUS'), compareRun(right)),
      ),
      comparisonTable(left, right),
      comparisonCharts(left, right),
      overlapSection(overlap),
    )
    frame(content)
  }

  function compareRun(run) {
    return el('div', { class: 'compare-run' }, hashLink(run.toolLabel, runHash(run), 'run-link'), el('span', { class: 'subline' }, run.id), el('div', { class: 'badges' }, badge(run.status, run.status), badge(run.usage.source, 'source')))
  }

  function comparisonTable(left, right) {
    const body = el('tbody')
    for (const [label, getter, kind, direction] of comparisonMetrics) {
      const a = getter(left), b = getter(right)
      const delta = a == null || b == null ? null : b - a
      const ratio = a > 0 && b != null ? b / a : null
      let quality = ''
      if (delta && direction !== 'neutral') quality = (direction === 'higher' ? delta > 0 : delta < 0) ? 'good' : 'bad'
      const deltaText = delta == null ? 'N/A' : `${delta > 0 ? '+' : ''}${kind === 'money' ? fmt(delta, 'money') : kind === 'percent' ? (delta * 100).toFixed(1) + ' pp' : kind === 'minutes' ? fmt(delta, 'minutes') : fmt(delta)}`
      body.append(el('tr', {}, el('td', {}, label), el('td', { class: 'num' }, fmt(a, kind)), el('td', { class: 'num' }, fmt(b, kind)), el('td', { class: `num delta ${quality}` }, deltaText), el('td', { class: 'num' }, fmt(ratio, 'ratio'))))
    }
    return el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Metric deltas'), el('p', {}, 'Delta and ratio are right relative to left.'))), el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Metric'), el('th', { class: 'num' }, 'Left'), el('th', { class: 'num' }, 'Right'), el('th', { class: 'num' }, 'Δ'), el('th', { class: 'num' }, 'Ratio'))), body)))
  }

  function comparisonCharts(left, right) {
    const tokenFields = [['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache read'], ['cacheCreation', 'Cache create'], ['thinking', 'Thinking']]
    const maxToken = Math.max(0, ...tokenFields.flatMap(([key]) => [left.usage[key] || 0, right.usage[key] || 0]))
    const tokensFor = (run) => el('div', {},
      el('h3', {}, run.toolLabel),
      tokenFields.map(([key, label]) => el('div', { class: 'token-row' },
        el('span', {}, label),
        el('div', { class: 'track' }, el('span', { style: `width:${maxToken ? (run.usage[key] || 0) / maxToken * 100 : 0}%` })),
        el('strong', {}, fmt(run.usage[key], 'compact')),
      )),
    )
    const barMetrics = [['Real', (run) => run.metrics.real], ['In scope', (run) => run.metrics.inScope], ['Precision', (run) => run.metrics.precision], ['Real / $', (run) => run.metrics.realPerDollar]]
    return el('section', { class: 'charts' },
      el('div', { class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', {}, 'Token mix')), el('div', { class: 'panel-body token-bars' }, tokensFor(left), tokensFor(right))),
      el('div', { class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', {}, 'Quality & efficiency')), el('div', { class: 'panel-body metric-bars' }, barMetrics.map(([label, getter]) => {
        const a = getter(left), b = getter(right), max = Math.max(a || 0, b || 0)
        return el('div', { class: 'metric-bar' }, el('span', { class: 'muted' }, label), el('div', { class: 'paired-track' }, el('div', { class: 'track', title: `Left: ${fmt(a)}` }, el('span', { style: `width:${max ? (a || 0) / max * 100 : 0}%` })), el('div', { class: 'track', title: `Right: ${fmt(b)}` }, el('span', { style: `width:${max ? (b || 0) / max * 100 : 0}%` }))))
      }))),
    )
  }

  function comparisonData(left, right) {
    if (left.targetId !== right.targetId) return { compatible: false, reason: 'Issue overlap is unavailable because these runs reviewed different targets.', shared: [], leftOnly: [], rightOnly: [] }
    const leftMap = new Map(left.issues.map((issue) => [issue.id, issue]))
    const rightMap = new Map(right.issues.map((issue) => [issue.id, issue]))
    return {
      compatible: true,
      shared: [...leftMap.keys()].filter((id) => rightMap.has(id)).map((id) => leftMap.get(id)),
      leftOnly: [...leftMap.keys()].filter((id) => !rightMap.has(id)).map((id) => leftMap.get(id)),
      rightOnly: [...rightMap.keys()].filter((id) => !leftMap.has(id)).map((id) => rightMap.get(id)),
    }
  }

  function overlapSection(overlap) {
    if (!overlap.compatible) return el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', {}, 'Judged issue overlap')), el('div', { class: 'panel-body' }, el('div', { class: 'notice' }, overlap.reason)))
    const column = (title, issues) => el('div', { class: 'overlap-column' },
      el('h3', {}, `${title} · ${issues.length}`),
      el('div', { class: 'issue-list' }, ...(issues.length ? issues.map((issue) => issueCard(issue, false)) : [el('div', { class: 'empty' }, 'None')])),
    )
    return el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, 'Judged issue overlap'), el('p', {}, 'Matched by stable judgement ID within the same target.'))), el('div', { class: 'panel-body overlap-grid' }, column('Shared', overlap.shared), column('Left only', overlap.leftOnly), column('Right only', overlap.rightOnly)))
  }

  function renderNotFound(title, detail) {
    frame(el('div', {}, hero('Unknown route', title, detail, [hashLink('Return to overview', '#overview')]), el('div', { class: 'notice' }, 'The requested dashboard record is not embedded in this export.')))
  }

  window.addEventListener('hashchange', route)
  route()
})()
