import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { isReadOnly, type RobinhoodClient } from './robinhood.ts';

/**
 * A minimal MCP server on 127.0.0.1 that gives the advisor chat Robinhood's read-only tools (ported
 * from RobinhoodRelay.swift). Claude Code connects over HTTP; every call goes through the hub's own
 * RobinhoodClient, so the login never leaves the hub and the order tools don't exist as far as Claude
 * can tell. A random secret per start keeps other local programs out.
 */
export class RobinhoodRelay {
  private server?: Server;
  private port = 0;
  private readonly secret = randomBytes(32).toString('hex');
  private readonly client: RobinhoodClient;

  constructor(client: RobinhoodClient) {
    this.client = client;
  }

  /** Starts listening on a free local port (once) and returns the `--mcp-config` entry. */
  async start(): Promise<Record<string, unknown>> {
    if (!this.server) {
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', async () => {
          const [status, reply] = await this.handle(request.method ?? '', request.headers.authorization, body);
          response.writeHead(status, reply ? { 'content-type': 'application/json' } : {});
          response.end(reply ? JSON.stringify(reply) : undefined);
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      this.port = (server.address() as { port: number }).port;
      this.server = server;
    }
    return { type: 'http', url: `http://127.0.0.1:${this.port}/mcp`, headers: { Authorization: `Bearer ${this.secret}` } };
  }

  stop() {
    this.server?.close();
    this.server = undefined;
  }

  private async handle(method: string, authorization: string | undefined, body: string): Promise<[number, unknown?]> {
    if (authorization !== `Bearer ${this.secret}`) return [401];
    // No server-to-client stream: Claude Code's optional GET is declined.
    if (method !== 'POST') return [405];
    let message: any;
    try {
      message = JSON.parse(body);
    } catch {
      return [400];
    }
    if (message.id === undefined) return [202]; // a notification
    const params = message.params ?? {};
    const reply = (result: unknown): [number, unknown] => [200, { jsonrpc: '2.0', id: message.id, result }];
    const failure = (text: string) => reply({ content: [{ type: 'text', text }], isError: true });

    switch (message.method) {
      case 'initialize':
        return reply({ protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
                       serverInfo: { name: 'dash-robinhood-readonly', version: '1' } });
      case 'ping':
        return reply({});
      case 'tools/list':
        try {
          return reply({ tools: await this.client.readToolDefinitions() });
        } catch (error) {
          return [200, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: (error as Error).message } }];
        }
      case 'tools/call': {
        const name = String(params.name ?? '');
        if (!isReadOnly(name)) return failure(`Dash only reads from Robinhood; ${name} isn't available.`);
        try {
          return reply({ content: [{ type: 'text', text: await this.client.call(name, params.arguments ?? {}) }] });
        } catch (error) {
          return failure((error as Error).message);
        }
      }
      default:
        return [200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }];
    }
  }
}
