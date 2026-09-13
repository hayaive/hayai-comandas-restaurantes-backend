/**
 * "Hoy" para la tasa de cambio, según la zona horaria del restaurante.
 *
 * Deliberadamente NO usa `DiaOperativoService`/`hayai_fecha_operativa`: esa
 * función resuelve el día CONTABLE (con hora de corte, para que la
 * madrugada facture al día anterior) y es un concepto distinto al de "qué
 * fecha de calendario es hoy" que pide CONTRACT.md para `TasasVigentes.fecha`
 * y para la clave natural de `POST /tasa`. Mezclar ambos calendarios haría
 * que "hoy" cambiara de significado entre el diálogo de cobro y el de tasa.
 */
export function hoyEnZona(zonaHoraria: string, momento: Date = new Date()): { fecha: Date; fechaISO: string } {
  const ahora = new Date(momento.toLocaleString('en-US', { timeZone: zonaHoraria }));
  const fecha = new Date(Date.UTC(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()));
  const fechaISO = fecha.toISOString().substring(0, 10);
  return { fecha, fechaISO };
}
