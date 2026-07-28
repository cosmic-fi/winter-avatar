import { createCanvas, loadImage, Image, Canvas } from '@napi-rs/canvas';
import axios, { type AxiosRequestConfig } from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Buffer } from 'buffer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Represents skin data with buffer and model type
 */
export interface SkinData {
	/** The skin image buffer */
	buffer: Buffer;
	/** The skin model type */
	model: 'steve' | 'alex';
}

/**
 * Represents profile data containing skin URL and model
 */
export interface ProfileData {
	/** URL to the skin texture */
	skinUrl: string;
	/** The skin model type */
	model: 'steve' | 'alex';
}

/**
 * Base render options
 */
export interface RenderOptions {
	/** Output image size in pixels (default: 128) */
	size?: number;
	/** Whether to include the skin overlay layer (default: true) */
	overlay?: boolean;
	/** The skin model type (default: 'steve') */
	model?: 'steve' | 'alex';
}

/**
 * 3D model render options
 */
export interface Model3DOptions extends RenderOptions {
	/** The skin buffer to render */
	skinBuffer: Buffer;
	/** Array of body parts to render (default: all parts) */
	renderParts?: string[];
	/** Custom rotation poses for body parts */
	poses?: Record<string, { x: number; y: number; z: number }>;
}

/**
 * 3D point coordinates
 */
export interface Point3D {
	/** X coordinate */
	x: number;
	/** Y coordinate */
	y: number;
	/** Z coordinate */
	z: number;
}

/**
 * Represents a 3D box face for rendering
 */
export interface BoxFace {
	/** Face name (front, back, left, right, top, bottom) */
	name: string;
	/** Corner points of the face */
	corners: Point3D[];
	/** Texture coordinates and dimensions */
	tex: { x: number; y: number; w: number; h: number };
	/** Shading intensity (0-1) */
	shading: number;
}

/**
 * Configuration for a 3D body part box
 */
export interface BoxConfig {
	/** Body part name */
	name: string;
	/** Width */
	w: number;
	/** Height */
	h: number;
	/** Depth */
	d: number;
	/** Texture X coordinate */
	tx: number;
	/** Texture Y coordinate */
	ty: number;
	/** Outer layer texture X coordinate */
	outerTx: number;
	/** Outer layer texture Y coordinate */
	outerTy: number;
	/** Pivot point for rotation */
	pivot: Point3D;
	/** Position offset */
	pos: Point3D;
}

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------
interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

const memoryCache = {
	uuids: new Map<string, CacheEntry<string>>(),
	profiles: new Map<string, CacheEntry<ProfileData>>(),
	skins: new Map<string, CacheEntry<Buffer>>(),
	renders: new Map<string, CacheEntry<Buffer>>(),
};

// Active promise coalescing maps to prevent duplicate API queries
const activeResolves = new Map<string, Promise<string>>();
const activeProfiles = new Map<string, Promise<ProfileData>>();
const activeSkins = new Map<string, Promise<Buffer>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Checks if a string is a valid Minecraft UUID (with or without dashes).
 */
function isUuid(str: string): boolean {
	return (
		/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(str) ||
		/^[0-9a-f]{32}$/i.test(str)
	);
}

/**
 * Normalizes a UUID by removing dashes and converting to lowercase.
 */
function normalizeUuid(uuid: string): string {
	return uuid.replace(/-/g, '').toLowerCase();
}

/**
 * Determines the default skin model based on a UUID.
 */
function getDefaultModel(uuid: string): 'steve' | 'alex' {
	const cleanUuid = normalizeUuid(uuid);
	if (cleanUuid.length !== 32) return 'steve';
	const chars = [7, 15, 23, 31];
	let lsbsEven = 0;
	for (const index of chars) {
		lsbsEven ^= parseInt(cleanUuid[index], 16);
	}
	return lsbsEven % 2 !== 0 ? 'alex' : 'steve';
}

/**
 * Determines the default skin model based on a username.
 */
function getDefaultModelForName(username: string): 'steve' | 'alex' {
	const norm = username.toLowerCase();
	if (norm === 'alex' || norm === 'mhf_alex') return 'alex';
	if (norm === 'steve' || norm === 'mhf_steve') return 'steve';
	let hash = 0;
	for (let i = 0; i < username.length; i++) {
		hash = username.charCodeAt(i) + ((hash << 5) - hash);
	}
	return Math.abs(hash) % 2 === 1 ? 'alex' : 'steve';
}

/**
 * Performs an axios request with retry logic on failure.
 */
async function axiosWithRetry(
	config: AxiosRequestConfig,
	retries = 2,
	delay = 500
): Promise<any> {
	try {
		return await axios.request(config);
	} catch (err) {
		const isTimeoutOrNetwork = !(err as any).response || (err as any).response.status >= 500;
		if (retries <= 0 || !isTimeoutOrNetwork) {
			throw err;
		}
		console.warn(
			`[WinterAvatar] API request to ${config.url} failed: ${(err as Error).message}. Retrying in ${delay}ms...`
		);
		await new Promise((r) => setTimeout(r, delay));
		return axiosWithRetry(config, retries - 1, delay * 2);
	}
}

// ---------------------------------------------------------------------------
// UUID Resolution
// ---------------------------------------------------------------------------
/**
 * Resolves a Minecraft username to its corresponding UUID.
 */
