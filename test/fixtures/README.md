# 测试夹具

来源：从本机 Aurabot 表情库中挑选的真实样本，仅用于测试，不随包发布（`package.json` 的 `files` 不含 `test/`）。

| 文件 | 内容 | 用途 |
|---|---|---|
| `dup-a.jpg` | 「摆烂摊手的厚脸皮」240×177，6827B | 已知重复对 A |
| `dup-b.jpg` | 「摆烂式厚脸皮」240×177，6903B | 已知重复对 B（与 A md5 不同、肉眼相同） |
| `control.png` | 「气到掀桌的小人」 | 无关对照 |
| `control.webp` | 由 control.png 转换 | 验证 WebP 解码路径 |
| `anim.gif` | 「奶娃拳击」15 帧、带透明通道 | 验证多帧采样与透明合成 |

## 基线（回归断言依据）

```
dHash(dup-a) == dHash(dup-b)                     距离 0/0
dup-a vs control                                 距离 ≥ 11（不判重）
anim.gif 帧数                                    15
anim.gif hasAlpha                                true
```

若这些断言开始失败，说明解析或哈希逻辑发生了非预期变化——先查这里，再查代码。
