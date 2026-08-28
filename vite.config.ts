import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'

/** Packaged builds must not inline this machine's .env keys or endpoints. */
const packEnvDir = path.join(__dirname, 'scripts/pack-env')

function stripMachineEnvOnPack(): Plugin {
  return {
    name: 'strip-machine-env-on-pack',
    configResolved(config) {
      if (config.command !== 'build') return
      for (const key of Object.keys(config.env)) {
        if (key.startsWith('VITE_')) config.env[key] = ''
      }
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  base: './',
  envDir: command === 'build' ? packEnvDir : __dirname,
  build: {
    sourcemap: false
  },
  plugins: [
    stripMachineEnvOnPack(),
    vue(),
    electron({
      main: { entry: 'electron/main.ts' },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
        vite: {
          build: {
            rollupOptions: {
              output: {
                format: 'cjs',
                entryFileNames: 'preload.cjs',
                inlineDynamicImports: true
              }
            }
          }
        }
      }
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    // FFmpeg.wasm 需要 cross-origin isolation 启用 SharedArrayBuffer
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    fs: {
      // 允许 serve public/ 目录
      strict: false
    }
  },
  preview: {
    port: 4173,
    host: '0.0.0.0',
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  // FFmpeg core 的 wasm 不应该被 Vite 拦截处理
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@ffmpeg/core']
  }
  // ⚠️ 不要设置 worker.format='es'：ffmpeg-core UMD 用 importScripts 加载，
  //    module worker 不支持，会导致 core 永远加载不出来。
}))
