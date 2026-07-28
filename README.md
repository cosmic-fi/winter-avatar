# Winter Avatar

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen.svg)](https://winteravatar.cosmicfi.dev)
[![npm version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://www.npmjs.com/package/winter-avatar)
[![npm downloads](https://img.shields.io/badge/downloads-0%2Fmonth-green.svg)](https://www.npmjs.com/package/winter-avatar)
[![bundle size](https://img.shields.io/badge/size-42KB-orange.svg)](https://github.com/yourusername/winter-avatar)

A powerful TypeScript/Node.js library for rendering Minecraft skin avatars. Convert Minecraft usernames or UUIDs into beautiful 2D and 3D isometric avatar images.

## Features

- **2D Renderings**: Face, bust, and full-body flat renders
- **3D Isometric Renderings**: Head, bust, and full-body 3D models
- **Automatic Skin Resolution**: Resolves usernames to UUIDs via Mojang API
- **Smart Caching**: In-memory caching with TTL for optimal performance
- **Fallback Support**: Automatic fallback to default Steve/Alex skins
- **Promise Coalescing**: Prevents duplicate API requests
- **TypeScript Support**: Full type definitions included

## Screenshots

### 2D Renders
![2D Face](docs/screenshots/2d-face.png)
![2D Bust](docs/screenshots/2d-bust.png)
![2D Full Body](docs/screenshots/2d-full.png)

### 3D Isometric Renders
![3D Head](docs/screenshots/3d-head.png)
![3D Bust](docs/screenshots/3d-bust.png)
![3D Full Body](docs/screenshots/3d-full.png)

## Installation

```bash
npm install winter-avatar
```

## Requirements

- Node.js >= 18.0.0
- npm or yarn

## Quick Start

```typescript
import { WinterAvatar } from 'winter-avatar';

// Initialize the avatar renderer
const avatar = new WinterAvatar();
await avatar.initialize();

// Render a 2D face
const faceBuffer = await avatar.render2dFace('COSMICxO11y', 256);
// Save to file
import fs from 'fs/promises';
await fs.writeFile('face.png', faceBuffer);

// Render a 3D head
const headBuffer = await avatar.render3dHead('COSMICxO11y', 256);
await fs.writeFile('head.png', headBuffer);

// Render a 3D full body
const bodyBuffer = await avatar.render3dFull('COSMICxO11y', 256);
await fs.writeFile('body.png', bodyBuffer);
```

## API Reference

### Constructor

```typescript
new WinterAvatar(assetsDir?: string)
```

- `assetsDir` (optional): Custom directory for storing default skin assets. Defaults to `./assets`

### Methods

#### `initialize(): Promise<void>`

Initializes the client and downloads default Steve/Alex skins if they don't exist.

```typescript
await avatar.initialize();
```

#### `render2dFace(username: string, size?: number, overlay?: boolean): Promise<Buffer>`

Renders a 2D flat face/avatar.

- `username`: Minecraft username or UUID
- `size`: Output image size in pixels (default: 128)
- `overlay`: Whether to include the skin overlay layer (default: true)

```typescript
const buffer = await avatar.render2dFace('COSMICxO11y', 256, true);
```

#### `render2dBust(username: string, size?: number, overlay?: boolean): Promise<Buffer>`

Renders a 2D flat bust (head, torso, and arms).

```typescript
const buffer = await avatar.render2dBust('COSMICxO11y', 128, true);
```

#### `render2dFull(username: string, size?: number, overlay?: boolean): Promise<Buffer>`

Renders a 2D flat full body.

```typescript
const buffer = await avatar.render2dFull('COSMICxO11y', 256, false);
```

#### `render3dHead(username: string, size?: number, overlay?: boolean): Promise<Buffer>`

Renders a 3D isometric head.

```typescript
const buffer = await avatar.render3dHead('COSMICxO11y', 128, true);
```

#### `render3dBust(username: string, size?: number, overlay?: boolean): Promise<Buffer>`

Renders a 3D isometric bust (head + torso + arms).

```typescript
const buffer = await avatar.render3dBust('COSMICxO11y', 256, true);
```

#### `render3dFull(username: string, size?: number, overlay?: boolean): Promise<Buffer>`

Renders a 3D isometric full body.

```typescript
const buffer = await avatar.render3dFull('COSMICxO11y', 512, true);
```

#### `getSkinData(username: string): Promise<SkinData>`

Gets raw skin data for a username.

```typescript
const { buffer, model } = await avatar.getSkinData('COSMICxO11y');
// model is either 'steve' or 'alex'
```

#### `getRawSkin(username: string): Promise<Buffer>`

Gets the raw skin texture buffer.

```typescript
const skinBuffer = await avatar.getRawSkin('COSMICxO11y');
```

#### `clearCaches(): void`

Clears all memory caches.

```typescript
avatar.clearCaches();
```

### Types

```typescript
interface SkinData {
  buffer: Buffer;
  model: 'steve' | 'alex';
}
```

## Advanced Usage

### Using with Express.js

```typescript
import express from 'express';
import { WinterAvatar } from 'winter-avatar';

const app = express();
const avatar = new WinterAvatar();

await avatar.initialize();

app.get('/avatar/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const buffer = await avatar.render3dFull(username, 256);
    
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (error) {
    res.status(500).send('Error rendering avatar');
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
```

### Custom Assets Directory

```typescript
const avatar = new WinterAvatar('/path/to/custom/assets');
await avatar.initialize();
```

### Rendering with UUID

```typescript
// You can also use UUIDs directly
const buffer = await avatar.render3dFull('069a79f444e94726a5befca90e38aaf5', 256);
```

## How It Works

1. **Username Resolution**: Converts Minecraft usernames to UUIDs using the Mojang API
2. **Profile Fetching**: Retrieves skin URL and model type from Mojang's session server
3. **Skin Download**: Downloads the skin texture with caching
4. **Rendering**: Renders the skin using canvas-based 2D or 3D isometric projection
5. **Fallback**: If any step fails, falls back to default Steve/Alex skins

## Caching

The library implements multiple layers of caching:

- **UUID Cache**: 24-hour TTL for username-to-UUID mappings
- **Profile Cache**: 24-hour TTL for skin profile data
- **Skin Cache**: 24-hour TTL for downloaded skin textures
- **Render Cache**: 24-hour TTL for rendered images (LRU eviction at 500 items)

## Performance Tips

1. **Reuse the avatar instance**: Create one avatar instance and reuse it across your application
2. **Pre-initialize**: Call `initialize()` during app startup
3. **Adjust sizes**: Smaller sizes render faster
4. **Disable overlay**: Set `overlay: false` if you don't need the outer layer

## Troubleshooting

### Build Errors

If you encounter build errors related to `import.meta`, ensure your `tsconfig.json` has:
```json
{
  "compilerOptions": {
    "module": "ES2022",
    "moduleResolution": "Node"
  }
}
```

### Missing Dependencies

If you get errors about missing `@napi-rs/canvas` or `axios`, reinstall dependencies:
```bash
npm install
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## Credits

This library is based on the WinterAvatar API server, ported to run standalone in Node.js.