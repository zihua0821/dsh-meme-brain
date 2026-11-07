// 路径展开的单元测试
import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expandPath } from '../../src/commands.js'

test('展开 ~ 与 ~/x', () => {
  assert.equal(expandPath('~'), homedir())
  assert.equal(expandPath('~/a/b'), join(homedir(), 'a/b'))
})

test('展开 %NAME%', () => {
  process.env.MEME_TEST_VAR = 'C:\\tmp\\x'
  assert.equal(expandPath('%MEME_TEST_VAR%\\sub'), 'C:\\tmp\\x\\sub')
})

test('展开 $env:NAME 与 ${env:NAME}', () => {
  process.env.MEME_TEST_VAR = 'D:\\y'
  assert.equal(expandPath('$env:MEME_TEST_VAR'), 'D:\\y')
  assert.equal(expandPath('${env:MEME_TEST_VAR}\\z'), 'D:\\y\\z')
})

test('去掉包裹的引号', () => {
  process.env.MEME_TEST_VAR = 'E:\\q'
  assert.equal(expandPath('"E:\\q"'), 'E:\\q')
})

test('未定义的环境变量直接报错，不静默拼错路径', () => {
  assert.throws(() => expandPath('%NOT_DEFINED_XYZ%\\a'), /未定义/)
})

test('普通绝对路径原样返回', () => {
  assert.equal(expandPath('C:\\data\\stickers'), 'C:\\data\\stickers')
})
