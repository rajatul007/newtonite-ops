/**
 * Every error the API returns has a stable machine-readable `code` so the frontend can react
 * to it (e.g. show a conflict dialog for VERSION_CONFLICT) instead of parsing messages.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'VALIDATION_ERROR', message, details);
export const unauthenticated = () => new HttpError(401, 'UNAUTHENTICATED', 'Please sign in');
export const forbidden = (message = 'You are not allowed to do that') => new HttpError(403, 'FORBIDDEN', message);
// Items in teams you cannot see return 404, so their existence is not leaked.
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details);
