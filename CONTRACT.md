# HAYAI Comandas · Contrato de entidades y API

> Autor: **J.O.R.B.I** (data-engineer). Producido antes de implementar.
> Fuente de verdad del esquema: `prisma/schema.prisma` + `prisma/sql/`.
> El porqué de cada decisión: `docs/DECISIONES-DATOS.md`.
>
> Este documento es el contrato que **D.A.N.I** (fullstack) implementa en
> backend y frontend en paralelo. Nombres de campo en el wire = camelCase,
> exactamente como los expone Prisma. En la base son snake_case.
>
> **Actualizado el 2026-09-15** con el rediseño de *comandas múltiples por mesa
> + cobro consolidado* (migración `20260915183000_comandas_multiples_y_cobro`).
> Es un cambio **ROMPEDOR** para el frontend: una comanda dejó de ser la cuenta
> de la mesa y pasó a ser un pedido, apareció la entidad `Cobro`, y seis
> endpoints de comandas cambiaron o desaparecieron (§5). Lo que hay que releer
> sí o sí: §0 (mapa mental), §2.9-§2.12 (entidades), §3.1-§3.3 (flujos) y la
> tabla de endpoints retirados en §5.

---

## 0 · Mapa mental en una pantalla

```
restaurante
  └── salon ("Salón principal", "Terraza")         ← espacio FÍSICO
        ├── mesa ("5", "T-2")                      ← IDENTIDAD estable
        └── plantilla ("Normal", "Evento boda")    ← DISTRIBUCIÓN, 1 activa por salón
              └── plantilla_mesa                   ← posición + tamaño + sillas
                     (plantilla × mesa)

reservacion ── (al llegar) ──> [sentada]
                                   │
                    (el mesero toma nota)
                                   ↓
                              comanda ──> comanda_item        ← UN PEDIDO
                                   │            ↑
                                   │       producto ← categoria
                                   │
                        N comandas de una mesa
                                   ↓
                               cobro ──> cobro_pago           ← LA FACTURA
```

Las tres ideas que hay que entender antes de tocar código:

1. **La mesa y su sitio en el plano son dos cosas distintas.** `mesa` es la
   identidad ("Mesa 5"); `plantilla_mesa` es dónde está dibujada, cuánto mide y
   cuántas sillas tiene *en esa distribución*. Así la misma mesa puede ser de 4
   sillas en la distribución normal y de 10 en un banquete, y el histórico de
   ventas de la Mesa 5 sobrevive a cualquier rediseño del salón.
2. **Una comanda es UN PEDIDO, no la cuenta de la mesa.** Cada envío a cocina
   crea una comanda nueva, y una mesa acumula N comandas vivas a la vez. La mesa
   está ocupada si y solo si tiene al menos una comanda sin cobrar y sin anular;
   su **cuenta** es la suma de todas (`v_cuenta_mesa`). Lo que se cobra es la
   mesa, y eso emite un `cobro` — la factura que cubre esas comandas.
   *(Hasta la migración `20260915183000` una comanda ERA la cuenta y la base
   impedía que hubiera dos por mesa; ese índice ya no existe.)*
3. **`comanda.estado` es DERIVADO.** No se escribe: lo calcula el trigger
   `comanda_estado` a partir de tres hechos independientes —`despachadaEn`,
   `cobroId`, `anuladaEn`. Para mover una comanda se escribe el hecho, nunca el
   estado; mandarlo en un PATCH no hace nada.
4. **El día operativo no es `creado_en::date`.** Es `fecha_operativa`, calculada
   con la hora de corte del restaurante. La del **cobro** es la que cuenta como
   venta (el dinero entra al cobrar, y el cierre de caja tiene que cuadrar con
   la gaveta); la de la comanda dice cuándo se pidió. Los reportes agrupan por
   la del cobro — y el mes y el año son la **suma de esos días**, no un rango de
   timestamps (§5, `GET /reportes/ventas`).

---

## 1 · Enumeraciones

```ts
type RolUsuario        = 'administrador' | 'encargado' | 'mesero' | 'cocina' | 'caja';
type FormaMesa         = 'redonda' | 'cuadrada' | 'rectangular' | 'barra';
type EstadoReservacion = 'pendiente' | 'confirmada' | 'sentada' | 'completada'
                       | 'cancelada' | 'no_show';
type OrigenReservacion = 'personal' | 'enlace_publico';
type TipoComanda       = 'mesa' | 'para_llevar';
/// DERIVADO por el trigger `comanda_estado`; la app escribe los hechos, no esto.
///   pendiente  = en la cola de despacho          (despachadaEn = null)
///   despachada = salió de cocina, cobrable       (despachadaEn ≠ null)
///   cobrada    = cubierta por un Cobro           (cobroId ≠ null)
///   anulada    = descartada                      (anuladaEn ≠ null)
type EstadoComanda     = 'pendiente' | 'despachada' | 'cobrada' | 'anulada';
/// `EstadoComandaItem` DESAPARECIÓ: no hay workflow por línea, la comanda se
/// despacha entera. Una línea anulada se reconoce por `canceladoEn != null`.
type DestinoPreparacion= 'cocina' | 'barra' | 'ninguno';
type TurnoServicio     = 'desayuno' | 'almuerzo' | 'cena' | 'madrugada';
type MetodoPago        = 'efectivo_usd' | 'efectivo_bs' | 'pago_movil'
                       | 'transferencia' | 'punto' | 'binance' | 'otro';
/// Moneda en la que se COBRA. No lleva 'EUR' y no debe llevarlo: ver `Divisa`.
type Moneda            = 'USD' | 'BS';
/// Moneda EXTRANJERA que se cotiza en bolívares. Sólo aparece en TasaCambio.
/// NO es intercambiable con `Moneda` — ver docs/DECISIONES-DATOS.md §D13.
type Divisa            = 'USD' | 'EUR';
type FuenteTasa        = 'bcv' | 'manual' | 'binance';

/// Derivado, NO existe como columna: lo calcula la vista v_mesa_estado.
type EstadoMesa        = 'libre' | 'ocupada' | 'reservada' | 'bloqueada';
```

**Añadir un valor a un enum** = migración `ALTER TYPE ... ADD VALUE` y desplegar
el backend **antes** que el frontend que lo emite. Quitarlo son 3 fases.

---

## 2 · Entidades

Convenciones de todas las tablas: `id` es UUIDv7 generado en el backend (nunca
por la base), `restauranteId` está en todas, y los `DateTime` son ISO 8601 con
zona. Los importes son **string** en el wire (Prisma serializa `Decimal`), no
`number`: nunca hacer aritmética monetaria con `number` en el frontend.

### 2.1 Restaurante

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | |
| `slug` | string | citext, único. Namespace de la URL pública `/r/<slug>` |
| `nombre` | string | |
| `rif` | string? | |
| `monedaBase` | Moneda | `USD`. Los precios del menú se fijan aquí |
| `zonaHoraria` | string | `America/Caracas` |
| `horaCorteDia` | time | Default `05:00`. Define `fechaOperativa` |
| `duracionReservaMin` | int | Default 90. Largo del bloqueo de mesa por reserva |
| `permiteAutoseleccion` | bool | Si el cliente puede elegir mesa desde el QR |
| `activo` | bool | |

### 2.2 Usuario

