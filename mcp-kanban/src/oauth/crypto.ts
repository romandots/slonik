import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Случайный opaque-токен/код: 32 байта → 43 символа base64url. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex — для хранения токенов/кодов в покое (плейнтекст не храним). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** base64url(sha256(input)) — PKCE S256 transform (RFC 7636 §4.2). */
export function base64UrlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

/**
 * Проверяет PKCE code_verifier против сохранённого code_challenge (S256).
 * Сравнение константного времени. Возвращает false при любом несовпадении
 * длины/содержимого.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const computed = base64UrlSha256(codeVerifier);
  return constantTimeEqual(computed, codeChallenge);
}

/** Сравнение строк за константное время. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
