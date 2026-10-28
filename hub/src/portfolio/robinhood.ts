import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DATA } from '../paths.ts';

export class RobinhoodError extends Error {
  /** The sign-in is gone or refused, so polling should stop until the user connects again. */
  auth: boolean;
  /** The HTTP status, for the token endpoint: 400/401 mean the login itself was refused. */
  status?: number;

  constructor(message: string, auth = false, status?: number) {
    super(message);
    this.auth = auth;
    this.status = status;
  }
}

const endpoint = 'https://agent.robinhood.com/mcp/trading';
const registerURL = 'https://agent.robinhood.com/oauth/trading/register';
const authorizeURL = 'https://robinhood.com/oauth';
const tokenURL = 'https://api.robinhood.com/oauth2/token/';
/** The sign-in redirect lands on Mac Dash's loopback listener (the hub has no browser), which passes it on. */
export const redirectURI = 'http://127.0.0.1:47823/callback';

/**
 * The only tools Dash will ever call, for the page and the advisor. Anything else, including every
 * order tool, is refused (RobinhoodClient.readTools in the Mac app).
 */
export const readTools = new Set([
  // Account and positions
  'get_accounts', 'get_portfolio', 'get_equity_positions', 'get_crypto_positions', 'get_option_positions',
  'get_realized_pnl', 'get_pnl_trade_history', 'get_equity_tax_lots',
  // Prices and history
  'get_equity_quotes', 'get_equity_historicals', 'get_crypto_quotes', 'get_indexes', 'get_index_quotes',
  'get_index_historicals', 'get_equity_technical_indicators',
  // Research
  'get_equity_fundamentals', 'get_financials', 'get_equity_analyst_ratings', 'get_earnings_calendar',
  'get_earnings_results', 'get_sec_filing', 'get_sec_filing_index', 'get_sec_filing_facts', 'get_sec_filing_facts_catalog',
  // Options research (reading chains and quotes only)
  'get_option_chains', 'get_option_instruments', 'get_option_quotes',
]);

/**
 * Belt and braces: every Robinhood read tool starts with "get_" and none of its write tools do, and
 * nothing about orders or trade approvals is read either.
 */
export function isReadOnly(tool: string) {
  const lower = tool.toLowerCase();
  return readTools.has(tool) && lower.startsWith('get_') && !['order', 'approval'].some((word) => lower.includes(word));
}

type Tokens = { access: string; refresh?: string; expires?: string };
type Pending = { verifier: string; state: string; clientID: string; expires: number };

const secretsDir = join(DATA, 'secrets');
const tokensFile = join(secretsDir, 'robinhood.json');
const clientFile = join(secretsDir, 'robinhood-client.json');

/**
 * The hub's read-only connection to Robinhood's official MCP server (agent.robinhood.com/mcp/trading),
 * ported from RobinhoodClient.swift. It signs in with MCP OAuth (dynamic client registration + PKCE;
 * tokens in a file only the user's account can read) and calls tools over streamable HTTP, so live prices
 * never go through Claude. `call` refuses every tool not on the read-only allowlist before any request.
 */
export class RobinhoodClient {
  private tokens?: Tokens;
  private sessionID?: string;
  private nextID = 1;
  private pending?: Pending;
  private definitions?: Record<string, unknown>[];
  /** A renewal in progress. Everyone who hits an expired token waits for the same one. */
  private refreshing?: Promise<void>;

  constructor() {
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    this.tokens = readJSON<Tokens>(tokensFile);
  }

  get isConnected() {
    return !!this.tokens;
  }

  /** Calls a read-only tool and returns its text content. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    if (!isReadOnly(tool)) throw new RobinhoodError(`Dash only reads from Robinhood; ${tool} isn't allowed.`);
    const result = await this.rpc('tools/call', { name: tool, arguments: args });
    const text = ((result.content ?? []) as { text?: string }[]).map((block) => block.text ?? '').join('\n');
    if (result.isError) throw new RobinhoodError(text || `${tool} failed.`);
    return text;
  }

  /** Definitions of just the read-only tools, as the advisor's relay offers them to Claude. */
  async readToolDefinitions(): Promise<Record<string, unknown>[]> {
    if (!this.definitions) {
      const tools = ((await this.rpc('tools/list', {})).tools ?? []) as Record<string, unknown>[];
      this.definitions = tools.filter((tool) => isReadOnly(String(tool.name ?? '')));
    }
    return this.definitions;
  }

  disconnect() {
    this.tokens = undefined;
    this.sessionID = undefined;
    rmSync(tokensFile, { force: true });
  }

  // Streamable HTTP MCP

  private async rpc(method: string, params: Record<string, unknown>, retried = false): Promise<any> {
    if (!this.tokens) throw new RobinhoodError("Robinhood isn't connected. Connect it from Portfolio in Dash on the Mac.", true);
    const used = this.tokens.access;
    try {
      // The handshake is inside the try too: after a restart it's the first request, so it's the one
      // that finds an expired token.
      if (!this.sessionID && method !== 'initialize') await this.initialize();
      return await this.post(method, params);
    } catch (error) {
      if (error === UNAUTHORIZED) {
        if (retried) throw new RobinhoodError('Robinhood refused the renewed sign-in. Connect again from Portfolio in Dash on the Mac.', true);
        // Someone else may have renewed it while this request was out; only renew if it's still the old token.
        if (this.tokens?.access === used) await this.refresh();
        this.sessionID = undefined;
        return this.rpc(method, params, true);
      }
      if (error === SESSION_EXPIRED && !retried) {
        this.sessionID = undefined;
        return this.rpc(method, params, true);
      }
      if (error === SESSION_EXPIRED) throw new RobinhoodError('Robinhood keeps ending the session. Try again in a minute.');
      throw error;
    }
  }

