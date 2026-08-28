import { clearFS, getFFmpeg, readFile, toBlob, writeFile } from './client'

function extension(mime: string, fallback: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  return fallback
}

/** 删除生成视频的临时声音，换成最终克隆语音，让剪辑台预览和导出听到同一音轨。 */
export async function replaceVideoAudio(
  video: Blob,
  audio: Blob,
  onProgress?: (message: string) => void
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(onProgress)
  await clearFS(ffmpeg)
  const videoName = `talking.${extension(video.type, 'mp4')}`
  const audioName = `cloned.${extension(audio.type, 'mp3')}`
  const outputName = 'talking_cloned.mp4'
  await writeFile(ffmpeg, videoName, video)
  await writeFile(ffmpeg, audioName, audio)
  onProgress?.('正在把克隆语音写入人物视频…')
  const exitCode = await ffmpeg.exec([
    '-i', videoName,
    '-i', audioName,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-shortest',
    '-movflags', '+faststart',
    '-y', outputName
  ])
  if (exitCode !== 0) throw new Error(`替换数字人音轨失败（FFmpeg ${exitCode}）`)
  return toBlob((await readFile(ffmpeg, outputName)) as Uint8Array, 'video/mp4')
}

