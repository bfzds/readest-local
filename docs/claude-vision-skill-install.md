# Claude Vision Skill 安装记录

- 日期：2026-08-11
- 来源：https://github.com/asuojun/claude-vision-skill（内容审查通过，无危险代码）
- 安装位置：`C:\Users\30575\.codex\skills\claude-vision\`
- 核心文件：`SKILL.md`、`vision.js`、`.env`、`.env.example`、`README.md`、`CLAUDE.md`、`cyberboss-setup.md`
- 依赖：`dotenv`（从 npmmirror 国内镜像安装）

## 配置

- 平台：阿里云百炼（DashScope）
- API Base：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- 模型：`qwen3.7-plus`
- API Key：保存在 `C:\Users\30575\.codex\skills\claude-vision\.env` 的 `DASHSCOPE_API_KEY`，不在本文件重复记录

## 验证结果

- `node --check vision.js`：通过
- 64x64 纯红色测试图调用成功，返回：`这张图片是纯红色的，没有任何图案或具体内容。`

## 注意事项

- 需要重启 Codex 后新 skill 才会被加载。
- 百炼模型要求图片宽高大于 10 像素，1x1 等过小图片会报参数错误。
- 如果 `qwen3.7-plus` 后续在百炼不可用，可改 `.env` 中的 `VISION_MODEL`，例如 `qwen3.5-omni-plus` 或 `qwen-vl-max`。