`id`, `restauranteId`, `nombre`, `usuario` (citext, único por restaurante),
`claveHash`, `pinHash?` (login rápido de mesero), `rol: RolUsuario`, `activo`,
`ultimoAccesoEn?`.

> Los usuarios **no se borran**: `activo = false`. Todas las FK hacia usuario son
> `ON DELETE RESTRICT` justamente para proteger la trazabilidad de quién anuló
> una comanda o registró un pago.

### 2.3 Salon

`id`, `restauranteId`, `nombre` (único entre los vivos), `orden`, `activo`,
`eliminadoEn?`.

### 2.4 Mesa — identidad

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | |
| `restauranteId`, `salonId` | uuid | |
| `etiqueta` | string | "5", "T-2". **Única en todo el restaurante** entre las no eliminadas |
| `capacidadDefault` | int | Sólo es el valor que se copia al añadirla a una plantilla |
| `formaDefault` | FormaMesa | Ídem |
| `activa` | bool | |
| `eliminadaEn` | date? | Borrado lógico |

### 2.5 Plantilla — distribución

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `restauranteId`, `salonId` | uuid | |
| `nombre` | string | "Distribución normal", "Evento boda" |
| `descripcion` | string? | |
| `anchoPlano`, `altoPlano` | decimal | Lienzo lógico del editor |
| `activa` | bool | **Sólo una en `true` por salón** (garantizado por la base) |
| `clonadaDeId` | uuid? | NULL = creada desde plano vacío |
| `creadaPorId` | uuid? | |
| `eliminadaEn` | date? | Borrado lógico. Nunca puede coexistir con `activa=true` (la base lo garantiza) |

### 2.6 PlantillaMesa — la mesa en el plano

PK compuesta `(plantillaId, mesaId)`.

| Campo | Tipo | Notas |
|---|---|---|
| `restauranteId`, `plantillaId`, `mesaId` | uuid | |
| `posX`, `posY` | decimal | Esquina superior izquierda, en unidades del plano |
| `ancho`, `alto` | decimal | Para `redonda`, ancho == alto == diámetro |
| `rotacion` | int | 0-359 |
| `forma` | FormaMesa | |
| `capacidad` | int | 1-50. **Sillas en ESTA distribución** |
| `bloqueada` | bool | Fuera de servicio: no admite reserva ni comanda |

### 2.7 Categoria / Producto

`Categoria`: `id`, `restauranteId`, `nombre`, `orden`, `activa`, `eliminadaEn?`.

`Producto`: `id`, `restauranteId`, `categoriaId`, `codigo?`, `nombre`,
`descripcion?`, `precio` (USD), `costo?`, `destino: DestinoPreparacion`,
`disponible` (el "se acabó" del día), `activo` (está en la carta), `orden`,
`imagenUrl?`, `tiempoPrepMin?`.

> `disponible` y `activo` son distintos a propósito: lo primero se apaga y se
> enciende a diario desde la cocina; lo segundo saca el plato de la carta.

### 2.8 Reservacion

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `restauranteId`, `salonId`, `plantillaId` | uuid | `plantillaId` = contra qué distribución se reservó |
| `mesaId` | uuid? | NULL = sin mesa asignada todavía |
| `clienteNombre` | string | |
| `clienteTelefono`, `clienteDocumento` | string? | Documento: cédula/RIF venezolano |
| `personas` | int | 1-200 |
| `iniciaEn`, `terminaEn` | datetime | `terminaEn` > `iniciaEn` (CHECK) |
| `estado` | EstadoReservacion | |
| `origen` | OrigenReservacion | |
| `codigoPublico` | string | **Único global.** Lo que va en el QR/URL. Alta entropía |
| `codigoCorto` | string | "R-7K4Q", para cantarlo en la puerta. No autoriza nada |
| `notas` | string? | |
| `creadaPorId` | uuid? | NULL si vino del enlace público |
| `confirmadaEn`, `sentadaEn`, `canceladaEn` | datetime? | |
| `motivoCancelacion` | string? | |

> **La doble reserva es imposible**: un constraint `EXCLUDE` rechaza cualquier
> reserva que solape en el tiempo con otra viva de la misma mesa. No hace falta
> comprobarlo antes en la aplicación (aunque sí conviene para dar buen mensaje):
> hay que **capturar el error `23P01`** y devolver 409.

### 2.9 Comanda — UN PEDIDO

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `restauranteId` | uuid | |
| `tipo` | TipoComanda | `mesa` exige `mesaId`+`salonId`+`plantillaId`; `para_llevar` exige `mesaId` NULL |
| `salonId`, `mesaId`, `plantillaId` | uuid? | |
| `reservacionId` | uuid? | La reserva que originó el pedido. **1:N**: una reserva genera tantas comandas como rondas pida la mesa |
| `numeroDia` | int | Número visible del pedido. Único por `(restaurante, fechaOperativa)` |
| `fechaOperativa` | date | Día contable **del pedido**. No es el de la venta: ese es `cobro.fechaOperativa` |
| `turno` | TurnoServicio | Ídem |
| `comensales` | int | |
| `meseroId` | uuid? | |
| `estado` | EstadoComanda | **DERIVADO** por trigger. No se escribe |
| `despachadaEn?` | datetime | La cocina lo sacó. NULL = sigue en la cola |
| `anuladaEn?` | datetime | Descartado |
| `cobroId?` | uuid | La factura que lo cubre. NULL = sigue en la cuenta viva de la mesa |
| `total` | decimal | USD. **Sólo la suma de sus líneas vivas.** Lo recalcula el servidor |
| `anuladaPorId?`, `motivoAnulacion?` | | |
| `notas?` | | |

> **Lo que se fue de aquí y por qué.** `ronda` (la ronda ES la comanda);
> `abiertaEn`/`cerradaEn` (los sustituyen los tres timestamps de hecho);
> `subtotal`/`descuento`/`impuesto`/`propina` y `tasaId`/`tasaValor`/`totalBs`
> (se negocian sobre la cuenta de la mesa y viven en `Cobro` — un ticket de
> cocina no tiene propina).
>
> **Invariantes que la base hace cumplir:** no se cobra lo que no salió de
> cocina (`comanda_cobro_tras_despacho`); una comanda cobrada no se anula ni al
> revés (`comanda_anulada_no_cobrada`).

### 2.10 ComandaItem

`id`, `restauranteId`, `comandaId`, `productoId`, `orden`, `nombreSnap`,
`precioUnitarioSnap`, `destinoSnap`, `cantidad`, `descuentoLinea`, `totalLinea`,
`nota?`, `canceladoEn?`, `canceladoPorId?`, `motivoCancelacion?`.

> Los `*Snap` son **obligatorios**: el ticket de hoy tiene que poder
> reimprimirse idéntico dentro de un año aunque el producto haya cambiado de
> precio o de nombre. Nunca leer el precio actual del producto para un reporte
> histórico.
>
> **Anulada ⟺ `canceladoEn != null`.** Se fueron `estado`, `ronda`, `enviadoEn`
> y `servidoEn`: sin workflow por ítem no había quién los moviera.
>
> ⚠️ **Sólo se pueden tocar mientras la comanda esté `pendiente`.** Lo impide el
> trigger `comanda_item_solo_pendiente` (→ 409), y cubre las tres reglas: se
> anula una línea antes de despachar; no se le añaden líneas a un pedido que ya
> salió (rompería el FIFO); no se toca nada de una comanda ya cobrada.

