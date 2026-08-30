export type AppErrorKind =
  | 'validation'
  | 'auth'
  | 'permission'
  | 'business'
  | 'temporary'
  | 'configuration'
  | 'unexpected';

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly retryable: boolean;
  readonly nextAction?: string;

  constructor(
    kind: AppErrorKind,
    message: string,
    options: ErrorOptions & { retryable?: boolean; nextAction?: string } = {}
  ) {
    super(message, options);
    this.name = 'AppError';
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    if (options.nextAction !== undefined) this.nextAction = options.nextAction;
  }
}

export const unknownToAppError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  return new AppError('unexpected', 'No pudimos completar la acción.', {
    cause: error,
    retryable: true,
    nextAction: 'Volvé a intentarlo. Si continúa, avisale a la persona responsable de la tienda.'
  });
};

