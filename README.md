# 阅读模式朗读 Edge 扩展

一个 Microsoft Edge / Chromium Manifest V3 扩展，用于把网页正文转换为阅读模式，并使用浏览器 Web Speech API 朗读。支持点击正文切换朗读起点、预加载下一页、本页结束后自动续读下一页。
测试推送
> 说明：Edge 内置“朗读此页 / Read Aloud”没有公开扩展 API。本扩展使用 `speechSynthesis` 调用浏览器/系统可用语音，而不是控制 Edge 私有朗读 UI。

## 功能

- 工具栏按钮一键打开阅读模式。
- 使用 Readability 提取网页正文。
- Shadow DOM 覆盖层，减少网页样式干扰。
- 段落/句子级点击起读。
- 开始、暂停/继续、停止、关闭。
- 语音、语速、字号、主题设置。
- 检测 `rel=next`、下一页/下一章/Next 等链接。
- 后台预加载下一页 HTML，本页读完后在阅读模式内切换并继续朗读。

## 开发

```bash
bun install
bun run typecheck
bun run test
bun run build
```

构建产物在 `dist/`。

## 在 Edge 中加载

1. 打开 `edge://extensions`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本仓库的 `dist/` 目录。
5. 打开普通文章网页，点击扩展图标。

## 已知限制

- 不调用 Edge 私有 Read Aloud UI，使用 Web Speech API。
- 首版点击起读为段落/句子级，不保证精确到字/词。
- 需要复杂客户端渲染、登录态或反爬的网站可能无法被预加载。
- 浏览器内部页面、Edge Add-ons 页面、PDF 等页面可能禁止内容脚本注入。
