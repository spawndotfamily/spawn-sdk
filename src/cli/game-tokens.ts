import { PublishCliError, PROJECT_ID_PATTERN, isRecord, requestJson, validatePublishConfig } from './api.ts';
import type { PublishConfig, FetchLike } from './api.ts';

export const TOKEN_USAGE = `  spawn-publish token search <name-or-contract-address> --credentials <file>
  spawn-publish token get --credentials <file>
  spawn-publish token configure <name-or-contract-address> <entry-amount> --version <settings-version> --credentials <file>
Token search uses Spawn's admitted testnet assets. Configuration writes require a newly downloaded token:configure credential.`;

export const SPAWN_TOKEN_CHAIN_ID = 46630;
const LOCAL_TEST_CHAIN_ID = 31337;
const TOKEN_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const DECIMAL_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const UINT256_MAX = (1n << 256n) - 1n;

export type GameTokenAsset = {
  id: string;
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  image: string | null;
  source: 'spawn' | 'partner';
  enabled: boolean;
};

export type GameTokenSettings = {
  projectId: string;
  version: number;
  asset: GameTokenAsset;
  entryAmount: string;
};

export type TokenCommand =
  | { kind: 'token'; action: 'search'; credentialsPath: string; query: string }
  | { kind: 'token'; action: 'get'; credentialsPath: string }
  | { kind: 'token'; action: 'configure'; credentialsPath: string; selector: string; amount: string; version: number };

function fail(message: string): never {
  throw new PublishCliError(message);
}

function cleanText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`Spawn returned an invalid token ${label}.`);
  }
  return value;
}

function normalizeSelector(value: unknown): string {
  if (typeof value !== 'string') fail('Provide a token name or contract address.');
  const query = value.trim();
  if (query.length === 0 || query.length > 80 || /[\u0000-\u001f\u007f]/.test(query)) fail('Token search must be 1–80 printable characters.');
  if (/^0x/i.test(query) && !TOKEN_ADDRESS_PATTERN.test(query)) fail('A token contract address must be a 0x-prefixed 40-character EVM address.');
  return query;
}

function validateAmountSyntax(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !DECIMAL_AMOUNT_PATTERN.test(value)) {
    fail('Entry amount must be a nonnegative decimal string without a sign or exponent.');
  }
  return value;
}

function parseVersion(value: string | undefined): number {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) fail('Provide --version from token get as a nonnegative integer.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail('--version must be a nonnegative safe integer.');
  return parsed;
}

export function parseTokenCommand(argv: string[], credentialsPath?: string): TokenCommand {
  if (!credentialsPath) fail('Token commands require --credentials with the downloaded creator file.');
  const [group, action, ...args] = argv;
  if (group !== 'token') fail('Use token search, get or configure.');
  if (action === 'search' && args.length === 1 && !args[0].startsWith('-')) {
    return { kind: 'token', action, credentialsPath, query: normalizeSelector(args[0]) };
  }
  if (action === 'get' && args.length === 0) return { kind: 'token', action, credentialsPath };
  if (action !== 'configure') fail('Use token search <name-or-address>, token get, or token configure <name-or-address> <entry-amount> --version <settings-version>.');

  const positional: string[] = [];
  let version: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--version' || arg.startsWith('--version=')) {
      if (version !== undefined) fail('Duplicate --version option.');
      if (arg === '--version') {
        version = args[index + 1];
        if (!version) fail('--version requires a value.');
        index += 1;
      } else {
        version = arg.slice('--version='.length);
      }
    } else if (arg.startsWith('-')) {
      fail('Unsupported token option.');
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) fail('Use token configure <name-or-address> <entry-amount> --version <settings-version>.');
  const selector = normalizeSelector(positional[0]);
  const amount = validateAmountSyntax(positional[1]);
  return { kind: 'token', action, credentialsPath, selector, amount, version: parseVersion(version) };
}

function loopbackApi(config: PublishConfig): boolean {
  const hostname = new URL(config.apiUrl).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function validateChainId(value: unknown, config: PublishConfig): number {
  const chainId = value;
  if (!Number.isSafeInteger(chainId) || Number(chainId) <= 0) fail('Spawn returned an invalid token network.');
  if (chainId === SPAWN_TOKEN_CHAIN_ID) return SPAWN_TOKEN_CHAIN_ID;
  if (chainId === LOCAL_TEST_CHAIN_ID && loopbackApi(config)) return LOCAL_TEST_CHAIN_ID;
  fail(`Spawn returned an unsupported token network. Hosted configuration requires chain ${SPAWN_TOKEN_CHAIN_ID}; chain ${LOCAL_TEST_CHAIN_ID} is local-test only.`);
}

function expectedAssetId(chainId: number, address: string): string {
  return `erc20:${chainId}:${address.toLowerCase()}`;
}

function validateAsset(value: unknown, expectedChainId: number, config: PublishConfig): GameTokenAsset {
  if (!isRecord(value) || Array.isArray(value)) fail('Spawn returned an invalid token asset.');
  const address = cleanText(value.address, 'address', 42);
  if (!TOKEN_ADDRESS_PATTERN.test(address)) fail('Spawn returned an invalid token address.');
  const chainId = validateChainId(value.chainId, config);
  if (chainId !== expectedChainId) fail('Spawn returned token assets from inconsistent networks.');
  const id = cleanText(value.id, 'asset ID', 128);
  if (id !== expectedAssetId(chainId, address)) fail('Spawn returned a token asset ID that does not match its address.');
  if (!Number.isInteger(value.decimals) || Number(value.decimals) < 0 || Number(value.decimals) > 18) fail('Spawn returned invalid token decimals.');
  if (value.source !== 'spawn' && value.source !== 'partner') fail('Spawn returned a token outside its admitted asset sources.');
  if (typeof value.enabled !== 'boolean') fail('Spawn returned an invalid token enablement state.');
  let image: string | null;
  if (value.image === null || value.image === '') image = value.image;
  else image = cleanText(value.image, 'image', 2048);
  return {
    id,
    chainId,
    address,
    name: cleanText(value.name, 'name', 120),
    symbol: cleanText(value.symbol, 'symbol', 32),
    decimals: Number(value.decimals),
    image,
    source: value.source,
    enabled: value.enabled,
  };
}

function tokenCatalog(value: unknown, config: PublishConfig): { chainId: number; items: GameTokenAsset[] } {
  if (!isRecord(value) || Array.isArray(value) || !Array.isArray(value.items) || value.items.length > 100) fail('Spawn returned an invalid token list.');
  const chainId = validateChainId(value.chainId, config);
  return { chainId, items: value.items.map(item => validateAsset(item, chainId, config)) };
}

function validBaseUnits(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value) || value.length > 78 || BigInt(value) > UINT256_MAX) {
    fail('Spawn returned an invalid token entry amount in base units.');
  }
  return value;
}

