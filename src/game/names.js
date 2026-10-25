'use strict';

/**
 * Display name and room code validation.
 *
 * Names are rendered on the client with textContent only, so the goal here is to
 * keep them short, printable and free of control characters and markup.
 */

const NAME_ALLOWED = /^[\p{L}\p{N}][\p{L}\p{N} ._'\u2019!?&+#-]*$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
const RESERVED = new Set(['host', 'guest', 'server', 'admin', 'system', 'null', 'undefined']);

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizeName(input) {
  if (typeof input !== 'string') return '';
  return input.normalize('NFC').replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
}

/**
 * @returns {{ok: true, name: string} | {ok: false, code: string, message: string}}
 */
function validateName(input, config) {
  const min = config?.minNameLength ?? 2;
  const max = config?.maxNameLength ?? 16;
  const name = normalizeName(input);

  if (!name) {
    return { ok: false, code: 'INVALID_NAME', message: 'Enter a display name to continue.' };
  }
  if (name.length < min) {
    return {
      ok: false,
      code: 'INVALID_NAME',
      message: `Use at least ${min} characters for your name.`,
    };
  }
  if (name.length > max) {
    return {
      ok: false,
      code: 'INVALID_NAME',
      message: `Keep your name to ${max} characters or fewer.`,
    };
  }
  if (!NAME_ALLOWED.test(name)) {
    return {
      ok: false,
      code: 'INVALID_NAME',
      message: 'Use letters, numbers, spaces or simple punctuation such as . _ -',
    };
  }
  if (RESERVED.has(name.toLowerCase())) {
    return { ok: false, code: 'INVALID_NAME', message: 'That name is reserved. Pick another one.' };
  }
  return { ok: true, name };
}

function normalizeRoomCode(input) {
  if (typeof input !== 'string') return '';
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function isValidRoomCode(code) {
  return typeof code === 'string' && /^[A-Z2-9]{6}$/.test(code);
}

function generateRoomCode(randomBytes) {
  const bytes = randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

module.exports = {
  normalizeName,
  validateName,
  normalizeRoomCode,
  isValidRoomCode,
  generateRoomCode,
  ROOM_CODE_ALPHABET,
};
