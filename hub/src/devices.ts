import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { log } from './log.ts';
import { paths } from './paths.ts';

/** A phone, or Mac Dash, which can also pair other devices and relays lecture recording. */
export type Role = 'phone' | 'mac';

export type Device = {
  id: string;
  name: string;
  role: Role;
  tokenHash: string;
  paired: string;
  lastSeen?: string;
};

/** Why a pairing attempt failed; the server words it for the app. */
export type PairFailure = 'no-code' | 'wrong' | 'role';

/**
 * Devices paired with the hub (ported from HubDevices.swift; same rules, same file format plus `role`).
 * Pairing takes a 6-digit code (good for 5 minutes, one use) and hands the device a long random token.
 * Only a SHA-256 of each token is saved, in a file only the user's account can read, so the file alone can't
 * sign anyone in.
 *
 * A code is issued for one role, and the device gets that role, never one it asks for: a code from
 * "Pair a Phone" can't make a Mac (which can pair and remove devices and connect Robinhood). Wrong
 * guesses are limited per connection (the server closes it after a few), and the code itself is only
 * voided after many, so one stranger can't cancel the user's code with five quick guesses, and guessing a
 * million-to-one code inside its 5 minutes stays hopeless.
 */
export class Devices {
  static readonly codeLifetime = 5 * 60_000;
  /** Wrong guesses, from all connections together, before the code stops working. */
  private static readonly maxWrongTries = 30;

  devices: Device[] = [];
  private code?: string;
  private codeRole: Role = 'phone';
  private expires = 0;
  private wrongTries = 0;
  private listeners = new Set<() => void>();
  private readonly file: string;

  constructor(file = paths.devices) {
    this.file = file;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Device>[];
      // Files from the Mac's hub have no role; everything paired there was a phone.
      this.devices = saved.map((device) => ({ role: 'phone', ...device }) as Device);
    } catch {
      this.devices = [];
    }
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  /** Shows a fresh code for pairing a device of `role`; any earlier one stops working. */
  startPairing(role: Role): { code: string; expires: Date; role: Role } {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.codeRole = role;
    this.expires = Date.now() + Devices.codeLifetime;
    this.wrongTries = 0;
    return { code: this.code, expires: new Date(this.expires), role };
  }

  /**
   * Trades a valid code for a new device and its token (returned only this once). `asked` is the role
   * the app says it is (the phone app sends none). A device is a Mac only if both the code and the app
   * say so: anything else with a Mac code pairs as a phone, and a Mac with a phone code is refused, the
   * code kept for the phone it was meant for.
   */
  pair(code: string, name: string, asked?: Role): { device: Device; token: string } | PairFailure {
    if (!this.code || Date.now() >= this.expires) {
      this.code = undefined;
      return 'no-code';
    }
    if (!sameCode(code, this.code)) {
      this.wrongTries += 1;
      if (this.wrongTries >= Devices.maxWrongTries) this.code = undefined;
      return 'wrong';
    }
    if (asked === 'mac' && this.codeRole !== 'mac') return 'role';
    const role: Role = asked === 'mac' ? 'mac' : 'phone';
    this.code = undefined;
    const token = randomBytes(32).toString('base64url');
    const trimmed = name.trim().slice(0, 60);
    const now = new Date().toISOString();
    const device: Device = { id: randomUUID(), name: trimmed || (role === 'mac' ? 'Mac' : 'Phone'), role,
                             tokenHash: hash(token), paired: now, lastSeen: now };
    this.devices.push(device);
    this.save();
    return { device, token };
  }

  find(token: string): Device | undefined {
    const tokenHash = hash(token);
    return this.devices.find((device) => device.tokenHash === tokenHash);
  }

  markSeen(id: string) {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (!device) return;
    device.lastSeen = new Date().toISOString();
    this.save(false);
  }

  remove(id: string) {
    this.devices = this.devices.filter((device) => device.id !== id);
    this.save();
  }

  private save(notify = true) {
    try {
      // Write-then-rename, so a crash mid-write can't leave a half file that signs everyone out.
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
      renameSync(temp, this.file);
      chmodSync(this.file, 0o600);
    } catch (error) {
      log(`devices save failed: ${(error as Error).message}`);
    }
    if (notify) this.listeners.forEach((listener) => listener());
  }
}

/** Compares codes in constant time, so timing says nothing about how close a guess was. */
function sameCode(guess: string, code: string) {
  const a = Buffer.from(guess);
  const b = Buffer.from(code);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