### 2.11 Cobro — LA FACTURA

La cuenta consolidada de una mesa. Reúne N comandas despachadas vía
`comanda.cobroId`.

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `restauranteId` | uuid | |
| `mesaId?`, `salonId?` | uuid | NULL en un cobro para llevar. Con mesa, exige salón |
| `numeroDia` | int | Número visible de la factura del día. Contador propio, distinto del de la comanda |
| `fechaOperativa`, `turno` | | **Los del cobro**: la venta se cuenta cuando entra el dinero |
| `comensales` | int | El máximo de las comandas cubiertas |
| `subtotal`, `descuento`, `impuesto`, `propina`, `total` | decimal | USD. Los calcula **el servidor** |
| `tasaId`, `tasaValor`, `totalBs` | | **NOT NULL**: congelados al emitir, para reimprimir el mismo monto en Bs |
| `cobradoEn`, `cobradoPorId?` | | |
| `anuladoEn?`, `anuladoPorId?`, `motivoAnulacion?` | | |
| `notas?` | | |

> **Es un comprobante INTERNO de cobro, no un documento fiscal**: sin RIF, sin
> IVA discriminado, sin correlativo SENIAT. Si algún día hace falta el fiscal,
> entra como entidad aparte que apunta a ésta.
>
> No hay tabla puente comanda↔cobro: es una FK simple. El **cobro parcial** se
> decide a nivel de API (`comandaIds[]`), no de esquema.
>
> ⚠️ Un cobro **siempre** cubre al menos una comanda: lo garantiza el constraint
> trigger diferido `cobro_no_vacio`, que revienta en el COMMIT. Es la red contra
> la factura fantasma de dos cajeros cobrando la misma mesa a la vez.

### 2.12 CobroPago

`id`, `restauranteId`, `cobroId`, `metodo: MetodoPago`, `moneda: Moneda`,
`monto` (en esa moneda), `tasaAplicada?`, `montoUsd`, `referencia?`,
`recibidoEn`, `registradoPorId?`.

*(Se llamaba `ComandaPago` y colgaba de la comanda; ahora cuelga de la factura.)*

Reglas que **la base** hace cumplir:
- `pago_movil` y `transferencia` exigen `referencia` no vacía (conciliación bancaria).
- `moneda = 'BS'` exige `tasaAplicada`; `moneda = 'USD'` exige que sea NULL.
- Varias filas por cobro: el pago mixto (mitad efectivo USD, mitad pago móvil)
  es lo normal, no la excepción.

### 2.13 TasaCambio / ContadorDia / ResumenDia

```ts
interface TasaCambio {
  id: string;
  restauranteId: string;
  fecha: string;            // 'YYYY-MM-DD' — día del restaurante, no UTC
  divisa: Divisa;           // 'USD' | 'EUR'
  valor: string;            // Decimal(18,8) — BOLÍVARES POR 1 UNIDAD DE `divisa`
  fuente: FuenteTasa;
  registradaPorId?: string;
  creadaEn: string;
}
```

Única por `(restaurante, divisa, fecha, fuente)`.

> **`valor` se lee siempre como "Bs por 1 unidad de la divisa", nunca al revés.**
> `divisa='USD', valor=912.50` → 1 USD = 912,50 Bs.
> `divisa='EUR', valor=985.30` → 1 EUR = 985,30 Bs.
> Invertir la lectura es el error clásico y aquí cuesta dinero real.

Reglas que **la base** hace cumplir (verificadas, ver §10 de DECISIONES-DATOS):
- Un **cobro** sólo puede congelar una tasa con `divisa='USD'`, la moneda base.
  El euro es **informativo**: hoy nadie paga en euros. Lo impide el trigger
  `cobro_tasa_base`, no el código. *(Se llamaba `comanda_tasa_base` y vivía en
  `comanda`; viajó a `cobro`, que es donde ahora se congela la tasa.)*
- La `divisa` de una tasa ya registrada es **inmutable** (`tasa_divisa_inmutable`).
  Corregir el `valor` sí se permite; cambiar de dólar a euro, no.

- `ContadorDia`: `(restauranteId, fechaOperativa)` → `ultimoComanda` y
  `ultimoCobro`. Los DOS números visibles del día —el del pedido y el de la
  factura— son contadores distintos porque cuentan cosas distintas y el cliente
  ve los dos. Infraestructura; el frontend no la ve.
  *(Se llamaba `ContadorComanda` y sólo tenía `ultimo`.)*
- `ResumenDia`: rollup por `(restaurante, fechaOperativa, turno)`. **Fase 2**:
  no se implementa hasta que el dashboard lo pida (ver §7).

---

## 3 · Flujos que tocan varias tablas

Todos van en **una transacción**.

### 3.1 Tomar un pedido (POST /comandas)

No hay estado borrador: la comanda **nace ya en la cola de despacho**, con sus
líneas, en una sola transacción. "Crear" y "enviar a cocina" son el mismo acto,
porque cada envío es una comanda nueva. Por eso `items` es obligatorio y con al
menos uno — una comanda vacía sería un ticket en blanco en la pantalla del KDS.

```
1. Resolver fechaOperativa y turno:
     SELECT hayai_fecha_operativa(now(), r.zona_horaria, r.hora_corte_dia),
            hayai_turno(now(), r.zona_horaria)
   (usar las funciones SQL, NO reimplementar la regla en TypeScript)
2. Reservar número visible, atómico:
     INSERT INTO contador_dia (restaurante_id, fecha_operativa, ultimo_comanda, ultimo_cobro)
     VALUES ($1, $2, 1, 0)
     ON CONFLICT (restaurante_id, fecha_operativa)
     DO UPDATE SET ultimo_comanda = contador_dia.ultimo_comanda + 1
     RETURNING ultimo_comanda;
   (nunca MAX(numero_dia)+1: duplica números con dos meseros a la vez)
3. INSERT comanda (plantillaId = plantilla activa del salón). NO se manda
   `estado`: lo deriva el trigger. Sin timestamps, nace 'pendiente'.
   ⚠️ Ya NO hay 409 por mesa ocupada: la mesa acepta N comandas vivas.
4. INSERT de las líneas + recalcular `comanda.total`.
5. Si viene de reserva: UPDATE reservacion SET estado='sentada' (idempotente).
```

### 3.2 Despachar (POST /comandas/:id/despachar)

```
UPDATE comanda SET despachada_en = now()
 WHERE id = $1 AND despachada_en IS NULL AND anulada_en IS NULL AND cobro_id IS NULL;
→ 0 filas: 409 (ya se despachó, o está anulada). El predicado completo es lo que
  hace segura la doble pulsación de dos pantallas de cocina.
```
Sale de la cola (`v_cola_despacho`), **no se borra**: queda en la cuenta
cobrable de la mesa.

### 3.3 Cobrar la mesa (POST /mesas/:mesaId/cobrar)

El cobro es de la MESA, no de una comanda. Todo en una transacción:

