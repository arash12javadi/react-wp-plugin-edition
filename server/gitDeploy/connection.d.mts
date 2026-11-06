/** Types for `server/gitDeploy/connection.mjs`. */

export const VERCEL_DEPLOY_CONFIG_KEY: 'vercel_deploy_config';

export interface DeploymentConnection {
  repository: string;
  branch: string;
  project_id: string;
  project_name: string;
  team_id: string;
  token_sealed: string;
  token_fingerprint: string;
  vercel_user: string;
  connected_at: string;
  verified_at: string;
}

export function deploymentConnectionFrom(value: unknown): DeploymentConnection;
export function isGitDeployConnected(connection: Partial<DeploymentConnection> | null | undefined): boolean;

export function settingsIo(options: {
  supabaseUrl?: string;
  supabaseKey?: string;
  accessToken?: string;
  readSetting?: (key: string) => Promise<unknown>;
  writeSetting?: (key: string, value: unknown) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}): {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
};