async function resolveUuid(username: string): Promise<string> {
	const normName = username.toLowerCase();

	// 1. Memory cache check
	if (memoryCache.uuids.has(normName)) {
		const cached = memoryCache.uuids.get(normName)!;
		if (Date.now() - cached.timestamp < CACHE_TTL) {
			return cached.data;
		}
	}

	// Coalesce concurrent resolves
	if (activeResolves.has(normName)) {
		return activeResolves.get(normName)!;
	}

	const promise = (async (): Promise<string> => {
		// 2. API request to Mojang
		try {
			console.log(`[WinterAvatar] Resolving UUID for: ${username}`);
			const response = await axiosWithRetry({
				url: `https://api.mojang.com/users/profiles/minecraft/${username}`,
				method: 'GET',
				timeout: 8000,
			});
			if (response.status === 200 && response.data && response.data.id) {
				const uuid = normalizeUuid(response.data.id);
				memoryCache.uuids.set(normName, { data: uuid, timestamp: Date.now() });
				return uuid;
			}
		} catch (err) {
			console.warn(
				`[WinterAvatar] Failed to resolve UUID for ${username} via Mojang API:`,
				(err as Error).message
			);

			// Secondary Fallback: Minetools API
			try {
				console.log(`[WinterAvatar] Resolving UUID for: ${username} via Minetools fallback`);
				const fallbackResponse = await axios({
					url: `https://api.minetools.eu/uuid/${username}`,
					method: 'GET',
					timeout: 8000,
				});
				if (fallbackResponse.status === 200 && fallbackResponse.data && fallbackResponse.data.id) {
					const uuid = normalizeUuid(fallbackResponse.data.id);
					memoryCache.uuids.set(normName, { data: uuid, timestamp: Date.now() });
					return uuid;
				}
			} catch (fallbackErr) {
				console.error(
					`[WinterAvatar] Failed to resolve UUID for ${username} via Minetools fallback:`,
					(fallbackErr as Error).message
				);
			}
		}

		throw new Error(`Player not found or Mojang API error for username: ${username}`);
	})();

	activeResolves.set(normName, promise);
	try {
		return await promise;
	} finally {
		activeResolves.delete(normName);
	}
}

// ---------------------------------------------------------------------------
// Profile Data (skin URL + model)
// ---------------------------------------------------------------------------
/**
 * Fetches the profile data containing the skin URL and model type for a given UUID.
 */
async function getProfileData(uuid: string): Promise<ProfileData> {
	const norm = normalizeUuid(uuid);

	// 1. Memory cache check
	if (memoryCache.profiles.has(norm)) {
		const cached = memoryCache.profiles.get(norm)!;
		if (Date.now() - cached.timestamp < CACHE_TTL) {
			return cached.data;
		}
	}

	// Coalesce concurrent profile loads
	if (activeProfiles.has(norm)) {
		return activeProfiles.get(norm)!;
	}

	const promise = (async (): Promise<ProfileData> => {
		// 2. API request to Mojang sessionserver
		try {
			console.log(`[WinterAvatar] Fetching profile for UUID: ${norm}`);
			const response = await axiosWithRetry({
				url: `https://sessionserver.mojang.com/session/minecraft/profile/${norm}`,
				method: 'GET',
				timeout: 8000,
			});
			if (response.status === 200 && response.data && response.data.properties) {
				const properties = response.data.properties;
				const texturesProp = properties.find((p: any) => p.name === 'textures');
				if (texturesProp) {
					const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
					const skinData = decoded.textures && decoded.textures.SKIN;
					if (skinData && skinData.url) {
						const profileResult: ProfileData = {
							skinUrl: skinData.url,
							model: skinData.metadata && skinData.metadata.model === 'slim' ? 'alex' : 'steve',
						};
						memoryCache.profiles.set(norm, { data: profileResult, timestamp: Date.now() });
						return profileResult;
					}
				}
			}
		} catch (err) {
			console.warn(
				`[WinterAvatar] Failed to fetch profile for UUID ${norm} via Mojang API:`,
				(err as Error).message
			);

			// Secondary Fallback: Minetools Profile API
			try {
				console.log(`[WinterAvatar] Fetching profile for UUID: ${norm} via Minetools fallback`);
				const fallbackResponse = await axios({
					url: `https://api.minetools.eu/profile/${norm}`,
					method: 'GET',
					timeout: 8000,
				});
				if (
					fallbackResponse.status === 200 &&
					fallbackResponse.data &&
					fallbackResponse.data.raw &&
					fallbackResponse.data.raw.properties
				) {
					const properties = fallbackResponse.data.raw.properties;
					const texturesProp = properties.find((p: any) => p.name === 'textures');
					if (texturesProp) {
						const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
						const skinData = decoded.textures && decoded.textures.SKIN;
						if (skinData && skinData.url) {
							const profileResult: ProfileData = {
								skinUrl: skinData.url,
								model: skinData.metadata && skinData.metadata.model === 'slim' ? 'alex' : 'steve',
							};
							memoryCache.profiles.set(norm, { data: profileResult, timestamp: Date.now() });
							return profileResult;
						}
					}
				}
			} catch (fallbackErr) {
				console.error(
					`[WinterAvatar] Failed to fetch profile for UUID ${norm} via Minetools fallback:`,
					(fallbackErr as Error).message
				);
			}
		}

		throw new Error(`Profile not found or Mojang API error for UUID: ${norm}`);
	})();

	activeProfiles.set(norm, promise);
	try {
		return await promise;
	} finally {
		activeProfiles.delete(norm);
	}
}

// ---------------------------------------------------------------------------
// Skin Texture Download
// ---------------------------------------------------------------------------
/**
 * Downloads a skin texture from the given URL and returns its buffer.
 */
