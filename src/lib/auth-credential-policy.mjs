export const LOGIN_REQUEST_MAX_BYTES = 16 * 1024;
export const LOGIN_USERNAME_MAX_CHARACTERS = 64;
export const LOGIN_USERNAME_MAX_UTF8_BYTES = 128;
export const AUTH_PASSWORD_MAX_CHARACTERS = 1_024;
export const AUTH_PASSWORD_MAX_UTF8_BYTES = 2_048;

/** @param {string} value */
export const countUnicodeCharacters = (value) => {
  let characterCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    characterCount += 1;
    const codeUnit = value.charCodeAt(index);
    const nextCodeUnit = value.charCodeAt(index + 1);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
      index += 1;
    }
  }
  return characterCount;
};

/**
 * Counts encoded bytes without allocating another potentially attacker-controlled
 * string-sized buffer. Unpaired surrogates count as the UTF-8 replacement character.
 *
 * @param {string} value
 */
export const getUtf8ByteLength = (value) => {
  let byteLength = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) {
      byteLength += 1;
    } else if (codePoint <= 0x7ff) {
      byteLength += 2;
    } else if (codePoint <= 0xffff) {
      byteLength += 3;
    } else {
      byteLength += 4;
    }
  }
  return byteLength;
};

/** @param {string} value */
export const isWellFormedUnicode = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};
