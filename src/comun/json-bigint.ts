/**
 * Postgres devuelve BIGINT (los `count(*)` de las vistas de reporte) como
 * BigInt en JS vía el driver adapter, y `JSON.stringify` no sabe serializarlo:
 * el endpoint responde 500 con "Do not know how to serialize a BigInt".
 *
 * Los conteos de este dominio (comandas, ítems, pagos) nunca se acercan a
 * `Number.MAX_SAFE_INTEGER`, así que convertir a Number es seguro.
 *
 * Vive aquí y no en `main.ts` porque los tests e2e no arrancan por `main.ts`:
 * arrancan `AppModule` + `configurarApp`. Con el parche sólo en `main.ts`,
 * cualquier endpoint de reportes respondía 200 en producción y 500 en los
 * tests — la clase de divergencia que `configurarApp` existe para evitar.
 */
export function habilitarSerializacionBigInt(): void {
  (BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
    return Number(this);
  };
}