async function fetchSkinBuffer(skinUrl: string): Promise<Buffer> {
	const urlParts = skinUrl.split('/');
	const hash = urlParts[urlParts.length - 1];

	// 1. Memory Cache check
	if (memoryCache.skins.has(hash)) {
		const cached = memoryCache.skins.get(hash)!;
		if (Date.now() - cached.timestamp < CACHE_TTL) {
			return cached.data;
		}
	}

	// Coalesce concurrent loads
	if (activeSkins.has(hash)) {
		return activeSkins.get(hash)!;
	}

	const promise = (async (): Promise<Buffer> => {
		try {
			console.log(`[WinterAvatar] Downloading skin texture: ${hash}`);
			const response = await axiosWithRetry({
				url: skinUrl,
				method: 'GET',
				responseType: 'arraybuffer',
				timeout: 8000,
			});
			const buffer = Buffer.from(response.data as any);
			memoryCache.skins.set(hash, { data: buffer, timestamp: Date.now() });
			return buffer;
		} catch (err) {
			console.error(`[WinterAvatar] Failed to download skin texture ${hash}:`, (err as Error).message);
			throw err;
		}
	})();

	activeSkins.set(hash, promise);
	try {
		return await promise;
	} finally {
		activeSkins.delete(hash);
	}
}

// ---------------------------------------------------------------------------
// Skin Loading (resolve username -> UUID -> profile -> skin buffer)
// ---------------------------------------------------------------------------
/**
 * Gets the skin buffer and model type for a given username or UUID.
 * Falls back to default assets if resolution fails.
 */
async function getSkin(nameOrUuid: string): Promise<SkinData> {
	let uuid: string;
	let model: 'steve' | 'alex' = 'steve';
	let isName = !isUuid(nameOrUuid);

	try {
		if (isName) {
			uuid = await resolveUuid(nameOrUuid);
		} else {
			uuid = normalizeUuid(nameOrUuid);
		}

		const profile = await getProfileData(uuid);
		const buffer = await fetchSkinBuffer(profile.skinUrl);
		return { buffer, model: profile.model };
	} catch (err) {
		console.warn(`[WinterAvatar] Fallback triggered for: ${nameOrUuid} (Error: ${(err as Error).message})`);

		// Determine model type for fallback
		if (!isName) {
			model = getDefaultModel(nameOrUuid);
		} else {
			model = getDefaultModelForName(nameOrUuid);
		}

		throw new Error(`Fallback to ${model} skin required`);
	}
}

// ---------------------------------------------------------------------------
// 2D Renderer
// ---------------------------------------------------------------------------
/**
 * Draws a section of the skin image onto the canvas context.
 */
function drawSection(
	ctx: any,
	img: Image | Canvas,
	sx: number,
	sy: number,
	sw: number,
	sh: number,
	dx: number,
	dy: number,
	dw: number,
	dh: number,
	flipH = false
): void {
	ctx.save();
	if (flipH) {
		ctx.translate(dx + dw, dy);
		ctx.scale(-1, 1);
		(ctx as any).drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
	} else {
		(ctx as any).drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
	}
	ctx.restore();
}

/**
 * Converts a legacy 64x32 skin image to the modern 64x64 format.
 */
function convert32To64(img: Image): Canvas {
	const canvas = createCanvas(64, 64);
	const ctx = canvas.getContext('2d');

	(ctx as any).drawImage(img, 0, 0, 64, 32, 0, 0, 64, 32);

	const drawFlipped = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => {
		drawSection(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh, true);
	};

	// Left Leg
	drawFlipped(4, 16, 4, 4, 20, 48, 4, 4);
	drawFlipped(8, 16, 4, 4, 24, 48, 4, 4);
	drawFlipped(0, 20, 4, 12, 24, 52, 4, 12);
	drawFlipped(4, 20, 4, 12, 20, 52, 4, 12);
	drawFlipped(8, 20, 4, 12, 16, 52, 4, 12);
	drawFlipped(12, 20, 4, 12, 28, 52, 4, 12);

	// Left Arm
	drawFlipped(44, 16, 4, 4, 36, 48, 4, 4);
	drawFlipped(48, 16, 4, 4, 40, 48, 4, 4);
	drawFlipped(40, 20, 4, 12, 40, 52, 4, 12);
	drawFlipped(44, 20, 4, 12, 36, 52, 4, 12);
	drawFlipped(48, 20, 4, 12, 32, 52, 4, 12);
	drawFlipped(52, 20, 4, 12, 44, 52, 4, 12);

	return canvas;
}

/**
 * Loads an image buffer and prepares it for rendering, converting to 64x64 if necessary.
 */
async function loadAndPrepareSkin(skinBuffer: Buffer): Promise<Image | Canvas> {
	const img = await loadImage(skinBuffer);
	if (img.height === 32) {
		return convert32To64(img);
	}
	return img;
}

/**
 * Renders a 2D flat face from a skin buffer.
 */
async function render2dFace(skinBuffer: Buffer, size = 128, overlay = true): Promise<Buffer> {
	const img = await loadAndPrepareSkin(skinBuffer);

	const temp = createCanvas(8, 8);
	const tempCtx = temp.getContext('2d');

	// Head front (inner)
	(tempCtx as any).drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);

	// Head front (outer overlay)
	if (overlay) {
		(tempCtx as any).drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
	}

	const canvas = createCanvas(size, size);
	const ctx = canvas.getContext('2d');
	(ctx as any).imageSmoothingEnabled = false;
	(ctx as any).drawImage(temp, 0, 0, 8, 8, 0, 0, size, size);

	return canvas.toBuffer('image/png');
}

/**
 * Renders a 2D flat bust from a skin buffer.
 */
