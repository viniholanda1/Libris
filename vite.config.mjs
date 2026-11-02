import { defineConfig } from 'vite'
import { cpSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const output = resolve(root, 'dist')

export default defineConfig({
  root,
  base: process.env.GITHUB_PAGES === 'true' ? '/Libris/' : '/',
  build: {
    outDir: output,
    emptyOutDir: true
  },
  plugins: [{
    name: 'copy-libris-static-assets',
    writeBundle(_options, bundle) {
      copyFileSync(resolve(root, 'sw.js'), resolve(output, 'sw.js'))
      copyFileSync(resolve(root, 'manifest.webmanifest'), resolve(output, 'manifest.webmanifest'))
      cpSync(resolve(root, 'icons'), resolve(output, 'icons'), { recursive: true })
      writeFileSync(resolve(output, '.nojekyll'), '')

      const staticFiles = [
        './',
        './index.html',
        ...Object.keys(bundle).map((fileName) => `./${fileName}`),
        './manifest.webmanifest',
        './icons/libris-192.png',
        './icons/libris-512.png'
      ]
      const workerPath = resolve(output, 'sw.js')
      const worker = readFileSync(workerPath, 'utf8')
      const staticFilesDeclaration = `const STATIC_FILES = ${JSON.stringify(staticFiles)}`
      const updatedWorker = worker.replace(/const STATIC_FILES = \[[\s\S]*?\]/, staticFilesDeclaration)
      if (updatedWorker === worker) throw new Error('Não foi possível gerar a lista de arquivos offline do Libris.')
      writeFileSync(workerPath, updatedWorker)
    }
  }]
})