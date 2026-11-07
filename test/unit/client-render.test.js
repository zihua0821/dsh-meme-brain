// 界面渲染冒烟测试（无浏览器）：用极简 React 替身把组件树求值一遍。
//
// 目的：证明「详情里能看到分析结果」不是肉眼运气，而是组件真的渲染出了那些内容。
// 边界：这不是浏览器验证——样式、布局、真实 DOM 行为都不在覆盖范围内。
// 但它能挡住最常见的一类事故：字段改名 / 字段缺失导致的整块面板白屏。

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------- 迷你 React

let counters = new Map()
let hookIndex = new Map()
let hookStore = new Map()
let memoStore = new Map()
let queue = []
let dirty = false
let currentName = 'root'

const createElement = (type, props, ...children) => {
  const p = { ...(props || {}) }
  if (children.length) p.children = children.length === 1 ? children[0] : children
  return { type, props: p }
}

const nextHookKey = (kind) => {
  const nth = hookIndex.get(currentName) || 0
  hookIndex.set(currentName, nth + 1)
  return `${kind}:${currentName}#${nth}`
}

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

const useState = (init) => {
  const key = nextHookKey('state')
  if (!hookStore.has(key)) hookStore.set(key, { value: typeof init === 'function' ? init() : init })
  const cell = hookStore.get(key)
  if (!cell.set) {
    cell.set = (next) => {
      const value = typeof next === 'function' ? next(cell.value) : next
      if (!Object.is(value, cell.value)) {
        cell.value = value
        dirty = true
      }
    }
  }
  return [cell.value, cell.set]
}

// 依赖数组必须被尊重：否则详情每次重渲染都会重新拉数据，
// 把用户刚输入还没保存的内容刷回去——真实 React 不会这样。
const useEffect = (fn, deps) => {
  const key = nextHookKey('effect')
  const prev = memoStore.get(key)
  const changed = !prev || !deps || !sameDeps(prev.deps, deps)
  memoStore.set(key, { deps })
  if (changed) queue.push(fn)
}

// useCallback 同样按依赖保持函数身份稳定，避免下游 effect 被无限触发
const useCallback = (fn, deps) => {
  const key = nextHookKey('callback')
  const prev = memoStore.get(key)
  if (prev && deps && sameDeps(prev.deps, deps)) return prev.fn
  memoStore.set(key, { deps, fn })
  return fn
}

function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderNode)
  const { type, props } = node
  if (typeof type === 'function') {
    const name = type.name || 'anon'
    const i = counters.get(name) || 0
    counters.set(name, i + 1)
    const prev = currentName
    currentName = name
    // 组件内部再次使用 hook 时用「名字#序号」区分
    const out = (() => {
      const saved = currentName
      currentName = `${name}#${i}`
      try {
        return type(props)
      } finally {
        currentName = saved
      }
    })()
    currentName = prev
    return renderNode(out)
  }
  return { type, props: { ...props, children: renderNode(props.children) } }
}

function paint(element) {
  counters = new Map()
  hookIndex = new Map()
  queue = []
  const tree = renderNode(element)
  return { tree, effects: queue }
}

/** 反复渲染直到 state 稳定（模拟 React 的 effect → setState → 重渲染） */
async function settle(build) {
  let tree = null
  for (let i = 0; i < 10; i++) {
    dirty = false
    const pass = paint(build())
    tree = pass.tree
    for (const fn of pass.effects) fn()
    await new Promise((r) => setImmediate(r))
    if (!dirty) return tree
  }
  return tree
}

const resetHooks = () => {
  hookStore = new Map()
  memoStore = new Map()
  counters = new Map()
  hookIndex = new Map()
  queue = []
}

/** 把渲染树里的文字收集起来 */
function textOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { node.forEach((n) => textOf(n, out)); return out }
  textOf(node.props?.children, out)
  return out
}

/** 深度查找满足条件的元素 */
function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, pred, out)); return out }
  if (pred(node)) out.push(node)
  findAll(node.props?.children, pred, out)
  return out
}

/** 图格：可点击且内部有 <img> 的按钮（工具栏的「搜索」按钮也是 button，不能抓错） */
function gridButton(tree) {
  return findAll(tree, (n) => n.props?.type === 'button' && findAll(n, (x) => x.type === 'img').length > 0)[0]
}

// ------------------------------------------------------------- 被测组件装载

let Page = null
let currentItem = null
let listCalls = 0

function jsonResponse(data) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, data }) })
}

/** 记录每次请求，供断言「界面到底发了什么」 */
const requests = []
let annotateResult = null

const FACETS = {
  total: 1,
  characters: [{ name: '大肥鱼', count: 1 }],
  unknownCharacter: 0,
  todo: { unanalyzed: 0, unnamed: 0, notags: 1, nochar: 0 },
  pinned: 0,
}

