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
let queue = []
let dirty = false
let currentName = 'root'

const createElement = (type, props, ...children) => {
  const p = { ...(props || {}) }
  if (children.length) p.children = children.length === 1 ? children[0] : children
  return { type, props: p }
}

const useState = (init) => {
  const nth = hookIndex.get(currentName) || 0
  hookIndex.set(currentName, nth + 1)
  const key = `${currentName}#${nth}`
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

const useEffect = (fn) => { queue.push(fn) }
const useCallback = (fn) => fn

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

globalThis.fetch = (url) => {
  const u = String(url)
  if (u.includes('op=item')) return jsonResponse(currentItem)
  listCalls += 1
  return jsonResponse({
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
  })
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
