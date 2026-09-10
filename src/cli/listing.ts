import { readBoundedFile } from './files.ts';
import { PublishCliError, PROJECT_ID_PATTERN, isRecord, requestJson, validatePublishConfig } from './api.ts';
import type { PublishConfig, FetchLike } from './api.ts';

export const MAX_IMAGE_BYTES = 1_048_576;
const MAX_PATCH_BYTES = 32_768;
const FIELDS: Record<string, [number, number]> = {
  name: [1, 60], description: [0, 500], genre: [0, 32], controls: [0, 120], instructions: [0, 1500],
};
export const LISTING_USAGE = `  spawn-publish listing get --credentials <file>
  spawn-publish listing update <patch.json> --credentials <file>
  spawn-publish image add <image-file> --expected-version <integer> --alt <text> --credentials <file>
  spawn-publish image replace <image-id> <image-file> --expected-version <integer> --alt <text> --credentials <file>
  spawn-publish image remove <image-id> --expected-version <integer> --credentials <file>
Listing commands require platform endpoint availability. Metadata edits do not publish a game.`;
export type ListingCommand = {
  kind: 'listing';
  action: 'get' | 'update' | 'add' | 'replace' | 'remove';
  credentialsPath: string;
  file?: string;
  imageId?: string;
  expectedVersion?: number;
  alt?: string;
};

function fail(message: string): never { throw new PublishCliError(message); }
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('expectedVersion must be a nonnegative safe integer.');
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) fail('An image ID must be a UUID.');
  return value;
}
function textField(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || (min > 0 && !value.trim())) {
    fail(`${name} must contain ${min}–${max} characters.`);
  }
  return value;
}

export function parseListingCommand(argv: string[], credentialsPath?: string): ListingCommand {
  if (!credentialsPath) fail('Listing commands require --credentials with the downloaded creator file.');
  const [group, action, ...args] = argv;
  if (group === 'listing') {
    if (action === 'get' && args.length === 0) return { kind: 'listing', action, credentialsPath };
    if (action === 'update' && args.length === 1 && !args[0].startsWith('-')) {
      return { kind: 'listing', action, credentialsPath, file: args[0] };
    }
    fail('Use listing get or listing update <patch.json>.');
  }
  if (group !== 'image' || !['add', 'replace', 'remove'].includes(action)) fail('Use image add, replace or remove.');
  const positional: string[] = [], flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (!['--expected-version', '--alt'].includes(arg) || flags.has(arg) || args[i + 1] === undefined) fail('Invalid or duplicate image option.');
      flags.set(arg, args[++i]);
    } else positional.push(arg);
  }
  const expected = flags.get('--expected-version');
  if (!expected || !/^(0|[1-9][0-9]*)$/.test(expected)) fail('--expected-version requires a nonnegative integer from listing get.');
  const expectedVersion = version(Number(expected));
  const count = action === 'replace' ? 2 : 1;
  if (positional.length !== count) fail('Incorrect number of image arguments.');
  const imageId = action === 'add' ? undefined : uuid(positional[0]);
  if (action === 'remove') {
    if (flags.has('--alt')) fail('image remove does not accept --alt.');
    return { kind: 'listing', action, credentialsPath, imageId, expectedVersion };
  }
  const alt = textField(flags.get('--alt'), 'alt', 0, 160);
  return { kind: 'listing', action: action as 'add' | 'replace', credentialsPath, imageId,
    expectedVersion, alt, file: positional[action === 'replace' ? 1 : 0] };
}

function validatePatch(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) fail('The listing patch must be a JSON object.');
  const allowed = new Set(['expectedVersion', ...Object.keys(FIELDS), 'modes', 'coverImageId']);
  if (Object.keys(value).some(key => !allowed.has(key))) fail('The listing patch contains an unsupported field.');
  const patch: Record<string, unknown> = { expectedVersion: version(value.expectedVersion) };
  for (const [name, [min, max]] of Object.entries(FIELDS)) {
    if (Object.hasOwn(value, name)) patch[name] = textField(value[name], name, min, max);
  }
  if (Object.hasOwn(value, 'modes')) {
    if (!Array.isArray(value.modes) || value.modes.length > 8) fail('modes must be an array of at most 8 strings.');
    patch.modes = value.modes.map(mode => textField(mode, 'mode', 1, 40));
  }
  if (Object.hasOwn(value, 'coverImageId')) patch.coverImageId = value.coverImageId === null ? null : uuid(value.coverImageId);
  if (Object.keys(patch).length === 1) fail('The listing patch must include at least one editable field.');
  return patch;
}

async function imageData(file: string): Promise<string> {
  const bytes = await readBoundedFile(file, MAX_IMAGE_BYTES);
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  const ascii = (from: number, to: number) => new TextDecoder().decode(bytes.slice(from, to));
  const png = starts(137, 80, 78, 71, 13, 10, 26, 10);
  const jpeg = starts(255, 216, 255);
  const webp = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) fail('Images must be JPEG, PNG or WebP. The platform validates and normalizes image contents.');
  const buffer = (globalThis as unknown as { Buffer: { from(value: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  return buffer.from(bytes).toString('base64');
}

function publicListing(value: Record<string, unknown>): Record<string, unknown> {
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 0 || !Array.isArray(value.images) || value.images.length > 8) fail('Spawn returned an invalid listing response.');
  const { expectedVersion: _, ...fields } = validatePatch({ expectedVersion: value.version,
    ...Object.fromEntries([...Object.keys(FIELDS), 'modes', 'coverImageId'].map(key => [key, value[key]])) });
  const images = value.images.map(image => {
    if (!isRecord(image)) fail('Spawn returned an invalid listing image.');
    return { id: uuid(image.id), url: textField(image.url, 'image URL', 1, 2048), alt: textField(image.alt, 'alt', 0, 160) };
  });
  return { version: value.version, ...fields, images };
}

export async function runListingCommand(inputConfig: PublishConfig, command: ListingCommand, fetchImplementation: FetchLike): Promise<Record<string, unknown>> {
  const config = validatePublishConfig(inputConfig);
  const mutation = command.action !== 'get';
  if (mutation && !config.scopes?.includes('listing:write')) fail('This credential file does not grant listing:write. Download new scoped credentials from Spawn.');
  if (!mutation && config.scopes && !config.scopes.includes('build:read')) fail('Listing reads require build:read.');
  const base = `${config.apiUrl}/api/v1/publish/${config.projectId}`;
  let method = 'GET', path = '/listing', body: Record<string, unknown> | undefined;
  if (command.action === 'update') {
    let patch: unknown;
    try { patch = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedFile(command.file!, MAX_PATCH_BYTES))); }
    catch (error) { if (error instanceof PublishCliError) throw error; fail('The listing patch must contain valid UTF-8 JSON.'); }
    body = validatePatch(patch); method = 'PATCH';
  } else if (mutation) {
    path = '/media' + (command.imageId ? `/${uuid(command.imageId)}` : '');
    method = command.action === 'add' ? 'POST' : command.action === 'replace' ? 'PUT' : 'DELETE';
    body = { expectedVersion: version(command.expectedVersion) };
    if (command.action !== 'remove') { body.data = await imageData(command.file!); body.alt = textField(command.alt, 'alt', 0, 160); }
  }
  const response = await requestJson(config, base + path, {
    method, headers: { Authorization: `Bearer ${config.publishKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, fetchImplementation, true);
  return publicListing(response);
}
