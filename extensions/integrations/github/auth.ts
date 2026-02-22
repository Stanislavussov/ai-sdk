import { Octokit } from "@octokit/rest";
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";

// Loaded from .env file — set GITHUB_CLIENT_ID there.
// Create an OAuth App at: https://github.com/settings/applications/new
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";

/**
 * Get the token file path for a specific project.
 * Stored at <projectDir>/.pi/github-token so each project has its own auth.
 */
function getTokenPath(cwd: string): string {
  return path.join(cwd, ".pi", "github-token");
}

/**
 * Load a previously saved GitHub token for this project.
 */
export async function loadToken(cwd: string): Promise<string | null> {
  try {
    const token = await fs.readFile(getTokenPath(cwd), { encoding: "utf-8" });
    return token.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Save a GitHub token for this project.
 */
export async function saveToken(cwd: string, token: string): Promise<void> {
  const tokenPath = getTokenPath(cwd);
  // Ensure .pi directory exists
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, token, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Delete the stored token for this project (logout).
 */
export async function deleteToken(cwd: string): Promise<void> {
  try {
    await fs.unlink(getTokenPath(cwd));
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Create an authenticated Octokit client for this project, or null if not logged in.
 */
export async function getOctokit(cwd: string): Promise<Octokit | null> {
  const token = await loadToken(cwd);
  if (!token) return null;

  const octokit = new Octokit({ auth: token });

  // Verify the token is still valid
  try {
    await octokit.rest.users.getAuthenticated();
    return octokit;
  } catch {
    // Token is invalid/expired
    await deleteToken(cwd);
    return null;
  }
}

/**
 * Start the OAuth device flow login.
 */
export async function startDeviceFlowLogin(
  cwd: string,
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

  await saveToken(cwd, token);
  return token;
}

/**
 * Login using a personal access token (simpler alternative to device flow).
 */
export async function loginWithToken(
  cwd: string,
  token: string,
): Promise<boolean> {
  const octokit = new Octokit({ auth: token });

  try {
    await octokit.rest.users.getAuthenticated();
    await saveToken(cwd, token);
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