async function render2dBust(skinBuffer: Buffer, size = 128, overlay = true, model: 'steve' | 'alex' = 'steve'): Promise<Buffer> {
	const img = await loadAndPrepareSkin(skinBuffer);

	const isSlim = model === 'alex';
	const armW = isSlim ? 3 : 4;
	const totalW = isSlim ? 14 : 16;
	const totalH = 20;

	const temp = createCanvas(totalW, totalH);
	const tempCtx = temp.getContext('2d');

	const headX = isSlim ? 3 : 4;
	const torsoX = isSlim ? 3 : 4;
	const rightArmX = 0;
	const leftArmX = isSlim ? 11 : 12;

	// Inner Layer
	(tempCtx as any).drawImage(img, 8, 8, 8, 8, headX, 0, 8, 8);
	(tempCtx as any).drawImage(img, 20, 20, 8, 12, torsoX, 8, 8, 12);
	(tempCtx as any).drawImage(img, 44, 20, armW, 12, rightArmX, 8, armW, 12);
	(tempCtx as any).drawImage(img, 36, 52, armW, 12, leftArmX, 8, armW, 12);

	// Outer Layer
	if (overlay) {
		(tempCtx as any).drawImage(img, 40, 8, 8, 8, headX, 0, 8, 8);
		(tempCtx as any).drawImage(img, 20, 36, 8, 12, torsoX, 8, 8, 12);
		(tempCtx as any).drawImage(img, 44, 36, armW, 12, rightArmX, 8, armW, 12);
		(tempCtx as any).drawImage(img, 52, 52, armW, 12, leftArmX, 8, armW, 12);
	}

	const destW = Math.round((totalW / totalH) * size);
	const canvas = createCanvas(destW, size);
	const ctx = canvas.getContext('2d');
	(ctx as any).imageSmoothingEnabled = false;
	(ctx as any).drawImage(temp, 0, 0, totalW, totalH, 0, 0, destW, size);

	return canvas.toBuffer('image/png');
}

/**
 * Renders a 2D flat full body from a skin buffer.
 */
async function render2dFull(skinBuffer: Buffer, size = 128, overlay = true, model: 'steve' | 'alex' = 'steve'): Promise<Buffer> {
	const img = await loadAndPrepareSkin(skinBuffer);

	const isSlim = model === 'alex';
	const armW = isSlim ? 3 : 4;
	const totalW = isSlim ? 14 : 16;
	const totalH = 32;

	const temp = createCanvas(totalW, totalH);
	const tempCtx = temp.getContext('2d');

	const headX = isSlim ? 3 : 4;
	const torsoX = isSlim ? 3 : 4;
	const rightArmX = 0;
	const leftArmX = isSlim ? 11 : 12;
	const rightLegX = isSlim ? 3 : 4;
	const leftLegX = isSlim ? 7 : 8;

	// Inner Layer
	(tempCtx as any).drawImage(img, 8, 8, 8, 8, headX, 0, 8, 8);
	(tempCtx as any).drawImage(img, 20, 20, 8, 12, torsoX, 8, 8, 12);
	(tempCtx as any).drawImage(img, 44, 20, armW, 12, rightArmX, 8, armW, 12);
	(tempCtx as any).drawImage(img, 36, 52, armW, 12, leftArmX, 8, armW, 12);
	(tempCtx as any).drawImage(img, 4, 20, 4, 12, rightLegX, 20, 4, 12);
	(tempCtx as any).drawImage(img, 20, 52, 4, 12, leftLegX, 20, 4, 12);

	// Outer Layer
	if (overlay) {
		(tempCtx as any).drawImage(img, 40, 8, 8, 8, headX, 0, 8, 8);
		(tempCtx as any).drawImage(img, 20, 36, 8, 12, torsoX, 8, 8, 12);
		(tempCtx as any).drawImage(img, 44, 36, armW, 12, rightArmX, 8, armW, 12);
		(tempCtx as any).drawImage(img, 52, 52, armW, 12, leftArmX, 8, armW, 12);
		(tempCtx as any).drawImage(img, 4, 36, 4, 12, rightLegX, 20, 4, 12);
		(tempCtx as any).drawImage(img, 4, 52, 4, 12, leftLegX, 20, 4, 12);
	}

	const destW = Math.round((totalW / totalH) * size);
	const canvas = createCanvas(destW, size);
	const ctx = canvas.getContext('2d');
	(ctx as any).imageSmoothingEnabled = false;
	(ctx as any).drawImage(temp, 0, 0, totalW, totalH, 0, 0, destW, size);

	return canvas.toBuffer('image/png');
}

// ---------------------------------------------------------------------------
// 3D Renderer
// ---------------------------------------------------------------------------
/**
 * Rotates a 3D point around the X axis.
 */
function rotateX(p: Point3D, angle: number): Point3D {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}

/**
 * Rotates a 3D point around the Y axis.
 */
