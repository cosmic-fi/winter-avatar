import { WinterAvatar } from './src/index.ts';

async function test() {
  console.log('Testing WinterAvatar Library...\n');

  const client = new WinterAvatar();

  console.log('1. Initializing client...');
  await client.initialize();
  console.log('   ✓ Client initialized\n');

  console.log('2. Testing 2D face render...');
  try {
    const faceBuffer = await client.render2dFace('COSMICxO11y', 128);
    console.log(`   ✓ 2D face rendered: ${faceBuffer.length} bytes\n`);
  } catch (err) {
    console.error('   ✗ 2D face render failed:', err);
  }

  console.log('3. Testing 3D head render...');
  try {
    const headBuffer = await client.render3dHead('COSMICxO11y', 128);
    console.log(`   ✓ 3D head rendered: ${headBuffer.length} bytes\n`);
  } catch (err) {
    console.error('   ✗ 3D head render failed:', err);
  }

  console.log('4. Testing 3D bust render...');
  try {
    const bustBuffer = await client.render3dBust('COSMICxO11y', 128);
    console.log(`   ✓ 3D bust rendered: ${bustBuffer.length} bytes\n`);
  } catch (err) {
    console.error('   ✗ 3D bust render failed:', err);
  }

  console.log('5. Testing 3D full body render...');
  try {
    const bodyBuffer = await client.render3dFull('COSMICxO11y', 128);
    console.log(`   ✓ 3D full body rendered: ${bodyBuffer.length} bytes\n`);
  } catch (err) {
    console.error('   ✗ 3D full body render failed:', err);
  }

  console.log('6. Testing cache clearing...');
  client.clearCaches();
  console.log('   ✓ Caches cleared\n');

  console.log('All tests completed!');
}

test().catch(console.error);