```sql
BEGIN;
SELECT id, total, comensales, reservacion_id FROM comanda
 WHERE restaurante_id=$r AND mesa_id=$m
   AND cobro_id IS NULL AND anulada_en IS NULL AND despachada_en IS NOT NULL
   [AND id = ANY($comandaIds)]        -- cobro parcial
 ORDER BY creada_en
 FOR UPDATE;                          -- 0 filas -> 409 "esa mesa ya fue cobrada"
```

⭐ **El `FOR UPDATE` no es opcional y no se puede sustituir por un `findMany` de
Prisma.** Es lo único que serializa a dos cajeros cobrando la misma mesa: el
segundo espera el lock y, al reevaluar el predicado tras el COMMIT del primero,
encuentra 0 filas. Sin él salen dos facturas parciales y la caja del turno no
cuadra. Red de último recurso: el trigger diferido `cobro_no_vacio`.

```
2. Totales en el servidor desde las comandas BLOQUEADAS (jamás del cliente).
3. Tasa vigente DEL DÓLAR y congelarla en el cobro.
   ⚠️ `where: { restauranteId, divisa: 'USD' }`, `orderBy: [{ fecha: 'desc' },
   { creadaEn: 'desc' }]`. Sin el filtro de divisa la consulta puede devolver
   la cotización del EURO y convertir cada bolívar con un ~8-15 % de error.
   La base lo rechaza (trigger `cobro_tasa_base`), pero el cobro entero revienta
   con un 500: el filtro no es opcional. El desempate por `creadaEn` es
   obligatorio cuando conviven varias `fuente` el mismo día (§10.6).
4. Día operativo y turno DEL COBRO con las funciones SQL (nunca en TypeScript).
5. Número de factura: UPSERT atómico sobre contador_dia.ultimo_cobro.
6. INSERT cobro + UPDATE comanda SET cobro_id = $cobro WHERE id = ANY($ids).
7. INSERT de N cobro_pago. La suma de montoUsd debe cuadrar con total.
8. Si alguna comanda venía de una reservación y a esa reserva no le queda
   ninguna comanda viva: estado='completada'.
COMMIT;
```

**Lo que sigue en cocina NO se cobra** (CHECK `comanda_cobro_tras_despacho`): se
queda vivo y arranca la cuenta siguiente de la mesa. Es la regla que confirmó el
dueño. Verificación: `v_cobro_descuadre` debe seguir devolviendo 0 filas.

### 3.4 Clonar una plantilla

```
INSERT INTO plantilla (...) VALUES (..., clonada_de_id = $origen, activa = false);
INSERT INTO plantilla_mesa (restaurante_id, plantilla_id, mesa_id, pos_x, pos_y,
                            ancho, alto, rotacion, forma, capacidad, bloqueada)
SELECT restaurante_id, $nueva, mesa_id, pos_x, pos_y,
       ancho, alto, rotacion, forma, capacidad, bloqueada
  FROM plantilla_mesa WHERE plantilla_id = $origen;
```
Crear "desde plano vacío" = sólo el primer INSERT, sin el segundo.

### 3.5 Activar una plantilla

```
UPDATE plantilla SET activa=false WHERE salon_id=$s AND activa;
UPDATE plantilla SET activa=true  WHERE id=$nueva;
```
En la misma transacción. El índice `plantilla_activa_unica` impide dejar dos.
**Después de activar**, consultar `v_reservacion_huerfana`: si la nueva
distribución no incluye mesas que ya estaban reservadas, hay que avisar al
anfitrión (no bloquear: es una decisión suya).

### 3.6 Borrar una mesa — dos operaciones distintas

| Lo que el usuario quiere | Qué hace el backend |
|---|---|
| "Quitar esta mesa del plano" | `DELETE FROM plantilla_mesa WHERE plantilla_id=$p AND mesa_id=$m` |
| "Esta mesa ya no existe" | `UPDATE mesa SET eliminada_en=now(), activa=false` + quitarla de todas las plantillas |
| "Eliminar una distribución" | `UPDATE plantilla SET eliminada_en = now() WHERE id=$p`. Prohibido si es la activa del salón (409) |

Nunca `DELETE FROM mesa`: hay comandas y reservas históricas apuntando ahí, y la
FK es `RESTRICT` precisamente para que ese error salte en desarrollo. Lo mismo
aplica a `plantilla`: nunca `DELETE FROM plantilla` — es lo que preserva
`plantilla_mesa` y el histórico de comandas/reservaciones que apuntan a esa
distribución. `DELETE /plantillas/:id` es, por dentro, el UPDATE de arriba.

---

## 4 · Errores de base que hay que traducir

El backend **debe** capturarlos; son reglas de negocio, no fallos técnicos.

| Código PG | Objeto | HTTP | Mensaje sugerido |
|---|---|---|---|
| `23P01` | `reservacion_sin_solape` | 409 | "Esa mesa ya está reservada en ese horario" |
| `23505` | `plantilla_activa_unica` | 409 | "Ese salón ya tiene una plantilla activa" |
| `23505` | `mesa_etiqueta_unica` | 409 | "Ya existe una mesa con ese número" |
| `23505` | `comanda_numero_dia_unico` | 500 | Bug: el número se pidió sin el contador |
| `23505` | `cobro_numero_dia_unico` | 500 | Bug: el número de factura se pidió sin el contador |
| `23514` | `comanda_item_solo_pendiente` | **409** | "Esa comanda ya salió de cocina o se cobró: sus líneas no se pueden cambiar" |
| `23514` | `comanda_cobro_tras_despacho` | **409** | "No se puede cobrar una comanda que la cocina todavía no despachó" |
| `23514` | `comanda_anulada_no_cobrada` | **409** | "Una comanda cobrada no se puede anular, ni una anulada cobrar" |
| `23514` | `cobro_no_vacio` | **409** | "Esa cuenta ya la cobró otro cajero" — la factura fantasma, detectada en el COMMIT |
| `23514` | `cobro_totales_validos` / `cobro_tipo_coherente` | 422 | Según el constraint |
| `23514` | `cobro_pago_referencia_obligatoria` | 422 | "Pago móvil y transferencia exigen referencia" |
| `23514` | `cobro_pago_tasa_coherente` | 422 | "Un pago en Bs exige la tasa aplicada; uno en USD no debe llevarla" |
| `23514` | cualquier CHECK | 422 | Según el constraint (ver `01_constraints_y_triggers.sql`) |
| `23503` | cualquier FK | 422 | "El registro referenciado no existe" |
| `23503` | `comanda_restaurante_id_plantilla_id_fkey` | 422 | "No se puede eliminar: esta plantilla tiene comandas asociadas" — red de seguridad; `DELETE /plantillas/:id` es un borrado lógico y ya no dispara esta FK |
| `23503` | `reservacion_restaurante_id_plantilla_id_fkey` | 422 | "No se puede eliminar: esta plantilla tiene reservaciones asociadas" — red de seguridad, mismo caso |
| 409 (aplicación) | — | 409 | "No se puede eliminar la distribución activa del salón: activa otra primero" (`DELETE /plantillas/:id` sobre la plantilla activa, ver §3.6) |
| `23514` | `plantilla_eliminada_no_activa` | 422 | "No se puede activar una distribución eliminada" |
| `23514` | `plantilla_mesa_mismo_salon` | 422 | "Esa mesa pertenece a otro salón" |
| `23505` | `tasa_cambio_dia_unica` | 409 | "Ya existe una tasa para esa divisa, fecha y fuente" — **no debería verse**: `POST /tasa` es upsert |
| `23514` | `cobro_tasa_base` | **500** | Bug: se cobró con una tasa que no es la del dólar. Es un error del backend, no del usuario |
| `23514` | `tasa_divisa_inmutable` | 422 | "No se puede cambiar la divisa de una tasa ya registrada" |

