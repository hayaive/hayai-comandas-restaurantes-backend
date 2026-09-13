import { randomBytes } from 'node:crypto';

// Base32 de Crockford: sin I, L, O, U (se confunden con 1, 1, 0, V al cantarlos
// o transcribirlos a mano). docs/DECISIONES-DATOS.md §3.
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(bytes: Buffer): string {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    salida += ALFABETO[(valor << (5 - bits)) & 31];
  }
  return salida;
}

/** ≥64 bits de entropía, va en la URL del QR. No se guarda hasheado a propósito. */
export function generarCodigoPublico(): string {
  return base32(randomBytes(10)); // 80 bits
}

/** Para cantarlo en la puerta. No autoriza nada. */
export function generarCodigoCorto(): string {
  return `R-${base32(randomBytes(3)).slice(0, 4)}`;
}
