import { base58check, bech32, bech32m } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import type { AddressKind } from '../config/chainAssets';

/**
 * Is this string really an address on that chain?
 *
 * Asked at startup, about the operator's OWN receiving addresses, and the
 * reason is blunt: a typo in `.env` sends every customer's money somewhere
 * nobody holds a key to, and nothing else in the system would notice. A payment
 * to a malformed address does not bounce - depending on the chain it either
 * fails to send or vanishes into an unspendable output.
 *
 * Done with `@scure/base` rather than by hand. The distinctions here are
 * exactly where a hand-rolled check quietly accepts something wrong: bech32 and
 * bech32m share a format and differ only in a checksum constant, and a witness
 * version decides which of the two applies. A validator that "looks right" and
 * accepts a Taproot address under the wrong constant is worse than no
 * validator, because it is trusted.
 */

export type AddressCheck = { valid: boolean; reason?: string; normalized?: string };

/**
 * EIP-55, checked rather than ignored.
 *
 * A mixed-case Ethereum address carries a checksum in which letters are
 * capitalised, and it exists to catch exactly the typo this function is looking
 * for. An all-lower or all-upper address has no checksum to verify, which is
 * legal, so that is accepted with the case normalised away.
 */
export function checkEvmAddress(raw: string): AddressCheck {
  const address = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { valid: false, reason: 'An EVM address is 0x followed by 40 hex characters.' };
  }

  const body = address.slice(2);
  const lower = body.toLowerCase();
  const mixed = body !== lower && body !== body.toUpperCase();
  if (!mixed) return { valid: true, normalized: `0x${lower}` };

  const hash = Buffer.from(keccak_256(Buffer.from(lower, 'utf8'))).toString('hex');
  for (let index = 0; index < 40; index += 1) {
    const upper = Number.parseInt(hash[index]!, 16) >= 8;
    const character = body[index]!;
    if (/[a-zA-Z]/.test(character) && (character === character.toUpperCase()) !== upper) {
      return {
        valid: false,
        reason:
          'That EVM address fails its EIP-55 checksum - the capitalisation does not match the ' +
          'address, which usually means a character was mistyped.',
      };
    }
  }
  return { valid: true, normalized: `0x${lower}` };
}

/**
 * TRON: base58check over a 21-byte payload whose first byte is 0x41.
 *
 * The version byte is what makes an address start with "T", and checking it
 * rules out a base58check string from another chain entirely.
 */
export function checkTronAddress(raw: string): AddressCheck {
  const address = raw.trim();
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    return { valid: false, reason: 'A TRON address is "T" followed by 33 base58 characters.' };
  }
  try {
    const decoded = base58check(sha256).decode(address);
    if (decoded.length !== 21 || decoded[0] !== 0x41) {
      return { valid: false, reason: 'That TRON address does not decode to a mainnet address.' };
    }
    return { valid: true, normalized: address };
  } catch {
    return {
      valid: false,
      reason: 'That TRON address fails its checksum - a character is probably mistyped.',
    };
  }
}

/**
 * Bitcoin: base58check for the older forms, bech32/bech32m for the newer.
 *
 * The version split is the part worth being careful about. Witness version 0
 * (P2WPKH, P2WSH - the `bc1q…` addresses) uses bech32; version 1 and above
 * (Taproot, `bc1p…`) uses bech32m, which is a different checksum constant.
 * Decoding a Taproot address as bech32 fails, and - the dangerous direction -
 * a validator that tries bech32m for everything accepts a corrupted v0 address.
 */
export function checkBitcoinAddress(raw: string): AddressCheck {
  const address = raw.trim();

  if (/^(bc1|BC1)/.test(address)) {
    const lower = address.toLowerCase();
    // Peek at the witness version before choosing a checksum to verify with.
    let version: number | null = null;
    try {
      version = bech32.decodeUnsafe(lower, 90)?.words?.[0] ?? null;
    } catch {
      version = null;
    }
    if (version === null) {
      try {
        version = bech32m.decodeUnsafe(lower, 90)?.words?.[0] ?? null;
      } catch {
        version = null;
      }
    }
    if (version === null) {
      return { valid: false, reason: 'That Bitcoin address is not valid bech32.' };
    }

    try {
      const decoded = version === 0 ? bech32.decode(lower, 90) : bech32m.decode(lower, 90);
      if (decoded.prefix !== 'bc') {
        return { valid: false, reason: 'That is not a Bitcoin mainnet address.' };
      }
      const program = bech32.fromWords(decoded.words.slice(1));
      if (version === 0 && program.length !== 20 && program.length !== 32) {
        return { valid: false, reason: 'That segwit address has an invalid program length.' };
      }
      if (program.length < 2 || program.length > 40) {
        return { valid: false, reason: 'That segwit address has an invalid program length.' };
      }
      return { valid: true, normalized: lower };
    } catch {
      return {
        valid: false,
        reason:
          version === 0
            ? 'That segwit address fails its bech32 checksum.'
            : 'That Taproot address fails its bech32m checksum.',
      };
    }
  }

  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,39}$/.test(address)) {
    try {
      const decoded = base58check(sha256).decode(address);
      // 0x00 is P2PKH ("1…"), 0x05 is P2SH ("3…"). Anything else is another
      // network's address that happens to look similar.
      if (decoded.length !== 21 || (decoded[0] !== 0x00 && decoded[0] !== 0x05)) {
        return { valid: false, reason: 'That is not a Bitcoin mainnet address.' };
      }
      return { valid: true, normalized: address };
    } catch {
      return {
        valid: false,
        reason: 'That Bitcoin address fails its checksum - a character is probably mistyped.',
      };
    }
  }

  return { valid: false, reason: 'That does not look like a Bitcoin address.' };
}

export function checkAddress(kind: AddressKind, raw: string): AddressCheck {
  if (!raw.trim()) return { valid: false, reason: 'No address is set.' };
  if (kind === 'evm') return checkEvmAddress(raw);
  if (kind === 'tron') return checkTronAddress(raw);
  return checkBitcoinAddress(raw);
}
