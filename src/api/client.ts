/**
 * Reusable HTTP API client — re-exported from `cwip` (its canonical home; the
 * implementation was promoted there from this file). Every service client
 * (Jenkins, GitLab, Quay, Rancher, ...) is built on `createApiClient`: base-URL
 * joining, query params, auth headers (bearer/basic/custom), JSON bodies,
 * content-type-aware parsing, uniform `ApiError`s tagged with the client name,
 * timeouts, and injectable `fetch`. This module stays as the import seam the
 * package's public surface re-exports from.
 */

export {
  type ApiClient,
  type ApiClientConfig,
  ApiError,
  type ApiErrorDiagnostic,
  type ApiResponse,
  type AuthConfig,
  buildUrl,
  createApiClient,
  type QueryParams,
  type RequestOptions,
  type ResponseType,
} from 'cwip';
