import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { promisify } from 'node:util';
import qrcode from 'qrcode-terminal';

import { ADMIN_SOCKET } from './paths.ts';

/**
 * `npm run pair`: asks the running hub for a pairing code and prints it with a QR code, for pairing the
 * first device (Mac Dash) over SSH. After that, Mac Dash's Settings pairs phones. The code is for a Mac;
 * `npm run pair -- phone` makes one for a phone instead.
 */
async function pair(role: 'mac' | 'phone') {
  const reply = await new Promise<{ code: string; expires: string }>((resolve, reject) => {
    const call = request({ socketPath: ADMIN_SOCKET, path: `/pair?role=${role}`, method: 'POST' }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(JSON.parse(body)));
    });
    call.on('error', () => reject(new Error("The hub isn't running. Start it with: systemctl --user start dash-hub")));
    call.end();
  });
  const url = await hubURL();
  console.log(`Pairing code ${reply.code} for a ${role === 'mac' ? 'Mac' : 'phone'} (good for 5 minutes, one use)`);
  if (url) {
    console.log(`Hub address ${url}\n`);
    qrcode.generate(JSON.stringify({ v: 1, url, code: reply.code }), { small: true });
  }
}

/** wss://dash-hub.tailnet.ts.net, from Tailscale's name for this machine. */
async function hubURL(): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)('tailscale', ['status', '--json']);
    const name = String(JSON.parse(stdout).Self?.DNSName ?? '').replace(/\.$/, '');
    return name ? `wss://${name}` : undefined;
  } catch {
    return undefined;
  }
}

const command = process.argv[2];
if (command === 'pair' && [undefined, 'mac', 'phone'].includes(process.argv[3])) {
  pair(process.argv[3] === 'phone' ? 'phone' : 'mac').catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  console.error('Usage: node src/cli.ts pair [mac|phone]');
  process.exit(2);
}
