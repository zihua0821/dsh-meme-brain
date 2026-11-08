// 插件入口：apply() 能装上东西，并且在空库上把角色表种子种进去
//
// 这条测的是「新装的人会不会拿到空表」——单元测试只测 seedIfMissing，
// 这里测它真的在 apply() 里被调用。
//
// 三条测试的顺序有意义：第一条 apply 播种 → 第二条读结果 → 第三条确认不重播。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-apply-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const entry = await import(pathToFileURL(join(import.meta.dirname, '..', '..', 'src', 'index.js')).href)

after(() => rmSync(tmpRoot, { recursive: true, force: true }))

/** 假 ctx：只实现 apply() 真正用到的那几个口子，并记下注册了什么 */
function makeCtx(logs) {
  const state = { commands: [], routes: [] }
  const ctx = {
    logger: () => ({
      info: (msg) => logs.push(['info', String(msg)]),
      warn: (msg) => logs.push(['warn', String(msg)]),
      error: (msg) => logs.push(['error', String(msg)]),
      debug: () => {},
    }),
    effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
    commands: { register: (def) => { state.commands.push(def.name); return () => {} } },
    tools: { register: () => () => {} },
    webServer: {
      register: (route) => { state.routes.push(route.path); return () => {} },
      getOrigin: () => 'http://127.0.0.1:1',
    },
  }
  return { ctx, state }
}

test('apply()：注册 /meme 命令和 HTTP 路由', () => {
  const logs = []
  const { ctx, state } = makeCtx(logs)
  entry.apply(ctx)

  assert.deepEqual(state.commands, ['meme'])
  assert.ok(state.routes.some((p) => p.includes('meme-brain')), '应该注册 /meme-brain/api')
})

test('apply()：空库上种入 38 条角色表', () => {
  const raw = JSON.parse(readFileSync(join(tmpRoot, 'characters.json'), 'utf8'))
  assert.ok(Object.keys(raw.items).length >= 30)
})

test('apply()：再调一次不重复种（已有角色表不动）', () => {
  const logs = []
  const { ctx } = makeCtx(logs)
  entry.apply(ctx)
  assert.ok(!logs.some(([, msg]) => msg.includes('角色表已初始化')), '第二次不该再种')
})
