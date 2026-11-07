// dsh-meme-brain · Host 入口
//
// 约束（docs/03-engineering-contract.md）：
//   - 业务逻辑不写在这里，只做注册与分发；
//   - 命令是第一入口，界面（M4）只能调用同一批端点；
//   - 任何子命令都要能在没有 Web 界面的情况下完成。

import { run } from './commands.js'
import { registerApi } from './lib/http.js'

export const name = 'meme-brain'
export const inject = ['commands', 'webServer', 'llm', 'attachments', 'agentDefaultModel']

export function apply(ctx) {
  const log = ctx.logger?.('meme-brain') ?? console

  const dispose = ctx.commands.register({
    name: 'meme',
    description: '表情包管理：体检、导入、检索、分析、修复',
    input: { hint: '<子命令> [参数]' },
    handler: async ({ rawInput }) => run(rawInput, ctx),
  })
  ctx.effect(() => dispose)

  try {
    registerApi(ctx)
  } catch (error) {
    log.warn?.('HTTP 路由注册失败（界面将不可用，命令不受影响）：', error.message)
  }

  log.info?.('meme-brain 已加载（M4：命令 + 界面 + HTTP）')
}
