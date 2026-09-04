# 安全说明

## API Key 原则

本仓库不提供、也不应提交任何真实 API Key、Token、Cookie、私有服务地址或个人配置。

- 本地开发请复制 `.env.example` 为 `.env`，真实值只写入 `.env`。
- `.env`、`.env.*`、私钥和常见凭据文件已被 `.gitignore` 排除。
- 不要把设置页导出的本机配置、日志、诊断文件或项目素材提交到公开仓库。
- 发布公开安装包时不要在构建环境中设置真实的 `VITE_*_API_KEY`。

Vite 的 `VITE_*` 变量属于前端构建变量。若构建时填入真实 Key，它可能进入 JavaScript 产物。公开发行版本应保持 Key 为空，由每位用户在自己的电脑上配置。

## 提交前检查

```bash
git status --short
git ls-files ".env*" "*.pem" "*.key" "*.p12" "*.pfx"
npm run security:check
npm run build
```

构建命令会运行 `scripts/assert-pack-clean.mjs`，检查 `dist` 是否包含当前机器 `.env` 中的值。但它不能代替 Git 历史扫描，也不能识别所有形式的凭据。

建议公开推送前再运行 Gitleaks 或 TruffleHog：

```bash
gitleaks git --redact
```

## 如果 Key 曾经进入提交历史

仅删除当前文件是不够的。应立即：

1. 在对应服务商后台撤销并重新生成 Key。
2. 使用 `git filter-repo` 或 BFG 清理整个 Git 历史。
3. 再次运行历史扫描。
4. 确认无泄漏后才推送公开仓库。

## 漏洞报告

请不要在公开 Issue 中粘贴有效凭据、用户素材或可复现的敏感数据。维护者可在 GitHub 仓库启用 Private vulnerability reporting 接收安全报告。
