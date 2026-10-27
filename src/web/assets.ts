/**
 * 🧱 Static bytes the page needs and Docker ships (the image copies only src/):
 * the two OFL fonts (docs/fonts twins — Inter for text, JetBrains Mono for
 * labels and numbers, the Strands design language) and nothing else. Read once
 * at import; served immutable, so a phone fetches each exactly once.
 */
import { readFileSync } from 'node:fs';
import type http from 'node:http';

const here = new URL('./assets/', import.meta.url);
const FILES: Record<string, { bytes: Buffer; type: string }> = {
  '/fonts/inter-latin.woff2': { bytes: readFileSync(new URL('inter-latin.woff2', here)), type: 'font/woff2' },
  '/fonts/jetbrains-mono-latin.woff2': { bytes: readFileSync(new URL('jetbrains-mono-latin.woff2', here)), type: 'font/woff2' },
};

/** Answers a static path, or returns false so the router carries on. */
export function serveStatic(pathname: string, res: http.ServerResponse): boolean {
  const f = FILES[pathname];
  if (!f) return false;
  res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.end(f.bytes);
  return true;
}

export const STATIC_PATHS = Object.keys(FILES);
