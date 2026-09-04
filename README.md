# Voxora 视频洞察工作台

上传视频后，Voxora 会在本地服务端完成以下流程：

1. 接收视频文件
2. 使用 FFmpeg 提取单声道 16kHz WAV 音频
3. 调用配置的语音转写接口
4. 将完整文字稿发送给文字分析模型
5. 返回主题、核心观点、一句话总结、关键案例，以及带句子级起止时间的完整文字稿
6. 在网页中按时间轴展示、复制或导出结果

## 启动

```powershell
# 首次使用时复制配置模板
Copy-Item .env.example .env
# 编辑 .env，填写两个接口的 URL、Key 和模型名
npm start
```

打开 `http://localhost:5179`。端口可以通过 `.env` 中的 `PORT` 修改。

项目只使用 Node.js 内置模块，不需要安装第三方 npm 依赖。Node.js 需要支持原生 `fetch`、`FormData` 和 `Blob`，推荐 Node.js 20 或更高版本。

## 配置

```env
TRANSCRIBE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
TRANSCRIBE_KEY=sk-your-transcription-key
TRANSCRIBE_MODEL=your-transcription-model

AI_URL=https://example.com/
AI_KEY=sk-your-analysis-key
AI_MODEL=your-analysis-model

PORT=5179
API_TIMEOUT_MS=120000
```

`TRANSCRIBE_URL` 和 `AI_URL` 可以填写服务根地址，也可以填写完整接口地址。文字分析接口会自动补齐 `/v1/chat/completions`。

当前配置使用 DashScope 的 `fun-asr-flash-2026-06-15`。该模型不是 `/v1/audio/transcriptions` 路由，而是使用 DashScope 原生多模态接口：服务端会把 `TRANSCRIBE_URL` 转换为 `/api/v1/services/aigc/multimodal-generation/generation`，以 WAV Base64 Data URI 的形式发送音频。

如果改用其他语音模型，服务端会按 OpenAI-compatible 方式调用 `/v1/audio/transcriptions`，请求中包含 `file` 和 `model` 字段，并解析以下任一形式的文字稿：

```json
{"text":"完整文字稿"}
```

Fun-ASR-Flash 适合短音频，当前建议单段视频控制在 5 分钟以内；更长视频应改用支持异步文件转写的模型。

文字分析接口需要接受 Chat Completions 格式的 JSON 请求。模型需要根据提示返回包含以下字段的 JSON 对象：

```json
{
  "theme": "视频主题",
  "points": ["核心观点1", "核心观点2", "核心观点3"],
  "summary": "一句话总结",
  "cases": [["案例标题", "案例说明"]]
}
```

服务端会自动把 ASR 得到的完整文字稿加入最终结果，不要求分析模型重复返回 `transcript`。当转写服务返回句子或单词时间戳时，结果还会包含 `transcriptSegments`：

```json
{
  "transcriptSegments": [
    {"startMs": 0, "endMs": 2840, "text": "第一句话"},
    {"startMs": 2960, "endMs": 6150, "text": "第二句话"}
  ]
}
```

网页会把每段显示成“起始时间 – 结束时间 + 对应内容”。如果当前语音模型不提供时间戳，则自动回退为一条完整文字稿。

## 接口

### `GET /api/health`

检查服务端配置，不返回任何 API Key：

```json
{
  "configured": true,
  "missing": [],
  "transcribeModel": "...",
  "analysisModel": "..."
}
```

### `POST /api/analyze?language=中文（普通话）&style=深度提炼`

请求体是原始视频二进制数据，服务端负责提取音频、转写和分析。

## 安全说明

- API Key 只放在服务端 `.env`，不会发送到浏览器。
- `.env` 已加入 `.gitignore`，不要把它提交到仓库。
- 不要把真实 Key 写入 `.env.example`、README 或前端代码。
- 如果 Key 曾经在聊天、截图或日志中公开，应在服务商后台轮换后再用于生产环境。
- 当前实现会把上传文件暂存在内存中处理，不会主动保存视频到磁盘。
