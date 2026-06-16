/**
 * rubato API clients.
 *
 * Re-exports the reusable HTTP client and env helpers. Service-specific clients
 * (Jenkins, GitLab, Quay, Rancher, ...) live in sibling files and are built on
 * `createApiClient`.
 */

export {
  type ApiClient,
  type ApiClientConfig,
  ApiError,
  type ApiResponse,
  type AuthConfig,
  buildUrl,
  createApiClient,
  type RequestOptions,
  type ResponseType,
} from './client';
export { optionalEnv, requireEnv } from './env';
