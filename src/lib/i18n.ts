/**
 * The API returns enum codes, never translated labels, so the client owns UI copy.
 * Only error messages are localised, from the Accept-Language header, with English as the default.
 * To add a language, add a block here; codes without a translation fall back to the English message.
 */
const catalog: Record<string, Record<string, string>> = {
  es: {
    UNAUTHORIZED: 'Se requiere autenticación',
    INVALID_CREDENTIALS: 'Correo electrónico o contraseña incorrectos',
    VALIDATION_ERROR: 'La solicitud no es válida',
    NOT_FOUND: 'Recurso no encontrado',
    RATE_LIMITED: 'Demasiadas solicitudes. Inténtalo de nuevo más tarde.',
    INTERNAL_ERROR: 'Algo salió mal',
    GOAL_NOT_SUPPORTED:
      'Según tu estatura y peso, no se recomienda perder peso. Mantener o aumentar de peso puede ser mejor opción.',
  },
};

export function pickLanguage(header: string | undefined): string {
  if (!header) return 'en';
  const requested = header
    .split(',')
    .map((part) => part.trim().split(';')[0]?.toLowerCase().split('-')[0])
    .filter((x): x is string => !!x);
  return requested.find((l) => l === 'en' || l in catalog) ?? 'en';
}

export function localizeError(code: string, fallback: string, acceptLanguage: string | undefined): string {
  const lang = pickLanguage(acceptLanguage);
  return catalog[lang]?.[code] ?? fallback;
}
