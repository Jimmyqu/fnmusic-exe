// 将 build/icon.png 转换为 build/icon.ico（供 electron-builder / 应用图标使用）
// 若仅提供 icon.jpg，则先用 jimp 转为 PNG 再生成 ICO
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const pngToIco = require('png-to-ico');

const buildDir = path.join(__dirname, 'build');
const pngPath = path.join(buildDir, 'icon.png');
const jpgPath = path.join(buildDir, 'icon.jpg');
const icoPath = path.join(buildDir, 'icon.ico');

(async () => {
  try {
    let pngBuf;
    if (fs.existsSync(pngPath)) {
      pngBuf = fs.readFileSync(pngPath);
      // 若尺寸过大或不规则，统一缩放到 512 以保证 ICO 质量
      const img = await Jimp.read(pngBuf);
      if (img.bitmap.width !== 512 || img.bitmap.height !== 512) {
        img.cover(512, 512);
        pngBuf = await img.getBufferAsync(Jimp.MIME_PNG);
        fs.writeFileSync(pngPath, pngBuf);
        console.log('icon.png 已规范化为 512x512');
      }
    } else if (fs.existsSync(jpgPath)) {
      const img = await Jimp.read(jpgPath);
      img.cover(512, 512);
      pngBuf = await img.getBufferAsync(Jimp.MIME_PNG);
      fs.writeFileSync(pngPath, pngBuf);
      console.log('已从 icon.jpg 生成 icon.png');
    } else {
      console.error('缺少 icon.png 与 icon.jpg');
      process.exit(1);
    }

    const icoBuf = await pngToIco(pngBuf);
    fs.writeFileSync(icoPath, icoBuf);
    console.log('ICO 已生成:', icoPath);
  } catch (err) {
    console.error('转换失败:', err);
    process.exit(1);
  }
})();
