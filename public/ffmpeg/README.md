# FFmpeg Core 本地化

如果你的网络访问 CDN 慢/被墙，可以把 FFmpeg core 下载到本地。

## 一键下载

```bash
node scripts/download-ffmpeg-core.cjs
```

默认从 jsdelivr 拉 ESM 版，国内网络可以加 `--source=npmmirror`。

可选源：
- `jsdelivr` （默认，国际）
- `unpkg` （国际）
- `npmmirror` （国内镜像，推荐国内用户）

```bash
node scripts/download-ffmpeg-core.cjs --source=npmmirror
```

下载的文件会放到 `src/assets/ffmpeg/`，被 Vite 通过 `?url` import 引用。

## 手动放文件

如果自动下载失败，可以手动去以下地址下载 2 个文件，放到 **`src/assets/ffmpeg/`** 目录：

- `ffmpeg-core.esm.js` (~110 KB)  ← 必须是 **ESM 版**，不是 UMD 版
- `ffmpeg-core.wasm` (~30 MB)

注意 1：`@ffmpeg/ffmpeg` 0.12.10 强制用 module worker，module worker 不支持 `importScripts`，
所以 UMD 版 core 用不了，必须用 ESM 版（`dist/esm/ffmpeg-core.js`）。

注意 2：文件必须放在 `src/assets/ffmpeg/`，**不能放 `public/`**。
Vite 禁止从 source code 引用 public/ 下的文件，会报：
> "This file is in /public and will be copied as-is ... should not be imported from source code"

地址（任选）：

```
https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js
https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm

https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js
https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm

https://registry.npmmirror.com/@ffmpeg/core@0.12.10/files/dist/esm/ffmpeg-core.js
https://registry.npmmirror.com/@ffmpeg/core@0.12.10/files/dist/esm/ffmpeg-core.wasm
```

## 优先级

FFmpeg 客户端会按以下顺序找核心：

1. **本地** `src/assets/ffmpeg/ffmpeg-core.esm.js` + `.wasm`（通过 ?url import，零网络）
2. jsDelivr CDN (ESM)
3. unpkg CDN (ESM)
4. npmmirror CDN (ESM)

## 为什么需要本地化？

- **国内访问 CDN 经常被墙/超时** → 本地最快最稳
- **COEP 限制** → `Cross-Origin-Embedder-Policy: require-corp` 会拒绝没带 CORP 头的跨域资源，本地资源天然 OK
- **完全离线** → 跑过一次后，core 进浏览器缓存，再开就秒加载

