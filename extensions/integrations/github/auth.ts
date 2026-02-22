import { Octokit } from "@octokit/rest";
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import "dotenv/config";

// Loaded from .env file — set GITHUB_CLIENT_ID there.
// Create an OAuth App at: https://github.com/settings/applications/new
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";

const TOKEN_PATH = path.join(os.homedir(), ".pi-github-token");

/**
 * Load a previously saved GitHub token from disk.
 */
export async function loadToken(): Promise<string | null> {
  try {
    const token = await fs.readFile(TOKEN_PATH, { encoding: "utf-8" });
    return token.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Save a GitHub token to disk.
 */
export async function saveToken(token: string): Promise<void> {
  await fs.writeFile(TOKEN_PATH, token, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Delete the stored token (logout).
 */
export async function deleteToken(): Promise<void> {
  try {
    await fs.unlink(TOKEN_PATH);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Create an authenticated Octokit client, or null if not logged in.
 */
export async function getOctokit(): Promise<Octokit | null> {
  const token = await loadToken();
  if (!token) return null;

  const octokit = new Octokit({ auth: token });

  // Verify the token is still valid
  try {
    await octokit.rest.users.getAuthenticated();
    return octokit;
  } catch {
    // Token is invalid/expired
    await deleteToken();
    return null;
  }
}

/**
 * Start the OAuth device flow login.
 * Returns an object with the verification URL and user code,
 * and a promise that resolves to the token once the user completes auth.
 */
export async function startDeviceFlowLogin(
  onVerification: (verification: {
    verification_uri: string;
    user_code: string;
  }) => void,
): Promise<string> {
  const auth = createOAuthDeviceAuth({
    clientType: "oauth-app",
    clientId: GITHUB_CLIENT_ID,
    scopes: ["repo"],
    onVerification(verification) {
      onVerification({
        verification_uri: verification.verification_uri,
        user_code: verification.user_code,
      });
    },
  });

  const tokenAuth = await auth({ type: "oauth" });
  const token = tokenAuth.token;

  await saveToken(token);
  return token;
}

/**
 * Login using a personal access token (simpler alternative to device flow).
 */
export async function loginWithToken(token: string): Promise<boolean> {
  const octokit = new Octokit({ auth: token });

  try {
    await octokit.rest.users.getAuthenticated();
    await saveToken(token);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current repo's owner and name from git remote.
 */
export async function getRepoInfo(
  cwd: string,
  exec: (
    cmd: string,
    args: string[],
    opts: { cwd: string },
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ owner: string; repo: string } | null> {
  const result = await exec("git", ["remote", "get-url", "origin"], { cwd });

  if (result.code !== 0 || !result.stdout.trim()) return null;

  const url = result.stdout.trim();

  // Handle SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:(.+?)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // Handle HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(
    /https?:\/\/github\.com\/(.+?)\/(.+?)(?:\.git)?$/,
  );
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  return null;
}