---

## 5 · Endpoints esperados (sólo firmas)

Prefijo `/api/v1`. Todo lo que no cuelga de `/publico` exige sesión y resuelve
`restauranteId` **desde el token**, nunca desde el body o un header.

### Sesión
```
POST   /auth/login                 { usuario, clave }            -> { token, usuario }
POST   /auth/pin                   { usuario, pin }              -> { token, usuario }
GET    /auth/yo                                                  -> Usuario
```

### Salones y mesas
```
GET    /salones                                                  -> Salon[]
POST   /salones                    { nombre, orden? }            -> Salon
PATCH  /salones/:id                { nombre?, orden?, activo? }  -> Salon
DELETE /salones/:id                                              -> 204   (lógico)

GET    /mesas?salonId=                                           -> Mesa[]
POST   /mesas                      { salonId, etiqueta, capacidadDefault?, formaDefault? } -> Mesa
PATCH  /mesas/:id                  { etiqueta?, capacidadDefault?, formaDefault?, activa? } -> Mesa
DELETE /mesas/:id                                                -> 204   (lógico)
```

### Plantillas (editor de plano)
```
GET    /salones/:salonId/plantillas                              -> Plantilla[]
POST   /salones/:salonId/plantillas { nombre, anchoPlano?, altoPlano? } -> Plantilla
GET    /plantillas/:id                                           -> Plantilla & { mesas: PlantillaMesa[] }
PATCH  /plantillas/:id             { nombre?, descripcion?, anchoPlano?, altoPlano? } -> Plantilla
DELETE /plantillas/:id                                           -> 204 | 409 si es la activa | 404 si no existe
       // Borrado lógico (§3.6): no borra `plantilla_mesa` ni el histórico.
POST   /plantillas/:id/clonar      { nombre }                    -> Plantilla
POST   /plantillas/:id/activar                                   -> { plantilla, reservacionesHuerfanas: Reservacion[] }

PUT    /plantillas/:id/mesas       { mesas: PlantillaMesaInput[] } -> PlantillaMesa[]
       // Guarda el layout COMPLETO de una vez (lo que produce el drag & drop).
       // Reemplaza el set: inserta las nuevas, actualiza las movidas, borra las
       // que ya no vienen. En una transacción.
POST   /plantillas/:id/mesas       { mesaId?, etiqueta?, posX, posY, ... } -> PlantillaMesa
       // mesaId ausente = crea también la `mesa` (añadir mesa nueva al plano).
PATCH  /plantillas/:id/mesas/:mesaId { posX?, posY?, ancho?, alto?, rotacion?, forma?, capacidad?, bloqueada? }
DELETE /plantillas/:id/mesas/:mesaId                             -> 204   (la quita del plano, no borra la mesa)
```

### Vista operativa del plano
```
GET    /plano?salonId=&plantillaId=                              -> MesaEstado[]   (vista v_mesa_estado)
```

### Reservaciones (staff)
```
GET    /reservaciones?desde=&hasta=&estado=&mesaId=              -> Reservacion[]
POST   /reservaciones              { salonId, mesaId?, clienteNombre, clienteTelefono?, personas, iniciaEn, duracionMin?, notas? }
GET    /reservaciones/:id                                        -> Reservacion
PATCH  /reservaciones/:id          { ...campos editables }       -> Reservacion
POST   /reservaciones/:id/confirmar                              -> Reservacion
POST   /reservaciones/:id/cancelar { motivo }                    -> Reservacion
POST   /reservaciones/:id/no-show                                -> Reservacion
POST   /reservaciones/:id/sentar   { mesaId?, comensales? }      -> { reservacion, comanda }
GET    /reservaciones/:id/qr                                     -> image/png
GET    /reservaciones/huerfanas                                  -> Reservacion[]  (vista v_reservacion_huerfana)
```

### Reservaciones (público, sin sesión — rate-limit obligatorio)
```
GET    /publico/r/:slug/disponibilidad?fecha=&personas=          -> { mesas: MesaDisponible[] }
POST   /publico/r/:slug/reservaciones { clienteNombre, clienteTelefono, personas, iniciaEn, mesaId? }
                                                                 -> { codigoPublico, codigoCorto, qrUrl }
GET    /publico/reserva/:codigoPublico                           -> ReservacionPublica
POST   /publico/reserva/:codigoPublico/mesa    { mesaId }        -> ReservacionPublica
POST   /publico/reserva/:codigoPublico/checkin                   -> ReservacionPublica
```
> `ReservacionPublica` NO expone ids internos de otras reservas ni datos de otros
> clientes: sólo la propia reserva y las mesas **disponibles** de la plantilla activa.

### Menú
```
GET    /categorias                                               -> Categoria[]
POST   /categorias                 { nombre, orden? }            -> Categoria
PATCH  /categorias/:id                                           -> Categoria
DELETE /categorias/:id                                           -> 204   (lógico)

GET    /productos?categoriaId=&soloDisponibles=                  -> Producto[]
POST   /productos                  { categoriaId, nombre, precio, destino, ... } -> Producto
PATCH  /productos/:id                                            -> Producto
PATCH  /productos/:id/disponibilidad { disponible }              -> Producto
DELETE /productos/:id                                            -> 204   (activo=false)
```

### Uploads (imágenes)
```
POST   /uploads/productos          multipart/form-data { archivo: File } -> { url: string }
```

Sube la foto de un producto. **No** está acoplado a `POST /productos`: el
frontend llama primero a este endpoint, y guarda la `url` que devuelve como
`imagenUrl` en el `POST`/`PATCH` de producto ya existente — así el usuario
puede subir/reemplazar la foto sin que eso dispare por sí solo un cambio de
producto.

- Campo del `multipart/form-data`: **`archivo`** (un solo archivo).
- Exige sesión igual que el resto de `/productos` (no cuelga de `/publico`).
- Tipos aceptados: `image/jpeg`, `image/png`, `image/webp`. Cualquier otro
  mimetype → **400** `"Solo se permiten imágenes JPG, PNG o WEBP"`.
- Tamaño máximo: **5MB**. Si se excede → **413** (Payload Too Large).
- El nombre de archivo en disco es un `uuid` generado en el servidor con la
  extensión derivada del mimetype ya validado — **nunca** el `originalname`
  del cliente, ni para el nombre ni para la extensión (evita path traversal y
  colisiones).
- Se guarda en disco, LOCAL al proyecto backend, en `uploads/productos/` (raíz
  del repo, hermano de `src/` — no dentro de `src/`, que se borra en cada
  build). Constante: `CARPETA_UPLOADS_RAIZ` en `src/uploads/uploads.service.ts`.
- Se sirve como estático con `app.useStaticAssets(...)` (`main.ts`), montado en
  el prefijo `/uploads`, **fuera** de `/api/v1` a propósito: la URL que
  devuelve el endpoint (`{ "url": "/uploads/productos/<uuid>.jpg" }`) es
  exactamente la que consume el `<img>` del frontend, sin que este tenga que
  conocer el prefijo de la API. Para pedirla completa: `<URL_BACKEND>` + esa
  ruta (mismo host que el resto de la API).