// 列表响应要稳定（同一份对象）：否则每次渲染都产生「新数组」，
// 替身的 setState 会一直判定为变化，测试就停在重渲染里出不来了。
let cachedList = null
let cachedFor = null
function listData() {
  if (cachedFor === currentItem && cachedList) return cachedList
  cachedFor = currentItem
  cachedList = {
    total: 1,
    indexed: true,
    items: [{
      md5: currentItem.md5,
      name: currentItem.name,
      tags: currentItem.tags,
      url: currentItem.url,
      width: currentItem.width,
      height: currentItem.height,
      frames: currentItem.frames,
      ext: currentItem.ext,
      bytes: currentItem.bytes,
      state: currentItem.state,
      character: currentItem.character,
      analyzed: currentItem.analyzed,
    }],
  }
  return cachedList
}

globalThis.fetch = (url, init) => {
  const u = String(url)
  requests.push({ url: u, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })

  if (u.includes('op=annotate')) return jsonResponse(annotateResult || currentItem)
  if (u.includes('op=facets')) return jsonResponse(FACETS)
  if (u.includes('op=item')) return jsonResponse(currentItem)

  listCalls += 1
  return jsonResponse(listData())
}

const fullItem = {
  md5: 'a'.repeat(32),
  name: '大肥鱼生气',
  tags: '生气,瞪眼',
  state: 'stored',
  bytes: 204800,
  width: 640,
  height: 640,
  frames: 4,
  ext: 'gif',
  character: '大肥鱼',
  charConf: '高',
  appearance: '蓝色长发、鲸鱼尾、深蓝女仆裙、蓝蝴蝶结',
  text: '滚',
  target: '对方',
  scene: '社交,日常',
  score: { valence: -0.6, arousal: 0.8, aggression: 0.5, intimacy: 0.3, absurdity: 0.2 },
  analyzed: true,
  analyzedAt: 1794043000000,
  model: 'deepseek-flash',
  dhash: '0f0f0f0f0f0f0f0f',
  hasAlpha: true,
  pinned: false,
  source: 'import',
  path: `aa/aa/${'a'.repeat(32)}.gif`,
  dupOf: '',
  dupDistance: null,
  createdAt: 1794042000000,
  url: `/meme-brain/api?op=image&md5=${'a'.repeat(32)}`,
}

test('装载 client.js：注册了侧栏图标与主面板', async () => {
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  const mod = await import('../../client.js')
  assert.ok(mod, '模块可导入')
  assert.ok(loaded, '调用了 __ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-meme-brain')

  const React = { createElement, useState, useEffect, useCallback }
  const client = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`意外依赖：${name}`)
  })

  const registered = {}
  const ctx = {
    slots: {
      inject: (_name, fn) => fn(),
      register: (spec, comp) => {
        registered[`${spec.name}:${spec.id || spec.key}`] = comp
        return () => {}
      },
    },
  }
  client.apply(ctx)

  assert.ok(registered['sidebar.panellist:memebrain'], '侧栏图标已注册')
  assert.ok(registered['main:memebrain'], '主面板已注册')
  Page = registered['main:memebrain']
})

test('详情：能看到角色、外观、场景、指向、评分与被分析元信息', async () => {
  resetHooks()
  currentItem = fullItem

  // 1) 首屏（列表）
  let tree = await settle(() => createElement(Page, {}))
  assert.ok(textOf(tree).join('').includes('大肥鱼生气'), '列表里出现名字')

  // 2) 点第一张图 → 打开详情
  const cell = gridButton(tree)
  assert.ok(cell, '找到可点击的图格')
  cell.props.onClick()

  // 3) 重渲染：详情拉数据、再渲染
  tree = await settle(() => createElement(Page, {}))
  const text = textOf(tree).join('')

  assert.ok(listCalls >= 1, '列表接口被调用')
  assert.ok(text.includes('分析结果'), '有「分析结果」分区')
  assert.ok(text.includes('大肥鱼'), '显示角色名')
  assert.ok(text.includes('把握 高'), '显示角色把握度')
  assert.ok(text.includes('蓝色长发'), '显示外观描述')
  assert.ok(text.includes('社交') && text.includes('日常'), '场景拆成两个标签')
  assert.ok(text.includes('对方'), '显示指向')
  assert.ok(text.includes('滚'), '显示图上文字')

  assert.ok(text.includes('评分'), '有「评分」分区')
  for (const label of ['情绪', '强度', '攻击', '亲密', '抽象']) {
    assert.ok(text.includes(label), `评分维度包含 ${label}`)
  }
  assert.ok(text.includes('-0.60'), '负分带符号且两位小数')
  assert.ok(text.includes('0.80'), '正分两位小数')

  assert.ok(text.includes('文件与来源'), '有「文件与来源」分区')
  assert.ok(text.includes('deepseek-flash'), '显示分析模型')
  assert.ok(text.includes('人工锁定') === false, '未锁定时不显示锁定字样')
  assert.ok(text.includes('带透明'), '带 alpha 时标注')
})

