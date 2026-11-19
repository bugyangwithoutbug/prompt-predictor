# Prompt Predictor

[English](README.md) | [简体中文](README.zh-CN.md)

一个运行在 Antigravity 右侧辅助栏（Auxiliary Pane）的本地 UI 插件。每当 AI 完成一轮回复后，它会根据当前对话上下文自动预测 1~3 条最可能继续发送的提示词（参考 Codex 的 Composer Predictions），支持**灰色幽灵字 + `Tab` 采纳**、**微调后回车直发**以及**一键发送**。

## 核心功能

- **自动感知轮次结束**：实时监听当前会话的 `transcript.jsonl`，在 AI 回复完成后自动触发预测（同一轮结果自动缓存，不重复请求）。
- **首位最推荐差异化展示**：第 1 条建议固定标记 **`★ 最推荐`**，并在卡片左侧加亮提示；第 2、3 条提供有区分度的备选思路。
- **底部 Quick Composer 灰字补全**：
  - `Tab`：输入框为空时，将当前灰色幽灵预测文本采纳进输入框。
  - `↑` / `↓`：输入框为空时，在多条预测建议之间切换预览。
  - `Enter`：直接发送到当前 Antigravity 会话。
  - `Shift+Enter`：换行（已做中文输入法 `isComposing` 避让，不会误触）。
- **卡片快捷操作**：点击卡片正文可载入底部输入框编辑；也可直接点击 **发送** 或 **复制**。
- **多模型提供商兼容**：
  - 支持所有 **OpenAI 兼容接口**（内置 OpenAI、DeepSeek、火山方舟/豆包、Ollama 本地预设，支持自定义 Base URL）。
  - 支持 **Google Gemini** REST API（`generateContent`，使用 `x-goog-api-key` 请求头鉴权）。
  - 自动适配 `gpt-5+` / `o*` 推理模型参数（`max_completion_tokens`、`reasoning_effort: "low"`）与 HTTP 400 参数降级重试、瞬断网络重试。

## 安装方式

将本仓库克隆到 Antigravity 全局插件目录即可（零外部 npm 依赖，使用 Node 内置模块）：

```bash
git clone https://github.com/bugyangwithoutbug/prompt-predictor.git ~/.gemini/config/plugins/prompt-predictor
```

然后在 Antigravity 的 **Customizations / Plugins** 页面确认 **Prompt Predictor** 已启用，从右侧辅助栏打开 **Prompt Predictor** 面板即可。

## 配置与模型建议

首次打开面板时会自动展开设置抽屉（也可随时点击右上角 `⚙` 打开）：

1. 选择预设或填写 `Provider`、`Base URL`、`Model`、`API Key`（本机 `localhost` / `127.0.0.1` 服务可留空 Key）。
2. 可选填写 **「预测风格提示」** 来微调建议倾向（例如：`优先指出隐含风险、前置排查边界和先验证再改动`）。
3. 点击 **Test** 验证连通性，然后点击 **Save**。

配置文件本地保存于：

```text
~/.gemini/config/plugins/prompt-predictor/settings.local.json
```

该文件通过原子写入创建并强制设为 `0600` 权限，仅当前系统用户可读；未鉴权的 `GET /api/config` 接口不会返回明文 Key。

## 运行测试

```bash
node --test ~/.gemini/config/plugins/prompt-predictor/sidecars/predictor/test/*.test.mjs
```