> ⚠️ **Infraestructura — pendiente de decisión antes de confiar en esto en
> producción.** `uploads/` vive en el filesystem del contenedor. El
> `Dockerfile` actual no declara ningún volumen: en Railway (o cualquier
> despliegue basado en contenedores), el filesystem de un contenedor es
> efímero y **cada redeploy crea un contenedor nuevo con el disco en blanco**.
> Con la configuración de hoy, las imágenes subidas **se pierden en el
> siguiente deploy**. Para que sobrevivan hace falta:
> 1. Un **volumen persistente** en Railway montado en `/app/uploads` (el
>    `WORKDIR` del `Dockerfile` es `/app`), o el equivalente si cambia el
>    despliegue.
> 2. Si el servicio llega a correr con más de una réplica a la vez, un volumen
>    normal de Railway es de un solo adjunto (single-attach): con varias
>    réplicas cada una vería un disco distinto y la imagen subida en una no
>    se vería en las demás. Para ese escenario habría que migrar a storage
>    compartido (S3-compatible) en vez de disco local — pero **hoy no hace
>    falta**: el pedido explícito fue "guardar local dentro del proyecto
>    backend", y una sola réplica no tiene este problema.
> Esta decisión de infraestructura no se resuelve desde el código: la deja
> documentada D.A.N.I para que el dueño del producto la tome antes de
> considerar esto listo para producción.

### Comandas, despacho y cobro
```
POST   /comandas                   { tipo, mesaId?, comensales?, reservacionId?, notas?,
                                     items: [{ productoId, cantidad, nota? }] }  -> Comanda & { items }
                                   (items OBLIGATORIO, min 1: nace ya en la cola)
GET    /comandas/:id                                             -> Comanda & { items, mesa, cobro }
POST   /comandas/:id/items         { items: [{ productoId, cantidad, nota? }] } -> ComandaItem[]
PATCH  /comandas/:id/items/:itemId { cantidad?, nota? }          -> ComandaItem
DELETE /comandas/:id/items/:itemId { motivo }                    -> 204   (canceladoEn, no borra)
POST   /comandas/:id/despachar                                   -> Comanda & { items }
POST   /comandas/:id/mover         { mesaIdDestino }             -> Comanda
POST   /comandas/:id/anular        { motivo }                    -> Comanda

GET    /despacho/cola                                            -> ColaDespacho[]  (v_cola_despacho, FIFO global, items embebidos)
GET    /cuentas-por-cobrar                                       -> CuentaMesa[]    (v_cuenta_mesa, comandas_por_cobrar > 0)
GET    /mesas/:mesaId/cuenta                                     -> { mesa, cuenta, comandas }
POST   /mesas/:mesaId/cobrar       { propina?, descuento?, comandaIds?, pagos: PagoInput[] }
                                                                 -> Cobro & { pagos, comandas }
GET    /cobros/:id                                               -> Cobro & { pagos, comandas, mesa }
POST   /cobros/:id/anular          { motivo }                    -> Cobro
```

**Los cuatro que desaparecieron y por qué** (el frontend viejo los llama):

| Se fue | Qué usar | Por qué |
|---|---|---|
| `GET /comandas/activas` | `GET /cuentas-por-cobrar` + `GET /despacho/cola` | La vista `v_comanda_activa` ya no existe: "comanda activa" mezclaba pedido y cuenta, que ahora son dos cosas |
| `POST /comandas/:id/enviar` | nada: `POST /comandas` ya encola | No hay borrador; cada envío es una comanda |
| `PATCH /comandas/:id/items/:itemId/estado` | nada | No hay workflow por ítem: cocina y barra despachan la comanda entera |
| `POST /comandas/:id/cuenta` | nada | No existe el estado `por_cobrar`; una comanda despachada ya es cobrable |
| `POST /comandas/:id/cobrar` | `POST /mesas/:mesaId/cobrar` | Se cobra la mesa, no un pedido suelto |
| `GET /cocina/cola?destino=` | `GET /despacho/cola` | Una sola cola global, por comanda y no por ítem |

> `POST /reservaciones/:id/sentar` y el check-in público ya **no abren comanda**:
> devuelven sólo `{ reservacion }` con `estado='sentada'` (antes devolvían
> `{ reservacion, comanda }`). Una comanda es un pedido y exige al menos una
> línea; la primera la crea el mesero al tomar la nota, idealmente pasando
> `reservacionId`.
>
> ⭐ **La mesa queda ocupada igual, desde el escaneo.** `v_mesa_estado` cuenta
> una reserva `sentada` como ocupación por sí sola, sin comanda: el plano
> devuelve `estado='ocupada'` en cuanto se hace check-in, así que el refresco no
> pisa el estado optimista que pinta el frontend. Se libera al cobrar la mesa, o
> cancelando la reserva / marcándola no-show.

### Reportes y tasa
```
GET    /reportes/ventas?periodo=dia|mes|anio&fecha=              -> ReporteVentas
GET    /reportes/productos?periodo=&fecha=&desde=&hasta=&orden=cantidad|ingreso&limite=
                                                                 -> ProductoVendido[]
GET    /reportes/dia?fecha=                                      -> { porTurno: VentaDia[], total: VentaDia }
GET    /reportes/cierre-caja?fecha=                              -> { porMetodo: VentaMetodo[], descuadres: Descuadre[] }
GET    /tasa/vigente                                             -> TasasVigentes
POST   /tasa                       CrearTasaDto                  -> TasaCambio
```

En los cuatro endpoints de reporte **`fecha` es opcional**: ausente significa
*el día operativo en curso*, y lo resuelve el backend. Ver abajo por qué eso
importa.

#### `GET /reportes/ventas` — el apartado de ventas (día / mes / año)

Un solo endpoint para los tres filtros. La respuesta tiene **la misma forma en
los tres casos**, así que tres rutas (`/dia`, `/mes`, `/anio`) serían tres
copias del mismo handler y obligarían al frontend a elegir función según el
botón pulsado en vez de pasar el filtro como dato.

```ts
type PeriodoReporte = 'dia' | 'mes' | 'anio';   // sin eñe: viaja en la URL
type GranularidadSerie = 'turno' | 'dia' | 'mes';

interface ReporteVentas {
  periodo: PeriodoReporte;
  /** Día operativo ancla ya resuelto, 'YYYY-MM-DD'. */
  fecha: string;
  /** Primer y último día operativo incluidos, ambos inclusive. */
  desde: string;
  hasta: string;
  /** El tramo llega a hoy: la cifra todavía se mueve. */
  enCurso: boolean;
  total: VentaResumen;
  granularidad: GranularidadSerie;
  /** Desglose interno, DENSO (los buckets sin venta vienen en cero). */
  serie: VentaPunto[];
  comparacion: { desde: string; hasta: string; total: VentaResumen };
}

interface VentaResumen {
  /**
   * Facturas emitidas = mesas atendidas. ⚠️ CAMBIO DE CONTRATO: se llamaba
   * `comandas` cuando una comanda ERA la cuenta de la mesa. Hoy una mesa genera
   * varias comandas y UNA factura, así que contar comandas ya no respondía
   * "cuántas mesas vendimos" ni servía de denominador del ticket promedio.
   */
  cobros: number;
  comensales: number;
  totalUsd: string;
  /** Total SIN propina: la propina es del mesero, no ingreso del local. */
  ventasUsd: string;
  propinasUsd: string;
  descuentosUsd: string;
  impuestosUsd: string;
  /** totalUsd / cobros. '0.0000' si el tramo no tuvo ventas. */
  ticketPromedioUsd: string;
}

interface VentaPunto extends VentaResumen {
  /** 'almuerzo' | '2026-09-14' | '2026-09', según `granularidad`. */
  clave: string;
}
```

