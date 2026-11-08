# 第三方素材说明

本仓库的**代码和文档**以根目录 [LICENSE](LICENSE) 的 MIT 许可发布。

以下内容**不在** MIT 许可覆盖范围内：

## test/fixtures/

5 张测试图片（`dup-a.jpg`、`dup-b.jpg`、`control.png`、`control.webp`、`anim.gif`）取自
网络表情包文化中的样本，版权归各自作者所有，只用于验证解码、判重和动图采样。

如果版权方有异议，删掉并换成本机任意图片即可——回归断言只依赖
`test/fixtures/README.md` 里列出的属性（尺寸、帧数、透明通道、dHash 距离），不依赖具体画面。

## 角色表里的名字

`characters.seed.json` 里的角色/梗名称（大肥鱼、doro、龙图、吉伊……）是网络流行文化中的名称，
不主张任何商标或版权。`look` 字段是本项目自己写的描述文本。
