import { WinterAvatar } from './dist/index.js';
import fs from 'fs/promises';

async function main() {
  const avatar = new WinterAvatar();
  await avatar.initialize();

  // Render a 3D avatar for COSMICxO11y
  const buffer = await avatar.render3dFull('COSMICxO11y', 256);
  await fs.writeFile('COSMICxO11y.png', buffer);
  console.log('Avatar saved to COSMICxO11y.png');
}

main();