| `periodo` | Rango | `granularidad` | `serie` |
|---|---|---|---|
| `dia` | ese día operativo | `turno` | 4 puntos: desayuno, almuerzo, cena, madrugada |
| `mes` | del 1 al fin de mes, recortado a hoy | `dia` | un punto por día operativo |
| `anio` | del 1-ene al 31-dic, recortado a hoy | `mes` | un punto por mes |

**Todo se agrega por día operativo, no por calendario.** Es la regla de la que
cuelga que el reporte sea correcto: `cobro.fecha_operativa` se materializa AL
COBRAR con `hayai_fecha_operativa(now(), zona, hora_corte)` (§3.3,
`docs/DECISIONES-DATOS.md §5`), y el mes y el año son la **suma de esos días**,
no un `BETWEEN` sobre `creado_en`. Con corte a las 05:00, una cuenta cobrada a
la 01:00 del 1 de octubre entra en **septiembre**. Verificado en
`test/reportes-periodo.e2e-spec.ts`.

⚠️ El día que cuenta es el **del cobro**, no el del pedido: la venta se reconoce
cuando entra el dinero, para que el reporte cuadre con la caja física al cerrar
el turno. Una mesa que pide a las 23:50 y paga a las 00:10 factura en el turno
que cerró. "Cuántos pedidos salieron" es otra pregunta, y se responde por
`comanda.despachada_en`.

**`fecha` la resuelve el backend.** Hoy `useSalesReport.ts` calcula el día
operativo en el navegador asumiendo corte a las 05:00 y zona local — el propio
comentario del archivo dice que habría que alimentarlo desde el backend. Ya se
puede: llamar sin `fecha` devuelve el día operativo de verdad en `fecha`, y ese
valor sirve para las demás llamadas (`cierre-caja`, etc.). El frontend no
necesita saber ni la zona horaria ni la hora de corte.

**`desde`/`hasta` vienen recortados a hoy.** Un mes en curso responde
`2026-09-01 .. 2026-09-14`, no `.. 2026-09-30`, para que la UI pueda rotular el
rango sin prometer un mes entero. `enCurso` dice si la cifra es parcial.

**La comparación es honesta por construcción:** el período anterior **completo**
si el consultado ya cerró (junio contra mayo entero, aunque mayo tenga 31 días),
y el **mismo número de días transcurridos** si está en curso (1–14 de septiembre
contra 1–14 de agosto). Comparar catorce días contra un mes completo, o recortar
mayo a 30 días para que "quepa" en junio, son las dos formas fáciles de que el
dashboard mienta.

**El dinero viaja como `string`**, no como `number`: las columnas son
`numeric(14,4)` y pasarlas por un float de JavaScript mete error de redondeo
justo donde el dueño cuadra la caja. El frontend formatea; no opera.

**La serie es densa**: los turnos sin venta, los días cerrados y los meses que
aún no llegaron vienen en cero. Una serie con huecos hace que una gráfica de
barras comprima el eje y dibuje un mes sin domingos como si se hubiera vendido
todos los días.

**Errores:** `periodo` fuera de la lista → **400** (sin validarlo, un
`?periodo=semana` caería en la rama del año y devolvería el año sin avisar);
`fecha` con formato distinto de `YYYY-MM-DD` → **400**; fecha inexistente
(`2026-02-31`) → **422**.

> ⚠️ **Convención de mayúsculas.** `/reportes/ventas` responde en camelCase, con
> una forma propia que no depende de las columnas de la vista. Los otros tres
> endpoints de reporte siguen devolviendo **filas crudas en snake_case**
> (`total_usd`, `producto_nombre`) porque el frontend desplegado ya tiene
> adaptadores para ellas (`httpClient.ts`). No es un descuido: cambiarlas
> rompería la pantalla de hoy. Lo nuevo se escribe con la forma nueva.

#### `GET /reportes/productos` — el mismo período, el mismo rango

Acepta `periodo` y `fecha` igual que `/reportes/ventas`, para que el ranking del
mes o del año no dependa de que el frontend adivine el rango de días operativos.
Orden de resolución del rango:

1. `periodo` (+ `fecha` opcional) — manda sobre todo lo demás;
2. `desde` + `hasta` — el camino que usa el frontend desplegado, intacto;
3. nada — el día operativo en curso. (Antes devolvía `[]` aunque el día tuviera
   ventas: sin `desde`/`hasta` la consulta comparaba contra `NULL`.)

La forma de las filas **no cambia** (snake_case, ver el aviso de arriba).

#### `GET /reportes/dia` — sigue igual, y queda superado

Misma ruta, misma respuesta, mismos nombres de campo. Lo único que cambia es que
`fecha` pasa a ser opcional. `GET /reportes/ventas?periodo=dia` devuelve lo mismo
y además el desglose por turno ya sumado, en camelCase: cuando la pantalla de
ventas migre, este endpoint se puede retirar.

#### `GET /tasa/vigente` — el dólar y el euro en UNA petición

Devuelve **siempre 200**, aunque no haya ninguna tasa cargada. El estado
"todavía no hay tasa" es un estado vacío, no un error: hoy el endpoint lanza
un 400 y el frontend lo caza con un `try/catch` para convertirlo en `null`
(`httpClient.ts`). Ese apaño desaparece — y con dos divisas ya no valdría,
porque puede haber dólar sin euro.

```ts
interface TasasVigentes {
  /** 'YYYY-MM-DD': hoy según la zona horaria del restaurante. */
  fecha: string;
  usd: TasaCambio | null;
  eur: TasaCambio | null;
}
```

La clave es el código de divisa en minúsculas. Añadir una divisa más adelante
es **aditivo**: aparece una clave nueva y nada existente cambia de forma.

**Cómo se resuelve "vigente"** — la última registrada, no necesariamente la de
hoy: `WHERE restaurante_id = ? AND divisa = ?` `ORDER BY fecha DESC, creada_en
DESC LIMIT 1`.

> ⚠️ El `ORDER BY` **tiene que llevar `creada_en DESC`** como desempate. Con
> varias `fuente` para la misma divisa y día (BCV y Binance), ordenar sólo por
> `fecha` deja a Postgres elegir la fila, y el resultado cambia entre
> ejecuciones. Esto ya pasaba antes de las divisas en `cobrar()`; corregirlo es
> parte de este cambio. `fuente` es metadato, no un selector: gana la última
> registrada.

**Tasa vieja.** El endpoint devuelve la última aunque sea de hace tres días. La
UI compara `usd.fecha` con `fecha` y avisa ("tasa del 11/09") en vez de
presentar como de hoy una cotización vencida. No se devuelve un booleano
derivado: con los dos campos el frontend lo calcula y no hay dos verdades.