  private async initialize() {
    await this.post('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dash-hub', version: '1' } });
    await this.post('notifications/initialized', undefined).catch(() => {});
  }

  /** One JSON-RPC message. Notifications (no params) expect no result. */
  private async post(method: string, params: Record<string, unknown> | undefined): Promise<any> {
    if (!this.tokens) throw new RobinhoodError("Robinhood isn't connected.", true);
    const id = this.nextID;
    const message: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params) {
      message.id = id;
      message.params = params;
      this.nextID += 1;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.tokens.access}`,
    };
    if (this.sessionID) {
      headers['Mcp-Session-Id'] = this.sessionID;
      headers['MCP-Protocol-Version'] = '2025-06-18';
    }
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(30_000) });
    if (response.status === 401) throw UNAUTHORIZED;
    if (response.status === 404 && this.sessionID) throw SESSION_EXPIRED;
    const body = await response.text();
    if (!response.ok) throw new RobinhoodError(`Robinhood returned ${response.status}: ${body.slice(0, 300)}`);
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionID = session;
    if (!params) return {};
    // The reply is plain JSON or a short SSE stream whose "data:" lines carry the message.
    const candidates = (response.headers.get('content-type') ?? '').includes('event-stream')
      ? body.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5))
      : [body];
    for (const candidate of candidates) {
      let json: any;
      try {
        json = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (json.id !== id) continue;
      if (json.error) throw new RobinhoodError(json.error.message ?? 'Robinhood error');
      return json.result ?? {};
    }
    throw new RobinhoodError(`Robinhood sent no reply to ${method}.`);
  }

  // OAuth, in two steps because the browser and its redirect are on the Mac

  /** Step 1: the sign-in page to open. Mac Dash opens it and catches the redirect on 127.0.0.1:47823. */
  async startConnect(): Promise<{ url: string; state: string }> {
    const clientID = await this.registeredClientID();
    const verifier = randomString(64);
    const state = randomString(24);
    this.pending = { verifier, state, clientID, expires: Date.now() + 10 * 60_000 };
    const url = new URL(authorizeURL);
    for (const [key, value] of Object.entries({
      response_type: 'code', client_id: clientID, redirect_uri: redirectURI,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      state, scope: 'internal', resource: endpoint,
    })) url.searchParams.set(key, value);
    return { url: url.toString(), state };
  }

  /** Step 2: the redirect's query, passed on by Mac Dash. Trades the code for tokens. */
  async finishConnect(query: Record<string, string>) {
    const pending = this.pending;
    this.pending = undefined;
    if (query.error) throw new RobinhoodError(`Robinhood sign-in: ${query.error_description ?? query.error}`, true);
    if (!pending || Date.now() > pending.expires || query.state !== pending.state || !query.code) {
      throw new RobinhoodError("The sign-in reply didn't match this request. Try Connect again.", true);
    }
    await this.exchange({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectURI,
                          client_id: pending.clientID, code_verifier: pending.verifier, resource: endpoint });
    this.sessionID = undefined;
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.renew().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /**
   * Trades the refresh token for a new access token. Only Robinhood refusing the refresh token signs
   * the user out; a network problem leaves the login in place to try again on the next request.
   */
  private async renew() {
    const clientID = readJSON<{ id: string }>(clientFile)?.id;
    if (!this.tokens?.refresh || !clientID) {
      this.disconnect();
      throw new RobinhoodError('Your Robinhood session ended. Connect again from Portfolio in Dash on the Mac.', true);
    }
    try {
      await this.exchange({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh, client_id: clientID, resource: endpoint });
    } catch (error) {
      const status = error instanceof RobinhoodError ? error.status : undefined;
      if (status === 400 || status === 401) {
        this.disconnect();
        throw new RobinhoodError('Your Robinhood session ended. Connect again from Portfolio in Dash on the Mac.', true);
      }
      throw new RobinhoodError(`Couldn't reach Robinhood to renew the sign-in: ${(error as Error).message}`);
    }
  }

  private async exchange(form: Record<string, string>) {
    const response = await fetch(tokenURL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    if (response.status !== 200 || typeof json?.access_token !== 'string') {
      throw new RobinhoodError(`Robinhood sign-in: ${text.slice(0, 300)}`, true, response.status);
    }
    this.tokens = {
      access: json.access_token, refresh: json.refresh_token ?? this.tokens?.refresh,
      ...(typeof json.expires_in === 'number' ? { expires: new Date(Date.now() + json.expires_in * 1000).toISOString() } : {}),
    };
    writeSecret(tokensFile, this.tokens);
  }

  /** Registers the hub as an OAuth client once; the client id isn't secret. */
  private async registeredClientID(): Promise<string> {
    const saved = readJSON<{ id: string }>(clientFile)?.id;
    if (saved) return saved;
    const response = await fetch(registerURL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ client_name: 'Dash', redirect_uris: [redirectURI], grant_types: ['authorization_code', 'refresh_token'],
                             response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'internal' }),
    });
    const text = await response.text();
    let id: string | undefined;
    try {
      id = JSON.parse(text).client_id;
    } catch {}
    if (!response.ok || !id) throw new RobinhoodError(`Couldn't register Dash with Robinhood: ${text.slice(0, 300)}`, true);
    writeSecret(clientFile, { id });
    return id;
  }
}

const UNAUTHORIZED = new Error('unauthorized');
const SESSION_EXPIRED = new Error('session expired');

function readJSON<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Written to a temporary file and renamed into place, so a crash mid-write never leaves half a token. */
function writeSecret(file: string, value: unknown) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  chmodSync(file, 0o600);
}

function base64url(bytes: Buffer) {
  return bytes.toString('base64url');
}

function randomString(length: number) {
  return randomBytes(length).toString('base64url').slice(0, length);
}
