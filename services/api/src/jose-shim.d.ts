declare module "jose" {
  export type JWTPayload = Record<string, unknown>;

  export const createRemoteJWKSet: (url: URL) => unknown;

  export const jwtVerify: (
    token: string,
    key: unknown,
    options?: Record<string, unknown>
  ) => Promise<{ payload: JWTPayload }>;
}
