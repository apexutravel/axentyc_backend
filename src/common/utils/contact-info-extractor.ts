/**
 * Extracts contact information (email, phone, name) and conversation
 * subject/topic from chat message text.
 * Uses regex patterns — can be replaced with AI-based extraction later.
 */

export interface ExtractedContactInfo {
  email?: string;
  phone?: string;
  name?: string;
}

export interface ExtractedSubject {
  subject: string;
  tags: string[];
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const PHONE_REGEX = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{2,4}/;

const NAME_PATTERNS = [
  /(?:me llamo|mi nombre es|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2})/i,
  /(?:my name is|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
];

const GREETINGS = /^(hola|hi|hello|hey|buenos?\s*d[ií]as?|buenas?\s*tardes?|buenas?\s*noches?|saludos?|que tal|qué tal)[.,!?\s]*$/i;

const INTENT_KEYWORDS: Record<string, string[]> = {
  compra: ['comprar', 'adquirir', 'precio', 'costo', 'cuánto cuesta', 'cuanto cuesta', 'cotización', 'cotizacion', 'presupuesto', 'pagar', 'tarifa', 'promoción', 'promocion', 'oferta', 'descuento'],
  viaje: ['viaje', 'viajar', 'vuelo', 'hotel', 'paquete', 'destino', 'reserva', 'reservar', 'excursión', 'excursion', 'turismo', 'tour', 'pasaje', 'boleto', 'hospedaje', 'resort', 'playa', 'crucero'],
  soporte: ['ayuda', 'problema', 'error', 'no funciona', 'falla', 'soporte', 'reclamo', 'queja', 'devolución', 'devolucion', 'reembolso', 'arreglar', 'solucionar'],
  información: ['información', 'informacion', 'info', 'horario', 'dirección', 'direccion', 'ubicación', 'ubicacion', 'cómo', 'como llego', 'dónde', 'donde queda', 'requisitos', 'documentos'],
  servicio: ['servicio', 'contratar', 'agendar', 'cita', 'agenda', 'disponibilidad', 'disponible', 'consulta', 'asesoría', 'asesoria'],
};

export function extractContactInfo(text: string): ExtractedContactInfo {
  const result: ExtractedContactInfo = {};

  const emailMatch = text.match(EMAIL_REGEX);
  if (emailMatch) {
    result.email = emailMatch[0].toLowerCase();
  }

  const phoneMatch = text.match(PHONE_REGEX);
  if (phoneMatch) {
    const cleaned = phoneMatch[0].replace(/[\s().-]/g, '');
    if (cleaned.length >= 7 && cleaned.length <= 15) {
      result.phone = phoneMatch[0].trim();
    }
  }

  for (const pattern of NAME_PATTERNS) {
    const nameMatch = text.match(pattern);
    if (nameMatch && nameMatch[1]) {
      result.name = nameMatch[1].trim();
      break;
    }
  }

  return result;
}

export function hasExtractedInfo(info: ExtractedContactInfo): boolean {
  return !!(info.email || info.phone || info.name);
}

/**
 * Extracts a meaningful subject from a chat message.
 * Skips pure greetings (hola, hi, etc.) and returns the message
 * trimmed as the subject + detected intent tags.
 */
export function extractSubject(text: string): ExtractedSubject | null {
  const trimmed = text.trim();

  if (!trimmed || trimmed.length < 5) return null;
  if (GREETINGS.test(trimmed)) return null;

  // Remove leading greeting from message: "Hola, quiero info sobre..." → "quiero info sobre..."
  let cleaned = trimmed.replace(/^(hola|hi|hello|hey|buenos?\s*d[ií]as?|buenas?\s*tardes?|buenas?\s*noches?|saludos?)[.,!?\s]+/i, '').trim();
  if (!cleaned || cleaned.length < 5) cleaned = trimmed;

  // Truncate to 120 chars
  const subject = cleaned.length > 120 ? cleaned.substring(0, 117) + '...' : cleaned;

  // Detect intent tags
  const tags: string[] = [];
  const lower = trimmed.toLowerCase();
  for (const [tag, keywords] of Object.entries(INTENT_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      tags.push(tag);
    }
  }

  return { subject, tags };
}
