// Reads the token from the PC's own `gh` login, so no GitHub token lives in the runner env file.
import { execFile } from 'node:child_process'

export class GhAuthError extends Error {}

// Pure: validates `gh auth token` stdout.
export function parseGhToken(stdout: string): string {
  const token = stdout.trim()
  if (!/^[A-Za-z0-9_]{10,}$/.test(token)) throw new GhAuthError('gh is not logged in (run `gh auth login`)')
  return token
}

export function readGhToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token'], { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      if (err) return reject(new GhAuthError('gh auth token failed (is gh installed and logged in?)'))
      try {
        resolve(parseGhToken(String(stdout)))
      } catch (e) {
        reject(e)
      }
    })
  })
}