function rotateY(p: Point3D, angle: number): Point3D {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

/**
 * Rotates a 3D point around the Z axis.
 */
function rotateZ(p: Point3D, angle: number): Point3D {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return { x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z };
}

/**
 * Rotates a 3D point around all three axes.
 */
function rotate(p: Point3D, rx: number, ry: number, rz: number): Point3D {
	let pt: Point3D = { x: p.x, y: p.y, z: p.z };
	if (rx !== 0) pt = rotateX(pt, rx);
	if (ry !== 0) pt = rotateY(pt, ry);
	if (rz !== 0) pt = rotateZ(pt, rz);
	return pt;
}

/**
 * Calculates the 3D faces for a given body part box.
 */
function getBoxFaces(box: BoxConfig, isOuter = false, delta = 0.25): BoxFace[] {
	const w = box.w;
	const h = box.h;
	const d = box.d;

	const lX = isOuter ? -delta : 0;
	const rX = isOuter ? w + delta : w;
	const bY = isOuter ? -delta : 0;
	const tY = isOuter ? h + delta : h;
	const fZ = isOuter ? d + delta : d;
	const bkZ = isOuter ? -delta : 0;

	const corners: Point3D[] = [
		{ x: lX, y: bY, z: bkZ },
		{ x: rX, y: bY, z: bkZ },
		{ x: lX, y: tY, z: bkZ },
		{ x: rX, y: tY, z: bkZ },
		{ x: lX, y: bY, z: fZ },
		{ x: rX, y: bY, z: fZ },
		{ x: lX, y: tY, z: fZ },
		{ x: rX, y: tY, z: fZ },
	];

	const tx = isOuter ? box.outerTx : box.tx;
	const ty = isOuter ? box.outerTy : box.ty;

	const shading = isOuter
		? { front: 0.0, back: 0.0, right: 0.1, left: 0.0, top: 0.0, bottom: 0.45 }
		: { front: 0.0, back: 0.55, right: 0.3, left: 0.1, top: 0.0, bottom: 0.6 };

	return [
		{ name: 'front', corners: [corners[6], corners[7], corners[4], corners[5]], tex: { x: tx + d, y: ty + d, w: w, h: h }, shading: shading.front },
		{ name: 'back', corners: [corners[3], corners[2], corners[1], corners[0]], tex: { x: tx + d + w + d, y: ty + d, w: w, h: h }, shading: shading.back },
		{ name: 'right', corners: [corners[2], corners[6], corners[0], corners[4]], tex: { x: tx, y: ty + d, w: d, h: h }, shading: shading.right },
		{ name: 'left', corners: [corners[7], corners[3], corners[5], corners[1]], tex: { x: tx + d + w, y: ty + d, w: d, h: h }, shading: shading.left },
		{ name: 'top', corners: [corners[2], corners[3], corners[6], corners[7]], tex: { x: tx + d, y: ty, w: w, h: d }, shading: shading.top },
		{ name: 'bottom', corners: [corners[4], corners[5], corners[0], corners[1]], tex: { x: tx + d + w, y: ty, w: w, h: d }, shading: shading.bottom },
	];
}

/**
 * Gets the dimensions and positions for the different body parts.
 */
function getPartsConfig(model: 'steve' | 'alex'): Record<string, BoxConfig> {
	const isSlim = model === 'alex';
	const armW = isSlim ? 3 : 4;
	const armPivotX = isSlim ? 1.5 : 2;
	const armPosX = isSlim ? 5.5 : 6;

	return {
		head: {
			name: 'head',
			w: 8,
			h: 8,
			d: 8,
			tx: 0,
			ty: 0,
			outerTx: 32,
			outerTy: 0,
			pivot: { x: 4, y: 0, z: 4 },
			pos: { x: 0, y: 6, z: 0 },
		},
		torso: {
			name: 'torso',
			w: 8,
			h: 12,
			d: 4,
			tx: 16,
			ty: 16,
			outerTx: 16,
			outerTy: 32,
			pivot: { x: 4, y: 6, z: 2 },
			pos: { x: 0, y: 0, z: 0 },
		},
		rightArm: {
			name: 'rightArm',
			w: armW,
			h: 12,
			d: 4,
			tx: 40,
			ty: 16,
			outerTx: 40,
			outerTy: 32,
			pivot: { x: armPivotX, y: 12, z: 2 },
			pos: { x: -armPosX, y: 6, z: 0 },
		},
		leftArm: {
			name: 'leftArm',
			w: armW,
			h: 12,
			d: 4,
			tx: 32,
			ty: 48,
			outerTx: 48,
			outerTy: 48,
			pivot: { x: armPivotX, y: 12, z: 2 },
			pos: { x: armPosX, y: 6, z: 0 },
		},
		rightLeg: {
			name: 'rightLeg',
			w: 4,
			h: 12,
			d: 4,
			tx: 0,
			ty: 16,
			outerTx: 0,
			outerTy: 32,
			pivot: { x: 2, y: 12, z: 2 },
			pos: { x: -2, y: -6, z: 0 },
		},
		leftLeg: {
			name: 'leftLeg',
			w: 4,
			h: 12,
			d: 4,
			tx: 16,
			ty: 48,
			outerTx: 0,
			outerTy: 48,
			pivot: { x: 2, y: 12, z: 2 },
			pos: { x: 2, y: -6, z: 0 },
		},
	};
}

interface VisibleFace {
	face: BoxFace;
	A: Point3D;
	B: Point3D;
	C: Point3D;
	D: Point3D;
	depth: number;
	isOuter: boolean;
}

/**
 * Renders a 3D isometric model of a skin.
 */
async function render3dModel(options: Model3DOptions): Promise<Buffer> {
	const { skinBuffer, model = 'steve', size = 128, overlay = true, renderParts = ['head', 'torso', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'], poses = {} } = options;

	const rawImg = await loadImage(skinBuffer);
	let skinImg: Image | Canvas = rawImg;
	if (rawImg.height === 32) {
		const canvas32 = createCanvas(64, 64);
		const ctx32 = canvas32.getContext('2d');
		ctx32.drawImage(rawImg, 0, 0, 64, 32, 0, 0, 64, 32);
		const drawFlipped = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => {
			ctx32.save();
			ctx32.translate(dx + dw, dy);
			ctx32.scale(-1, 1);
			ctx32.drawImage(rawImg, sx, sy, sw, sh, 0, 0, dw, dh);
			ctx32.restore();
		};
		drawFlipped(4, 16, 4, 4, 20, 48, 4, 4);
		drawFlipped(8, 16, 4, 4, 24, 48, 4, 4);
		drawFlipped(0, 20, 4, 12, 24, 52, 4, 12);
		drawFlipped(4, 20, 4, 12, 20, 52, 4, 12);
		drawFlipped(8, 20, 4, 12, 16, 52, 4, 12);
		drawFlipped(12, 20, 4, 12, 28, 52, 4, 12);
		drawFlipped(44, 16, 4, 4, 36, 48, 4, 4);
		drawFlipped(48, 16, 4, 4, 40, 48, 4, 4);
		drawFlipped(40, 20, 4, 12, 40, 52, 4, 12);
		drawFlipped(44, 20, 4, 12, 36, 52, 4, 12);
		drawFlipped(48, 20, 4, 12, 32, 52, 4, 12);
		drawFlipped(52, 20, 4, 12, 44, 52, 4, 12);
		skinImg = canvas32;
	}

	const partsConfig = getPartsConfig(model);
	const visibleFaces: VisibleFace[] = [];

	const cameraRot = {
		x: 1 * Math.PI / 180,
		y: 34 * Math.PI / 150,
		z: 0,
	};

	const torsoRot = poses.torso || { x: 0, y: 0, z: 0 };

	for (const partName of renderParts) {
		const box = partsConfig[partName];
		if (!box) continue;

		const boxRot = poses[partName] || { x: 0, y: 0, z: 0 };

		const layers: boolean[] = [false];
		if (overlay) layers.push(true);

		for (const isOuter of layers) {
			const faces = getBoxFaces(box, isOuter, isOuter ? 0.35 : 0.0);

			for (const face of faces) {
				const camVertices = face.corners.map((v) => {
					let pt: Point3D = {
						x: v.x - box.pivot.x,
						y: v.y - box.pivot.y,
						z: v.z - box.pivot.z,
					};
					pt = rotate(pt, boxRot.x, boxRot.y, boxRot.z);
					pt.x += box.pos.x;
					pt.y += box.pos.y;
					pt.z += box.pos.z;

					if (partName !== 'torso') {
						pt = rotate(pt, torsoRot.x, torsoRot.y, torsoRot.z);
					}

					pt = rotate(pt, cameraRot.x, cameraRot.y, cameraRot.z);
					return pt;
				});

				const projVertices = camVertices.map((v) => ({
					x: v.x,
					y: -v.y,
					z: v.z,
				}));

				const [A, B, C, D] = projVertices;

				const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
				if (cross <= 0) continue;

				const depth = (camVertices[0].z + camVertices[1].z + camVertices[2].z + camVertices[3].z) / 4;

				visibleFaces.push({ face, A, B, C, D, depth, isOuter });
			}
		}
	}

	let minX = Infinity,
		maxX = -Infinity;
	let minY = Infinity,
		maxY = -Infinity;

	for (const f of visibleFaces) {
		for (const v of [f.A, f.B, f.C, f.D]) {
			if (v.x < minX) minX = v.x;
			if (v.x > maxX) maxX = v.x;
			if (v.y < minY) minY = v.y;
			if (v.y > maxY) maxY = v.y;
		}
	}

	const modelW = maxX - minX;
	const modelH = maxY - minY;

	const pad = 0.85;
	const targetSize = size * pad;
	const scale = Math.min(targetSize / modelW, targetSize / modelH);

	const dx = size / 2 - ((minX + maxX) / 2) * scale;
	const dy = size / 2 - ((minY + maxY) / 2) * scale;

	for (const f of visibleFaces) {
		for (const v of [f.A, f.B, f.C, f.D]) {
			v.x = dx + v.x * scale;
			v.y = dy + v.y * scale;
		}
	}

	visibleFaces.sort((f1, f2) => f1.depth - f2.depth);

	const canvas = createCanvas(size, size);
	const ctx = canvas.getContext('2d');
	ctx.imageSmoothingEnabled = false;

	for (const f of visibleFaces) {
		const { face, A, B, C, D, isOuter } = f;
		const w = face.tex.w;
		const h = face.tex.h;

		ctx.save();
		const a = (B.x - A.x) / w;
		const b = (B.y - A.y) / w;
		const c = (C.x - A.x) / h;
		const d = (C.y - A.y) / h;
		const e = A.x;
		const fY = A.y;

		ctx.transform(a, b, c, d, e, fY);

		if (isOuter) {
			const offscreen = createCanvas(w, h);
			const offCtx = offscreen.getContext('2d');
			offCtx.imageSmoothingEnabled = false;
			offCtx.drawImage(skinImg, face.tex.x, face.tex.y, face.tex.w, face.tex.h, 0, 0, w, h);

			if (face.shading > 0) {
				offCtx.globalCompositeOperation = 'source-atop';
				offCtx.fillStyle = `rgba(0, 0, 0, ${face.shading})`;
				offCtx.fillRect(0, 0, w, h);
			}

			ctx.drawImage(offscreen, 0, 0, w, h, 0, 0, w, h);
		} else {
			ctx.drawImage(skinImg, face.tex.x, face.tex.y, face.tex.w, face.tex.h, 0, 0, w, h);

			ctx.strokeStyle = 'rgba(0, 0, 0, 0.01)';
			ctx.lineWidth = 0.4;
			ctx.strokeRect(0, 0, w, h);

			if (face.shading > 0) {
				ctx.fillStyle = `rgba(0, 0, 0, ${face.shading})`;
				ctx.fillRect(0, 0, w, h);
			}
		}

		ctx.restore();
	}

	return canvas.toBuffer('image/png');
}

// ---------------------------------------------------------------------------
// 3D Public Render Functions
// ---------------------------------------------------------------------------
/**
 * Renders a 3D head.
 */
async function render3dHead(skinBuffer: Buffer, size = 128, overlay = true, model: 'steve' | 'alex' = 'steve'): Promise<Buffer> {
	const poses = {
		head: { x: 1 * Math.PI / 180, y: -15 * Math.PI / 180, z: 0 },
	};
	return render3dModel({ skinBuffer, model, size, overlay, renderParts: ['head'], poses });
}

/**
 * Renders a 3D bust (head + torso + arms).
 */
async function render3dBust(skinBuffer: Buffer, size = 128, overlay = true, model: 'steve' | 'alex' = 'steve'): Promise<Buffer> {
	const poses = {
		head: { x: -10 * Math.PI / 180, y: -18 * Math.PI / 180, z: 3 * Math.PI / 180 },
		torso: { x: 0, y: -5 * Math.PI / 180, z: 0 },
		rightArm: { x: 5 * Math.PI / 180, y: 0, z: -10 * Math.PI / 180 },
		leftArm: { x: -5 * Math.PI / 180, y: 0, z: 10 * Math.PI / 180 },
	};
	return render3dModel({ skinBuffer, model, size, overlay, renderParts: ['head', 'torso', 'rightArm', 'leftArm'], poses });
}

/**
 * Renders a 3D full body.
 */
async function render3dFull(skinBuffer: Buffer, size = 128, overlay = true, model: 'steve' | 'alex' = 'steve'): Promise<Buffer> {
	const poses = {
		head: { x: 5 * Math.PI / 180, y: -10 * Math.PI / 180, z: -2 * Math.PI / 180 },
		torso: { x: 0, y: -5 * Math.PI / 180, z: 0 },
		rightArm: { x: 5 * Math.PI / 180, y: 0, z: -10 * Math.PI / 180 },
		leftArm: { x: -5 * Math.PI / 180, y: 0, z: 10 * Math.PI / 180 },
		rightLeg: { x: -22 * Math.PI / 180, y: 0, z: -2 * Math.PI / 180 },
		leftLeg: { x: 22 * Math.PI / 180, y: 0, z: 2 * Math.PI / 180 },
	};
	return render3dModel({ skinBuffer, model, size, overlay, renderParts: ['head', 'torso', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'], poses });
}

// ---------------------------------------------------------------------------
// WinterAvatarClient Class
// ---------------------------------------------------------------------------

/**
 * Main client class for rendering Minecraft skin avatars
 * 
 * @example
 * ```typescript
 * const client = new WinterAvatarClient();
 * await client.initialize();
 * const avatar = await client.render3dFull('Notch', 256);
 * ```
 */
export class WinterAvatar {
	private initialized = false;
	private renderCache = new Map<string, CacheEntry<Buffer>>();
	private readonly MAX_RENDER_CACHE = 500;
	private assetsDir: string;

	/**
	 * Creates a new WinterAvatarClient instance
	 * @param assetsDir - Custom directory for storing default skin assets (default: './assets')
	 */
	constructor(assetsDir?: string) {
		this.assetsDir = assetsDir || path.join(__dirname, '..', '..', 'assets');
	}

	/**
	 * Initializes the client and ensures default assets (steve and alex skins) exist.
	 * Downloads the skins if they are not present in the assets directory.
	 * @returns Promise that resolves when initialization is complete
	 * @throws {Error} If there's an error creating the assets directory
	 * @example
	 * ```typescript
	 * await client.initialize();
	 * ```
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		try {
			await fs.mkdir(this.assetsDir, { recursive: true });

			// Check for default Steve/Alex skins
			const stevePath = path.join(this.assetsDir, 'steve.png');
			const alexPath = path.join(this.assetsDir, 'alex.png');

			try {
				await fs.access(stevePath);
			} catch {
				console.log('[WinterAvatar] Steve skin missing, downloading...');
				try {
					const uuid = 'c06f89064c8a49119c29ea1dbd1aab82';
					const profile = await getProfileData(uuid);
					const buffer = await fetchSkinBuffer(profile.skinUrl);
					await fs.writeFile(stevePath, buffer);
				} catch (err) {
					console.error('[WinterAvatar] Failed to download Steve skin:', (err as Error).message);
				}
			}

			try {
				await fs.access(alexPath);
			} catch {
				console.log('[WinterAvatar] Alex skin missing, downloading...');
				try {
					const uuid = '6ab4317889fd490597f60f67d9d76fd9';
					const profile = await getProfileData(uuid);
					const buffer = await fetchSkinBuffer(profile.skinUrl);
					await fs.writeFile(alexPath, buffer);
				} catch (err) {
					console.error('[WinterAvatar] Failed to download Alex skin:', (err as Error).message);
				}
			}

			this.initialized = true;
			console.log('[WinterAvatar] Client initialized successfully');
		} catch (err) {
			console.error('[WinterAvatar] Initialization error:', err);
		}
	}

	/**
	 * Gets skin data for a username or UUID.
	 * @param username - Minecraft username or UUID
	 * @returns Promise resolving to skin data containing buffer and model type
	 * @throws {Error} If skin resolution fails and no fallback is available
	 * @example
	 * ```typescript
	 * const { buffer, model } = await client.getSkinData('Notch');
	 * ```
	 */
	async getSkinData(username: string): Promise<SkinData> {
		return getSkin(username);
	}

	/**
	 * Renders a 2D flat face/avatar from a Minecraft username or UUID.
	 * @param username - Minecraft username or UUID
	 * @param size - Output image size in pixels (default: 128)
	 * @param overlay - Whether to include the skin overlay layer (default: true)
	 * @returns Promise resolving to PNG image buffer
	 * @throws {Error} If rendering fails
	 * @example
	 * ```typescript
	 * const buffer = await client.render2dFace('Notch', 256, true);
	 * ```
	 */
	async render2dFace(username: string, size = 128, overlay = true): Promise<Buffer> {
		const cacheKey = `2d_face:${username.toLowerCase()}:${size}:${overlay}`;
		const cached = this.renderCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
			return cached.data;
		}

		const { buffer: skinBuffer, model } = await getSkin(username);
		const result = await render2dFace(skinBuffer, size, overlay);

		this._cacheRender(cacheKey, result);
		return result;
	}

	/**
	 * Renders a 2D flat bust (head, torso, and arms).
	 * @param username - Minecraft username or UUID
	 * @param size - Output image height in pixels (default: 128)
	 * @param overlay - Whether to include the skin overlay layer (default: true)
	 * @returns Promise resolving to PNG image buffer
	 * @throws {Error} If rendering fails
	 * @example
	 * ```typescript
	 * const buffer = await client.render2dBust('Notch', 256, true);
	 * ```
	 */
	async render2dBust(username: string, size = 128, overlay = true): Promise<Buffer> {
		const cacheKey = `2d_bust:${username.toLowerCase()}:${size}:${overlay}`;
		const cached = this.renderCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
			return cached.data;
		}

		const { buffer: skinBuffer, model } = await getSkin(username);
		const result = await render2dBust(skinBuffer, size, overlay, model);

		this._cacheRender(cacheKey, result);
		return result;
	}

	/**
	 * Renders a 2D flat full body.
	 * @param username - Minecraft username or UUID
	 * @param size - Output image height in pixels (default: 128)
	 * @param overlay - Whether to include the skin overlay layer (default: true)
	 * @returns Promise resolving to PNG image buffer
	 * @throws {Error} If rendering fails
	 * @example
	 * ```typescript
	 * const buffer = await client.render2dFull('Notch', 256, false);
	 * ```
	 */
	async render2dFull(username: string, size = 128, overlay = true): Promise<Buffer> {
		const cacheKey = `2d_full:${username.toLowerCase()}:${size}:${overlay}`;
		const cached = this.renderCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
			return cached.data;
		}

		const { buffer: skinBuffer, model } = await getSkin(username);
		const result = await render2dFull(skinBuffer, size, overlay, model);

		this._cacheRender(cacheKey, result);
		return result;
	}

	/**
	 * Renders a 3D isometric head.
	 * @param username - Minecraft username or UUID
	 * @param size - Output image size in pixels (default: 128)
	 * @param overlay - Whether to include the skin overlay layer (default: true)
	 * @returns Promise resolving to PNG image buffer
	 * @throws {Error} If rendering fails
	 * @example
	 * ```typescript
	 * const buffer = await client.render3dHead('Notch', 256, true);
	 * ```
	 */
	async render3dHead(username: string, size = 128, overlay = true): Promise<Buffer> {
		const cacheKey = `3d_head:${username.toLowerCase()}:${size}:${overlay}`;
		const cached = this.renderCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
			return cached.data;
		}

		const { buffer: skinBuffer, model } = await getSkin(username);
		const result = await render3dHead(skinBuffer, size, overlay, model);

		this._cacheRender(cacheKey, result);
		return result;
	}

	/**
	 * Renders a 3D isometric bust (head + torso + arms).
	 * @param username - Minecraft username or UUID
	 * @param size - Output image height in pixels (default: 128)
	 * @param overlay - Whether to include the skin overlay layer (default: true)
	 * @returns Promise resolving to PNG image buffer
	 * @throws {Error} If rendering fails
	 * @example
	 * ```typescript
	 * const buffer = await client.render3dBust('Notch', 256, true);
	 * ```
	 */
	async render3dBust(username: string, size = 128, overlay = true): Promise<Buffer> {
		const cacheKey = `3d_bust:${username.toLowerCase()}:${size}:${overlay}`;
		const cached = this.renderCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
			return cached.data;
		}

		const { buffer: skinBuffer, model } = await getSkin(username);
		const result = await render3dBust(skinBuffer, size, overlay, model);

		this._cacheRender(cacheKey, result);
		return result;
	}

	/**
	 * Renders a 3D isometric full body.
	 * @param username - Minecraft username or UUID
	 * @param size - Output image height in pixels (default: 128)
	 * @param overlay - Whether to include the skin overlay layer (default: true)
	 * @returns Promise resolving to PNG image buffer
	 * @throws {Error} If rendering fails
	 * @example
	 * ```typescript
	 * const buffer = await client.render3dFull('Notch', 512, true);
	 * ```
	 */
	async render3dFull(username: string, size = 128, overlay = true): Promise<Buffer> {
		const cacheKey = `3d_full:${username.toLowerCase()}:${size}:${overlay}`;
		const cached = this.renderCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
			return cached.data;
		}

		const { buffer: skinBuffer, model } = await getSkin(username);
		const result = await render3dFull(skinBuffer, size, overlay, model);

		this._cacheRender(cacheKey, result);
		return result;
	}

	/**
	 * Gets the raw skin texture buffer for a username.
	 * @param username - Minecraft username or UUID
	 * @returns Promise resolving to raw skin image buffer
	 * @throws {Error} If skin fetching fails
	 * @example
	 * ```typescript
	 * const skinBuffer = await client.getRawSkin('Notch');
	 * ```
	 */
	async getRawSkin(username: string): Promise<Buffer> {
		const { buffer } = await getSkin(username);
		return buffer;
	}

	/**
	 * Clears all memory caches (UUIDs, profiles, skins, and renders).
	 * Useful for freeing memory or forcing fresh data retrieval.
	 * @example
	 * ```typescript
	 * client.clearCaches();
	 * ```
	 */
	clearCaches(): void {
		memoryCache.uuids.clear();
		memoryCache.profiles.clear();
		memoryCache.skins.clear();
		this.renderCache.clear();
		console.log('[WinterAvatar] All caches cleared');
	}

	/**
	 * Internal method to cache a render result with LRU pruning.
	 */
	private _cacheRender(key: string, buffer: Buffer): void {
		this.renderCache.set(key, { data: buffer, timestamp: Date.now() });
		if (this.renderCache.size > this.MAX_RENDER_CACHE) {
			const keys = Array.from(this.renderCache.keys());
			const toRemove = keys.slice(0, Math.floor(this.MAX_RENDER_CACHE * 0.2));
			for (const k of toRemove) {
				this.renderCache.delete(k);
			}
		}
	}
}

// Export singleton instance
export const winterAvatar = new WinterAvatar();
