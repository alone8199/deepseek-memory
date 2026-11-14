# DeepSeek 长期记忆 (deepseek-memory)

让 [DeepSeek](https://chat.deepseek.com) 记住你是谁的 Tampermonkey 用户脚本：跨对话长期记忆，无感注入、自动更新、面板可视化编辑。

## 功能

- **无痕注入**：每次提问前自动把长期记忆注入上下文，页面零改动，AI 像老朋友一样自然使用（不会说“根据我的记忆”）
- **自动更新**：AI 在回复末尾输出隐藏的记忆更新块，脚本自动捕获合并——你不用说“请记住”，它自己判断该记什么
- **三类记忆**：
  - 整体记忆：关系与相处方式的感性总结
  - AI 人格：AI 自己维护的人设，独立卡片
  - 条目记忆：键值对列表（名字、宠物、爱好……），信息类事实全在这里
- **防重复**：键名对齐、含义去重，不会越聊越乱
- **原生面板**：设置入口嵌在 DeepSeek 原生「系统设置」弹窗里，新增「长期记忆」页签，浅色/深色主题自适应
- **导入/导出**：记忆为 JSON，可备份可迁移

## 安装

1. 先装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点下面任一链接安装：

- 直连安装：https://raw.githubusercontent.com/alone8199/deepseek-memory/main/deepseek-memory.user.js
- 国内代理安装（gh-proxy 加速）：https://gh-proxy.com/https://raw.githubusercontent.com/alone8199/deepseek-memory/main/deepseek-memory.user.js

## 使用

- 安装后打开 DeepSeek，侧栏头像旁菜单 →「系统设置」→ 左侧「长期记忆」页签
- 面板里可开关注入、手改整体记忆 / AI 人格 / 条目、导入导出
- 之后正常聊天即可：告诉它的事（名字、喜好、宠物……）会自动进条目，想换 AI 人格直接说（如“以后用傲娇的语气说话”），它会自己更新人格卡

## 开源协议

[MIT](./LICENSE)