function tokenSettings(value: unknown, config: PublishConfig, allowUnconfigured = false): { settings: GameTokenSettings | null } {
  if (!isRecord(value) || Array.isArray(value)) fail('Spawn returned invalid token settings.');
  if (value.settings === null && allowUnconfigured) return { settings: null };
  if (!isRecord(value.settings) || Array.isArray(value.settings)) fail('Spawn returned invalid token settings.');
  const settings = value.settings;
  const projectId = cleanText(settings.projectId, 'project ID', 64);
  if (!PROJECT_ID_PATTERN.test(projectId) || projectId !== config.projectId) fail('Spawn returned token settings for a different project.');
  if (!Number.isSafeInteger(settings.version) || Number(settings.version) < 0) fail('Spawn returned an invalid token settings version.');
  if (!isRecord(settings.asset) || Array.isArray(settings.asset)) fail('Spawn returned token settings without a selected asset.');
  const chainId = validateChainId(settings.asset.chainId, config);
  const asset = validateAsset(settings.asset, chainId, config);
  return {
    settings: {
      projectId,
      version: Number(settings.version),
      asset,
      entryAmount: validBaseUnits(settings.entryAmount),
    },
  };
}

function decimalToBaseUnits(value: string, decimals: number): string {
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) fail(`Entry amount has more than ${decimals} decimal places for this token.`);
  const factor = 10n ** BigInt(decimals);
  const baseUnits = BigInt(whole) * factor + BigInt((fraction + '0'.repeat(decimals - fraction.length)) || '0');
  if (baseUnits > UINT256_MAX) fail('Entry amount exceeds the supported token amount limit.');
  return baseUnits.toString();
}

function resolveAsset(catalog: { chainId: number; items: GameTokenAsset[] }, selector: string): GameTokenAsset {
  let matches: GameTokenAsset[];
  if (/^0x/i.test(selector)) {
    matches = catalog.items.filter(asset => asset.address.toLowerCase() === selector.toLowerCase());
  } else {
    const expectedName = selector.toLocaleLowerCase('en-US');
    matches = catalog.items.filter(asset => asset.name.toLocaleLowerCase('en-US') === expectedName);
  }
  if (matches.length === 0) fail('No admitted Spawn token matches that name or contract address.');
  if (matches.length > 1) fail('That token name is ambiguous. Search the list and configure it by contract address.');
  if (!matches[0].enabled) fail('That Spawn token is not currently enabled for game entry.');
  return matches[0];
}

export async function runTokenCommand(
  inputConfig: PublishConfig,
  command: TokenCommand,
  fetchImplementation: FetchLike,
): Promise<{ chainId: number; items: GameTokenAsset[] } | { settings: GameTokenSettings | null }> {
  const config = validatePublishConfig(inputConfig);
  const base = `${config.apiUrl}/api/v1/publish/${config.projectId}`;
  if (command.action === 'configure' && !config.scopes?.includes('token:configure')) {
    fail('This credential file does not grant token:configure. Download new scoped credentials from Spawn.');
  }
  if (command.action === 'get' && config.scopes && !config.scopes.includes('build:read') && !config.scopes.includes('token:configure')) {
    fail('Token settings reads require build:read. Download a credential with read access from Spawn.');
  }

  if (command.action === 'get') {
    const response = await requestJson(config, `${base}/token`, {
      method: 'GET', headers: { Authorization: `Bearer ${config.publishKey}` },
    }, fetchImplementation, 'token');
    return tokenSettings(response, config, true);
  }

  if (command.action === 'search') {
    const url = `${config.apiUrl}/api/v1/game-tokens?q=${encodeURIComponent(command.query)}`;
    const response = await requestJson(config, url, { method: 'GET' }, fetchImplementation, 'token-list');
    const catalog = tokenCatalog(response, config);
    return { chainId: catalog.chainId, items: catalog.items.filter(item => item.enabled) };
  }

  const url = `${config.apiUrl}/api/v1/game-tokens?q=${encodeURIComponent(command.selector)}`;
  const searchResponse = await requestJson(config, url, { method: 'GET' }, fetchImplementation, 'token-list');
  const asset = resolveAsset(tokenCatalog(searchResponse, config), command.selector);
  const entryAmount = decimalToBaseUnits(command.amount, asset.decimals);
  const response = await requestJson(config, `${base}/token`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${config.publishKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: command.version, assetId: asset.id, entryAmount }),
  }, fetchImplementation, 'token');
  return tokenSettings(response, config);
}
