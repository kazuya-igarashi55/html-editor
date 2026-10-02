// node build.js [--with-sample <資料のパス>]
// index.html が読み込む CSS・JS をすべて埋め込み、1ファイルで動くエディタを dist/ に作る。
// --with-sample を付けると、動作確認用に指定した資料を最初から読み込んだ版を、その資料と同じフォルダに作る。
'use strict';
const fs = require('fs');
const path = require('path');

const dir = __dirname;
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, href) =>
  '<style>\n' + fs.readFileSync(path.join(dir, href), 'utf8') + '</style>');
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) =>
  '<script>\n' + fs.readFileSync(path.join(dir, src), 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>');

const out = path.join(dir, 'dist');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'html-editor.html'), html);
console.log('作成: dist/html-editor.html (' + Math.round(html.length / 1024) + 'KB)');

const si = process.argv.indexOf('--with-sample');
if (si >= 0) {
  const samplePath = path.resolve(process.argv[si + 1] || '');
  if (!process.argv[si + 1] || !fs.existsSync(samplePath)) { console.error('--with-sample の後に資料のパスを指定してください'); process.exit(1); }
  const sample = fs.readFileSync(samplePath, 'utf8');
  const loader = '<script>window.addEventListener("load",function(){HedApp.loadDocument(' +
    JSON.stringify(sample).replace(/<\//g, '<\\/') + ',' + JSON.stringify(path.basename(samplePath)) + ',null);});</script>';
  const withSample = html.replace('</body>', loader + '\n</body>');
  const outPath = path.join(path.dirname(samplePath), 'editor-with-sample.html');
  fs.writeFileSync(outPath, withSample);
  console.log('作成: ' + outPath + '（動作確認用）');
}