**Conversión (todo en el frontend, nada se persiste):**

```
Bs  = USD × usd.valor                 USD = Bs ÷ usd.valor
Bs  = EUR × eur.valor                 EUR = Bs ÷ eur.valor
EUR = USD × usd.valor ÷ eur.valor     ← cruce a través del bolívar
```

> El equivalente en euros es **informativo**. No se cobra en euros, no se
> guarda y no entra en ningún total. Ver §D13.

#### `POST /tasa` — registrar o corregir

```ts
class CrearTasaDto {
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  valor!: number;

  @IsEnum(FuenteTasa)
  fuente!: FuenteTasa;

  /** Ausente = 'USD'. Ver abajo por qué es opcional. */
  @IsOptional()
  @IsEnum(Divisa)
  divisa?: Divisa;
}
```

`divisa` es **opcional con default `'USD'`** a propósito: el frontend ya
desplegado llama `registrarTasa(valor, fuente)` sin divisa desde el diálogo de
"no hay tasa, regístrala para cobrar" (`ComandaCard.tsx`), y ese diálogo habla
del dólar. Con el default, ese camino sigue siendo correcto sin tocarlo.

`maxDecimalPlaces: 8` iguala la precisión de la columna: sin él, `912.123456789`
se redondea en silencio al guardarse.

**Es un upsert** sobre la clave natural `(restauranteId, divisa, fecha, fuente)`,
no un `create`. Corregir un tipeo en la tasa del día es una operación normal, y
es **seguro para el histórico**: al cobrar, la comanda se queda con su propia
copia en `tasa_valor`, así que actualizar la fila de hoy no reescribe ningún
ticket ya emitido (verificado, §10 de DECISIONES-DATOS). Como `@@unique` con
campos no nulos, `prisma.tasaCambio.upsert()` puede expresarlo directamente.

**Aviso de banda, en la UI y no en la base:** si el valor nuevo se aparta más de
~10 % del anterior de esa divisa, conviene pedir confirmación ("¿seguro?
ayer era 912,50"). Es un *aviso*, nunca un bloqueo: la tasa puede saltar de
verdad y la base no tiene forma de saber cuál es la magnitud correcta.

---

## 6 · Consultas clave (ya resueltas en vistas)

| Necesidad de negocio | Cómo se resuelve |
|---|---|
| Pintar el plano con el estado de cada mesa | `SELECT * FROM v_mesa_estado WHERE plantilla_id = $1` |
| ¿Por qué está ocupada esta mesa? | `v_mesa_estado`: `comandas > 0` (ya pidió) y/o `sentada_reservacion_id` (hizo check-in y aún no pide) |
| Cola de cocina / barra (KDS) | `SELECT * FROM v_cola_despacho WHERE restaurante_id = $1 ORDER BY creada_en` — FIFO global, líneas embebidas en jsonb |
| Cuentas por cobrar / ficha de mesa ocupada | `SELECT * FROM v_cuenta_mesa WHERE restaurante_id = $1 [AND comandas_por_cobrar > 0]` |
| Ventas del día y por turno | `SELECT * FROM v_venta_dia WHERE restaurante_id=$1 AND fecha_operativa=$2` |
| **Ventas del mes / del año** | La MISMA vista con `fecha_operativa BETWEEN $2 AND $3`. El mes es la suma de sus días operativos: no hay vista nueva ni `date_trunc` sobre `creado_en` |
| Cierre de caja por método de pago | `v_venta_dia_metodo` |
| **Producto más vendido** | `SELECT * FROM v_producto_vendido_dia WHERE ... ORDER BY cantidad DESC LIMIT 10` (o `ingreso_usd DESC`) |
| Reservas que quedaron fuera del plano | `v_reservacion_huerfana` |
| Cuadre de cobros | `v_cobro_descuadre` — debe dar 0 filas siempre |

> "Producto más vendido" tiene **dos respuestas distintas** y la vista devuelve
> las dos: por `cantidad` gana la empanada, por `ingreso_usd` gana el solomo. La
> UI debe decir cuál está mostrando.

---

## 7 · Lo que NO está en el MVP (y cómo entra después sin romper nada)

| Funcionalidad | Cómo se añade |
|---|---|
| Dividir la cuenta entre comensales | Tabla `comanda_cuenta` + `comanda_item.cuenta_id`. No toca lo existente |
| Modificadores con precio ("extra queso +1$") | `comanda_item_modificador`; el snapshot ya está en la línea |
| Rollup `resumen_dia` | La tabla ya está modelada. Se llena al emitir/anular un **cobro** y el dashboard histórico cambia de vista a tabla. **Todavía no hace falta**: medido abajo. ⚠️ Su columna `comandas` pasaría a contar cobros, como `v_venta_dia` |
| Vista materializada de reportes | Sólo si `v_producto_vendido_dia` pasa de ~300 ms. Ver `docs/DECISIONES-DATOS.md §Reportes` |
| Vistas `v_venta_mes` / `v_venta_anio` | **Descartadas.** Serían una segunda definición de "qué cuenta como venta", capaz de quedarse atrás respecto a `v_venta_dia`, a cambio de un `GROUP BY` que ya es barato |
| Multi-sucursal / SaaS | `restauranteId` ya está en todo: se activa `prisma/sql/03_rls.sql` |
| Inventario y recetas | Tablas nuevas; `comanda_item` ya tiene el consumo por producto |
| Auditoría completa | `evento_auditoria` como en hayai-saas. Hoy sólo hay trazas de anulación y cancelación |

**La medida que sostiene "todavía no hace falta rollup"** (2026-09-14): con
**73.000 comandas y 219.000 líneas** sembradas sobre un año —un restaurante de
200 comandas diarias, muy por encima del caso real— el total del año completo
sobre `v_venta_dia` responde en **~77 ms de mediana**. Y eso midiendo sobre un
PostgreSQL 17 compilado a wasm de 32 bits, que es varias veces más lento que un
servidor de verdad. El primero en acercarse al umbral será el ranking de
productos del año (`v_producto_vendido_dia` cruza `comanda_item`), que es
justo el caso que `docs/DECISIONES-DATOS.md §6` ya marcó en ~300 ms. El orden
sigue siendo el de §D11: **primero medir, después desnormalizar.**

---

## 8 · Puesta en marcha (para D.A.N.I)

```
npm i -D prisma@7 && npm i @prisma/client@7 @prisma/adapter-pg
# copiar prisma7.config.ts y .env.example -> .env

npx prisma migrate dev --create-only --name fundacion
#  1. pegar prisma/sql/00_extensiones.sql          AL PRINCIPIO del migration.sql
#  2. pegar 01_constraints_y_triggers.sql y 02_vistas.sql AL FINAL
#  3. 03_rls.sql: sólo cuando entre el 2º restaurante o se publique el enlace
#     público de reservas (ver el encabezado del archivo)
npx prisma migrate dev
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/sql/99_verificar_objetos.sql
```

**Regla permanente:** generar siempre con `--create-only`, leer el SQL, y borrar
cualquier `DROP INDEX` que apunte a un índice de `prisma/sql/`. Prisma no conoce
los índices parciales y los considera basura. `99_verificar_objetos.sql` en CI
convierte ese fallo silencioso en un build roto.
