# 参与贡献

感谢参与剧流 Studio。提交修改前请先确认变更范围清晰，并避免把个人素材、API Key 或本机配置带入仓库。

## 本地开发

```bash
npm install
Copy-Item .env.example .env
npm run dev
```

默认演示模式不要求 API Key。需要测试真实服务时，只在本机 `.env` 或应用设置中配置。

## 质量检查

```bash
npm run type-check
npm run build
```

涉及 Electron 打包时再运行：

```bash
npm run electron:build
```

## Pull Request 要求

- 一个 PR 尽量解决一个明确问题。
- 说明用户体验变化和验证方式。
- UI 修改建议附截图或录屏。
- 新增 AI 服务时，提供空 Key 的配置示例和接口说明。
- 不提交生成产物、构建目录、诊断日志、个人项目文件或受版权限制的素材。
- 不在提示词模板中写死特定项目的人名、场景、风格或私有工作流参数。