test('详情：未分析的条目给出可执行的下一步，而不是空白', async () => {
  resetHooks()
  currentItem = {
    ...fullItem,
    character: '', charConf: '', appearance: '', text: '', target: '', scene: '',
    score: null, analyzed: false, analyzedAt: null, model: '',
  }

  let tree = await settle(() => createElement(Page, {}))
  const cell = gridButton(tree)
  cell.props.onClick()
  tree = await settle(() => createElement(Page, {}))

  const text = textOf(tree).join('')
  assert.ok(text.includes('还没分析过'), '提示未分析')
  assert.ok(text.includes('/meme analyze --md5='), '给出可直接复制的命令')
  assert.ok(!text.includes('评分'), '没有分数时不渲染评分分区')
})

/** 筛选按钮 = 文字 + 末尾张数，例如「未知角色0」 */
function filterChip(tree, label) {
  return findAll(tree, (n) => {
    if (n.props?.type !== 'button') return false
    return new RegExp(`^${label}\\d+$`).test(textOf(n).join(''))
  })[0]
}

async function openDetail(item) {
  currentItem = item
  let tree = await settle(() => createElement(Page, {}))
  const cell = gridButton(tree)
  assert.ok(cell, '找到图格')
  cell.props.onClick()
  return settle(() => createElement(Page, {}))
}

test('筛选条：待办与角色各自带张数，点击后把筛选参数带给 Host', async () => {
  resetHooks()
  requests.length = 0

  let tree = await openDetail(fullItem)

  for (const label of ['全部', '未分析', '未命名', '无标签', '未知角色', '大肥鱼']) {
    assert.ok(filterChip(tree, label), `筛选条应有「${label}」`)
  }
  assert.equal(textOf(filterChip(tree, '未知角色')).join(''), '未知角色0', '待办项的计数来自 facets')
  assert.equal(textOf(filterChip(tree, '无标签')).join(''), '无标签1')

  // 点「未知角色」→ 列表请求带上 todo=nochar
  requests.length = 0
  filterChip(tree, '未知角色').props.onClick()
  tree = await settle(() => createElement(Page, {}))
  const listReq = requests.filter((r) => r.url.includes('op=list')).pop()
  assert.ok(listReq, '触发了列表请求')
  assert.ok(listReq.url.includes('todo=nochar'), `待办筛选应传给 Host，实际：${listReq.url}`)

  // 点角色「大肥鱼」→ 带上 character，且清掉上一步的 todo
  requests.length = 0
  filterChip(tree, '大肥鱼').props.onClick()
  tree = await settle(() => createElement(Page, {}))
  const listReq2 = requests.filter((r) => r.url.includes('op=list')).pop()
  const decoded = decodeURIComponent(listReq2.url)
  assert.ok(decoded.includes('character=大肥鱼'), `角色筛选应传给 Host，实际：${decoded}`)
  assert.ok(!decoded.includes('todo='), '切到角色筛选时要清掉待办筛选')
})

test('改角色：提交 character，新建角色时明确告知', async () => {
  resetHooks()
  annotateResult = { ...fullItem, character: '耄耋', charConf: '人工', pinned: true, createdCharacter: true, cleared: false }

  let tree = await openDetail({ ...fullItem, character: '', charConf: '', pinned: false })

  const input = findAll(tree, (n) => n.type === 'input' && n.props.list === 'memebrain-chars')[0]
  assert.ok(input, '详情里有角色输入框')
  input.props.onChange({ target: { value: '耄耋' } })
  tree = await settle(() => createElement(Page, {}))

  requests.length = 0
  const saveBtn = findAll(tree, (n) => n.props?.type === 'button' && textOf(n).join('') === '保存')[0]
  assert.ok(saveBtn, '找到保存按钮')
  saveBtn.props.onClick()
  await new Promise((r) => setImmediate(r))
  tree = await settle(() => createElement(Page, {}))

  const postReq = requests.find((r) => r.method === 'POST')
  assert.ok(postReq, '发出了 POST')
  assert.equal(postReq.body.character, '耄耋', '提交了角色')
  assert.ok(textOf(tree).join('').includes('角色表新增了「耄耋」'), '新建角色要告知')

  // 上锁后出现解锁入口
  assert.ok(textOf(tree).join('').includes('解除锁定'), '锁定的条目能解锁')
})

test('只改名字时不会提交 character（避免顺手把模型判断锁死）', async () => {
  resetHooks()
  annotateResult = { ...fullItem, name: '新名字' }

  let tree = await openDetail(fullItem)

  const nameInput = findAll(tree, (n) => n.type === 'input' && n.props.placeholder === '给她看的短名')[0]
  assert.ok(nameInput, '有名字输入框')
  nameInput.props.onChange({ target: { value: '新名字' } })
  tree = await settle(() => createElement(Page, {}))

  requests.length = 0
  findAll(tree, (n) => n.props?.type === 'button' && textOf(n).join('') === '保存')[0].props.onClick()
  await new Promise((r) => setImmediate(r))

  const postReq = requests.find((r) => r.method === 'POST')
  assert.equal(postReq.body.name, '新名字')
  assert.ok(!('character' in postReq.body), '没改角色就不该提交 character')
})
