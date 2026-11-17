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
>
> ⚠️ **2026-11-05 — cliente como unidad de cobro y factura por líneas**
> (migraciones `20261105120000` y `20261105120100`; backend implementado por
> **D.A.N.I**). Otro cambio **ROMPEDOR**, y este documento ya está reescrito para
> él: se cobra al CLIENTE (no a la mesa), la factura cubre LÍNEAS
> (`comanda_item.cobroId`; `comanda.cobroId` y `v_cuenta_mesa` ya no existen), las
> comandas y facturas ya emitidas se pueden corregir (las facturas, de cualquier
> día, con cobro adicional o devolución), y todo queda en la `bitacora`.
> **Es la fuente del frontend**: relee §0, §1 (`cobrada_parcial`), §2.8b-§2.12,
> §3.1-§3.3b, §4, §5.1 y, sobre todo, **§5 · "Clientes, comandas, despacho y
> cobro"** (rutas, cuerpos, respuestas, errores, ejemplos y la tabla de rutas
> retiradas). El porqué de cada decisión de datos: `docs/DECISIONES-DATOS.md §15`.

---

## 0 · Mapa mental en una pantalla

```
restaurante
  └── salon ("Salón principal", "Terraza")         ← espacio FÍSICO
        ├── mesa ("5", "T-2")                      ← IDENTIDAD estable
        └── plantilla ("Normal", "Evento boda")    ← DISTRIBUCIÓN, 1 activa por salón
              └── plantilla_mesa                   ← posición + tamaño + sillas
                     (plantilla × mesa)

reservacion ── (al sentarla / check-in) ──┐
                                           ↓
                        cliente  (una VISITA: nombre, mesa opcional)   ← LA UNIDAD DE COBRO
                           │  └── ocupa la mesa mientras esté abierto y sentado
                           │
             el mesero toma nota (POST /comandas { clienteId })
                           ↓
                      comanda ──> comanda_item (clienteId = deudor, cobroId = factura | null)
                       UN PEDIDO         ↑
                                    producto ← categoria
                           │
        al cobrar, las líneas ELEGIDAS del cliente pasan a una factura
                           ↓
                       cobro ──> cobro_pago (de sólo agregar; devolución = monto < 0)
                         ↓ (toda corrección)
                      bitacora  (triggers; autor = la sesión)
```

Las ideas que hay que entender antes de tocar código:

1. **La mesa y su sitio en el plano son dos cosas distintas.** `mesa` es la
   identidad ("Mesa 5"); `plantilla_mesa` es dónde está dibujada, cuánto mide y
   cuántas sillas tiene *en esa distribución*. Así la misma mesa puede ser de 4
   sillas en la distribución normal y de 10 en un banquete, y el histórico de
   ventas de la Mesa 5 sobrevive a cualquier rediseño del salón.
2. **Se cobra al CLIENTE, no a la mesa.** Un `cliente` es una visita (nombre, mesa
   opcional, deuda). La mesa está ocupada si y solo si hay un cliente ABIERTO
   sentado en ella (puede haber varios, con cuentas separadas); un cliente sin
   mesa también pide y paga. Su **deuda** son sus líneas sin factura. Una
   **comanda** es UN PEDIDO (lo que se manda a cocina de una vez): cada envío
   crea una comanda nueva. Cobrar = elegir líneas (o una parte de una) y emitir
   una **factura** que las cubre; lo no facturado sigue siendo deuda del mismo
   cliente y se puede reasignar a otro.
   *(Hasta 2026-11-05 el cobro era de la mesa y la factura cubría comandas
   enteras; hasta 2026-09-15 una comanda ERA la cuenta de la mesa.)*
3. **`comanda.estado` y `comanda.total` son DERIVADOS.** No se escriben: los
   calcula el trigger `comanda_estado` a partir de `despachadaEn`, `anuladaEn` y
   del estado de facturación de sus líneas. Para mover una comanda se escribe el
   hecho, nunca el estado; mandarlo en un PATCH no hace nada.
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
///   pendiente       = en la cola de despacho            (despachadaEn = null)
///   despachada      = salió de cocina, nada facturado   (despachadaEn ≠ null)
///   cobrada_parcial = algunas líneas facturadas y otras vivas sin factura
///                     (cobro dividido, o línea agregada después de cobrar)
///   cobrada         = todas sus líneas vivas están facturadas
///   anulada         = descartada                        (anuladaEn ≠ null)
type EstadoComanda     = 'pendiente' | 'despachada' | 'cobrada_parcial' | 'cobrada' | 'anulada';
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
/// Una entrada del menú del frontend (añadido 2026-09-18, §5.1). El nombre es
/// el de la PANTALLA, no el de la ruta: /comandas = despacho, /cuentas = por_cobrar.
/// 'configuracion' y 'meseros' son sólo del administrador (CHECK en la base).
type ModuloApp         = 'mesas' | 'mesero' | 'despacho' | 'por_cobrar' | 'reservaciones'
                       | 'checkin' | 'escanear' | 'productos' | 'ventas'
                       | 'configuracion' | 'meseros';
/// + 'acceso_sospechoso' (2026-09-18): sólo administrador, ver §5 Accesos.
type TemaNotificacion  = 'comanda_cocina' | 'comanda_barra' | 'cuenta_por_cobrar'
                       | 'reservacion_nueva' | 'acceso_sospechoso';

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
`claveHash?`, `pinHash?` (login rápido de mesero), `rol: RolUsuario`,
`modulos: ModuloApp[]`, `accesoHasta?`, `activo`, `ultimoAccesoEn?`.

**Añadido 2026-09-18 (accesos temporales, docs/DECISIONES-DATOS.md §13):**

- `accesoHasta` NULL = personal permanente (entra con usuario/clave o PIN).
  NOT NULL = **acceso temporal**: rol `mesero`, sin clave ni PIN, entra SÓLO por
  su enlace + código (`POST /auth/acceso`). Vencido = `accesoHasta <= ahora`: no
  hay job ni columna de estado.
- `modulos` en el **wire** (login, canje, `GET /auth/yo`) son los EFECTIVOS: el
  administrador recibe los 11; cualquier otro, exactamente su columna. El
  frontend pinta el menú con esto y coincide con lo que deja pasar el backend.
- `claveHash`/`pinHash` no salen nunca por la API.

### 2.2b InvitacionAcceso (no se expone)

La credencial de un acceso temporal: `enlaceHash` (SHA-256 del token),
`codigoHash` (Argon2id del código de 4 dígitos), `fallosConsecutivos`,
`ultimoFalloEn`, `otorgadaPorId`, `emitidaEn`. 1:1 con el usuario temporal.
**Ninguna respuesta la serializa.** El enlace y el código en claro salen una
sola vez: en `POST /accesos` y en `POST /accesos/:id/regenerar`.

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

### 2.8b Cliente — la unidad de cobro          *(añadido 2026-11-05)*

Una **visita**: quién consume, dónde está sentado y qué debe. No es un CRM de
clientes frecuentes. Abierto ⟺ `cerradoEn == null` (no hay enum de estado).

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `restauranteId` | uuid | |
| `nombre` | string | Trim, no vacío (CHECK `cliente_nombre_normalizado`), máx. 120 en el DTO |
| `mesaId` | uuid? | Dónde está sentado AHORA. NULL = sin mesa (barra, de pie, para llevar) |
| `reservacionId` | uuid? | La reserva que lo trajo. A lo sumo UN cliente abierto por reserva (`cliente_reservacion_abierta_unica`) |
| `fechaOperativa` | date | Día operativo de apertura |
| `creadoPorId?`, `creadoEn` | | |
| `cerradoEn?`, `cerradoPorId?` | | Cerrado ⟺ `cerradoEn != null` |

- **No se cierra con deuda** (trigger `cliente_cierre_sin_deuda`) y **no se le anota
  deuda cerrado** (`cliente_cerrado`): el servidor da el 409 con mensaje; la base es
  la red. Reabrir = `cerradoEn = NULL` (`POST /clientes/:id/reabrir`).
- Dos clientes en la misma mesa son legales. La mesa no tiene "historial de
  asiento" propio: cada cambio de `mesaId` queda en la bitácora y cada comanda
  congela la mesa donde se sirvió.
- **Deuda viva** = líneas con `cobroId = null`, `canceladoEn = null` y deudor = el
  cliente, en comandas no anuladas. Lo que sigue en cocina cuenta.

### 2.9 Comanda — UN PEDIDO

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `restauranteId` | uuid | |
| `clienteId` | uuid | **OBLIGATORIO.** Para quién se pidió (lo que lee cocina). Quién DEBE cada línea es `comandaItem.clienteId` (igual salvo reasignación) |
| `tipo` | TipoComanda | `mesa` = en el local, **con o sin mesa** asignada; `para_llevar` exige `mesaId` NULL. Con mesa, exige `salonId`+`plantillaId` |
| `salonId`, `mesaId`, `plantillaId` | uuid? | **FOTO** de dónde estaba sentado el cliente al pedir. NULL si no tenía mesa |
| `numeroDia` | int | Número visible del pedido. Único por `(restaurante, fechaOperativa)` |
| `fechaOperativa`, `turno` | | Día contable **del pedido**. No es el de la venta: ese es `cobro.fechaOperativa` |
| `comensales` | int | |
| `meseroId` | uuid? | |
| `estado` | EstadoComanda | **DERIVADO** por trigger. No se escribe |
| `despachadaEn?` | datetime | La cocina lo sacó. NULL = sigue en la cola |
| `anuladaEn?` | datetime | Descartado. Imposible si alguna línea tiene factura |
| `total` | decimal | USD. **DERIVADO**: suma de sus líneas vivas (facturadas o no). Lo recalcula el trigger |
| `anuladaPorId?`, `motivoAnulacion?`, `notas?` | | |
| `reservacionId?`, `clienteNombre?` | | **LEGADO** (histórico). La autoridad es el cliente; no decidir con estas columnas |

> **Lo que se fue de aquí:** `cobroId` (la factura vive en la LÍNEA);
> `ronda`, `abiertaEn`/`cerradaEn`, `subtotal`/`descuento`/`impuesto`/`propina`
> y `tasa*` (viven en `Cobro`).
>
> **Invariantes que la base hace cumplir:** no se factura lo que no salió de cocina
> (`comanda_cobro_tras_despacho`); una comanda con líneas facturadas no se anula
> (`comanda_anulada_no_cobrada`); una comanda anulada no admite cambios en sus
> líneas (`comanda_item_comanda_anulada`).

### 2.10 ComandaItem

`id`, `restauranteId`, `comandaId`, `productoId`, `orden`, `nombreSnap`,
`precioUnitarioSnap`, `destinoSnap`, `cantidad`, `descuentoLinea`, `totalLinea`,
`nota?`, `canceladoEn?`, `canceladoPorId?`, `motivoCancelacion?`, y desde 2026-11-05:

| Campo | Tipo | Notas |
|---|---|---|
| `clienteId` | uuid | El **DEUDOR**. Nace igual al cliente de la comanda; reasignar deuda es cambiar esto (sólo sin factura) |
| `cobroId?` | uuid | La **factura** que cubre la línea. NULL = deuda viva. Una línea está en a lo sumo UNA factura (es una columna). Una línea facturada que luego se anula **conserva** su `cobroId` (traza) y deja de sumar |

> Los `*Snap` son **obligatorios**: el ticket de hoy tiene que poder reimprimirse
> idéntico dentro de un año aunque el producto haya cambiado de precio o de
> nombre. Nunca leer el precio actual del producto para un reporte histórico.
> `totalLinea = round(cantidad × precioUnitarioSnap − descuentoLinea, 4)` (CHECK).
>
> **Anulada ⟺ `canceladoEn != null`.** No hay workflow por ítem.
>
> ⭐ **Editables también después de despachar** (trigger `comanda_item_editable`,
> que sustituye a `comanda_item_solo_pendiente`): agregar, cambiar `cantidad`/`nota`
> y anular líneas de comandas `pendiente`, `despachada`, `cobrada_parcial` y
> `cobrada`. Una línea **agregada a una comanda ya despachada NO vuelve a cocina**.
> Sigue prohibido tocar una comanda anulada, facturar lo que sigue en cocina o una
> línea cancelada, y tocar (salvo la nota) las líneas de una factura anulada.
> Toda línea cambiada después del despacho queda en `bitacora`.
>
> **Partir una línea**: cobrar o reasignar 2 de 3 unidades deja la original con 1 y
> crea una línea nueva con 2 (mismos snapshots, misma comanda). La suma de
> unidades se conserva.

### 2.11 Cobro — LA FACTURA

La factura de **algunas (o todas) las líneas de UN cliente**, cobradas juntas.
Cubre líneas vía `comandaItem.cobroId`, no comandas.

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `restauranteId` | uuid | |
| `clienteId` | uuid | **OBLIGATORIO.** A quién se le cobra; las líneas facturadas son suyas (FK compuesta) |
| `mesaId?`, `salonId?` | uuid | Dónde estaba sentado al cobrar (foto). NULL = sin mesa. Con mesa, exige salón |
| `numeroDia` | int | Número visible de la factura del día. Contador propio, distinto del de la comanda |
| `fechaOperativa`, `turno` | | **Los del cobro**: la venta se cuenta cuando entra el dinero. **Nunca cambian** (`cobro_fecha_inmutable`) |
| `comensales` | int | El máximo de las comandas cubiertas |
| `clienteNombre?` | string | Nombre **congelado** en la factura. NULL = "Consumidor final". Por defecto el del cliente; el cajero puede mandar otro |
| `subtotal`, `descuento`, `impuesto`, `propina`, `total` | decimal | USD. Los calcula **el servidor**; la base los verifica al COMMIT |
| `tasaId`, `tasaValor`, `totalBs` | | **NOT NULL**: congelados al emitir, para reimprimir el mismo monto en Bs |
| `cobradoEn`, `cobradoPorId?` | | |
| `anuladoEn?`, `anuladoPorId?`, `motivoAnulacion?`, `notas?` | | |

> **Es un comprobante INTERNO de cobro, no un documento fiscal.**
>
> ⭐ **Verificada entera al COMMIT** (constraint trigger diferido `cobro_coherente`):
> cubre al menos una línea viva (`cobro_no_vacio`: la factura fantasma de dos
> cajeros), `subtotal` = Σ `totalLinea` de sus líneas vivas, `total` = subtotal −
> descuento + impuesto + propina, `totalBs` = round(total × tasa, 4) ± 0,01, y
> Σ pagos = `total` ± 0,01 (`cobro_pagos_cuadran`). El servidor ya lo calcula todo
> bien; esto es la red.
>
> **Se corrige en cualquier día** (decisión del dueño), con bitácora; lo que no
> cambia nunca es su día ni su número. Una **anulada** es inmutable. Efecto en
> reportes: ver §5 · Reportes (`cierre-caja`).
>
> **No hay "saldo pendiente" en una factura**: lo que no se cobra es deuda del
> cliente (líneas sin factura), nunca un hueco en una factura emitida.

### 2.12 CobroPago — libro de SÓLO AGREGAR

`id`, `restauranteId`, `cobroId`, `metodo: MetodoPago`, `moneda: Moneda`,
`monto` (en esa moneda), `tasaAplicada?`, `montoUsd`, `referencia?`,
`recibidoEn`, `registradoPorId?`, y desde 2026-11-05 `fechaOperativa`.

- **Un pago registrado no se edita ni se borra** (`cobro_pago_inmutable`; sólo la
  `referencia` se puede corregir). Si la factura cambia, se compensa con otra fila.
- **Devolución = fila con `monto` y `montoUsd` NEGATIVOS**, por el método por el que
  sale el dinero. Nunca 0 (`cobro_pago_monto_valido`). En Bs usa la tasa
  **congelada de la factura**, no la del día.
- `fechaOperativa` = el día operativo en que el dinero **entró o salió** (lo pone la
  base desde `recibidoEn`), no el de la factura: una devolución de hoy sobre una
  factura de ayer cuadra la caja de HOY.
- No se aceptan pagos en facturas anuladas.
- `pago_movil` y `transferencia` exigen `referencia` no vacía (conciliación bancaria).
- `moneda = 'BS'` exige `tasaAplicada`; `moneda = 'USD'` exige que sea NULL.
- Varias filas por cobro: el pago mixto es lo normal, no la excepción.

### 2.12b Bitacora (sólo lectura; no hay endpoint todavía)

`id`, `restauranteId`, `tabla` (`'comanda_item' | 'cobro' | 'cliente'`),
`entidadId`, `operacion` (`INSERT | UPDATE`), `cambios: string[]`, `antes`, `despues`
(jsonb, claves snake_case), `usuarioId`, `motivo?`, `creadoEn`. La escriben
**triggers**: líneas agregadas/cambiadas después del despacho, toda corrección de
una factura, y cambios de nombre/mesa/cierre de un cliente. Sin autor, la
transacción revienta (`bitacora_sin_autor`, 500): el servicio lo fija con
`set_config('app.usuario_id', …, true)` como PRIMERA sentencia de cada transacción
que escriba (`src/comun/prisma/autor.ts`). Inmutable.

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

### 3.0 Autor de toda escritura

Toda transacción que escriba abre con
`SELECT set_config('app.usuario_id', $usuario, true)` (y `app.motivo` si la
operación lo trae): sin eso los triggers de bitácora revientan. Es `SET LOCAL`:
muere con la transacción.

### 3.1 Tomar un pedido (POST /comandas)

No hay estado borrador: la comanda **nace ya en la cola de despacho**, con sus
líneas, en una sola transacción. "Crear" y "enviar a cocina" son el mismo acto,
porque cada envío es una comanda nueva.

```
1. Autor (3.0). Cliente de la sesión: existe, es del restaurante y está ABIERTO (409 si cerró).
2. Si tipo = 'mesa' y el cliente está sentado: mesa viva, en la distribución ACTIVA y no bloqueada
   -> foto (mesaId, salonId, plantillaId). Sin mesa, o 'para_llevar': los tres NULL.
3. fechaOperativa y turno con las funciones SQL (NO reimplementar la regla en TypeScript).
4. Número visible, atómico: INSERT INTO contador_dia ... ON CONFLICT DO UPDATE ultimo_comanda + 1
   (nunca MAX(numero_dia)+1).
5. INSERT comanda (clienteId). NO se mandan `estado` ni `total`: los deriva el trigger.
6. INSERT de las líneas con clienteId = el de la comanda y totalLinea redondeado a 4 decimales.
```

### 3.2 Despachar (POST /comandas/:id/despachar)

```
UPDATE comanda SET despachada_en = now()
 WHERE id = $1 AND despachada_en IS NULL AND anulada_en IS NULL;
→ 0 filas: 409 (ya se despachó, o está anulada). El predicado completo es lo que
  hace segura la doble pulsación de dos pantallas de cocina.
```
Sale de la cola (`v_cola_despacho`), **no se borra**: sus líneas pasan a ser cobrables.

### 3.3 Cobrar al cliente (POST /clientes/:id/cobrar)

```sql
BEGIN;
SELECT set_config('app.usuario_id', $usuario, true);          -- 3.0 (el partir una línea queda en la bitácora)
SELECT ci.* FROM comanda_item ci JOIN comanda c ON ...
 WHERE ci.cliente_id = $k AND ci.cobro_id IS NULL AND ci.cancelado_en IS NULL
   AND c.despachada_en IS NOT NULL AND c.anulada_en IS NULL
   [AND ci.id = ANY($lineaIds)]
 ORDER BY c.creada_en, ci.orden
 FOR UPDATE OF ci;                  -- 0 filas -> 409 ; una línea pedida que no sale -> 409
```

⭐ **El `FOR UPDATE` no es opcional y no se puede sustituir por un `findMany` de
Prisma.** Es lo que serializa a dos cajeros: el segundo espera el lock y, al
reevaluar el predicado tras el COMMIT del primero, ya no ve las líneas.

```
2. Totales en el servidor: subtotal = Σ de las porciones elegidas (jamás del cliente);
   total = subtotal − descuento + impuesto(0) + propina.
3. Tasa vigente DEL DÓLAR (`divisa: 'USD'`, orden fecha desc + creadaEn desc) y congelarla.
   Los pagos (en USD, o Bs ÷ tasa) deben sumar el total ± 0,01.
4. Día operativo y turno DEL COBRO (funciones SQL). Número: UPSERT atómico sobre ultimo_cobro.
5. INSERT cobro con los totales FINALES (clienteId, foto de la mesa del cliente, clienteNombre:
   DTO del cajero > cliente.nombre). ⚠️ NO hacer UPDATE al cobro recién creado en la misma
   transacción: quedaría en la bitácora como una corrección.
6. Por cada línea: entera -> UPDATE comanda_item SET cobro_id; parcial -> PARTIR (3.3c):
   la original conserva lo no tomado y una línea nueva con la porción lleva el cobro_id.
7. INSERT de N cobro_pago.
8. Si `cerrarCliente` y no queda deuda de ninguna clase: cerrar al cliente (y su reserva
   `sentada` -> `completada`).
COMMIT;      -- aquí corre `cobro_coherente` (diferido)
```

**Lo que sigue en cocina NO se cobra**: queda como deuda del cliente. Verificación:
`v_cobro_descuadre` debe seguir devolviendo 0 filas.

### 3.3b Corregir una factura (POST /cobros/:id/corregir)

> `motivo` es OPCIONAL (máx. 300): si no viene, la bitácora lo guarda vacío.

```
BEGIN; set_config(usuario, motivo);
SELECT ... FROM cobro WHERE id = $c FOR UPDATE;               -- anulada -> 409
SELECT ... FROM comanda_item WHERE cobro_id = $c FOR UPDATE;
1. cambios: UPDATE de las líneas (cantidad -> totalLinea recalculado; anular -> cancelado_en + motivo).
2. agregar: INSERT de líneas con cobro_id = $c en una comanda despachada del mismo cliente.
3. subtotal = Σ líneas vivas (0 líneas -> 409); total y total_bs recalculados con la tasa CONGELADA.
4. UPDATE cobro (una sola vez).
5. diferencia = total nuevo − Σ monto_usd ya registrado. Los `pagos` del DTO (Bs ÷ tasa congelada)
   deben sumarla ± 0,01 (si no, 422 { diferenciaUsd }); ningún método/moneda queda en negativo (422).
6. INSERT de los pagos (+ cobro adicional, − devolución).
COMMIT;
```

### 3.3c Partir una línea y reasignar deuda (POST /clientes/:id/reasignar)

```
parcial (cantidad < línea.cantidad):
  UPDATE comanda_item SET cantidad = resto, total_linea = round(resto × precio − desc_resto, 4) WHERE id = $l;
  INSERT comanda_item (mismos snapshots, misma comanda, cantidad = tomada, total_linea = round(...),
                       cliente_id = destino | cobro_id = factura);
  -- el descuento de línea, si lo hay, se reparte proporcional a la cantidad.
entera:  UPDATE comanda_item SET cliente_id = $destino  (reasignar)  |  SET cobro_id = $c  (cobrar)
```
Las líneas se bloquean con el mismo `FOR UPDATE` que el cobro (aquí también las que siguen
en cocina). Una línea facturada no cambia de deudor: lo impide la FK compuesta
`comanda_item_restaurante_id_cobro_id_cliente_id_fkey` (→ 409).

### 3.3d Sentar, mover, liberar y cerrar un cliente

```
sentar/mover: mesa viva en la distribución activa y no bloqueada; UPDATE cliente SET mesa_id;
              UPDATE comanda SET mesa/salón/plantilla WHERE cliente_id = $k AND despachada_en IS NULL
              (las despachadas conservan donde se sirvieron).
liberar:      UPDATE cliente SET mesa_id = NULL (+ las comandas en cocina quedan sin mesa).
cerrar:       sin deuda de ninguna clase (409 si debe); UPDATE cliente SET cerrado_en, cerrado_por_id;
              si venía de una reserva 'sentada' -> 'completada'.
reabrir:      UPDATE cliente SET cerrado_en = NULL.
sentar reserva / check-in: updateMany condicionado al estado + INSERT cliente (atómico: el doble toque da 409).
cancelar / no-show de una reserva 'sentada': cierra a su cliente abierto (409 si debe).
```

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
| `23514` | `comanda_cobro_tras_despacho` | **409** | "No se puede cobrar una comanda que la cocina todavía no despachó" |
| `23514` | `comanda_anulada_no_cobrada` | **409** | "Esa comanda tiene líneas facturadas: corrige las facturas antes de anularla" |
| `23514` | `cliente_cerrado` | **409** | "Ese cliente ya cerró su cuenta: reábrelo para anotarle consumo" |
| `23514` | `cliente_cierre_sin_deuda` | **409** | "El cliente todavía debe consumo: cóbralo, reasígnalo o cancélalo antes de cerrarlo" |
| `23505` | `cliente_reservacion_abierta_unica` | **409** | "Esa reserva ya está sentada" |
| `23514` | `cliente_nombre_normalizado` | 422 | "El nombre del cliente no puede estar vacío" |
| `23514` | `comanda_item_comanda_anulada` | **409** | "Esa comanda está anulada" |
| `23514` | `comanda_item_factura_linea_viva` | **409** | "Esa línea está cancelada" |
| `23503` | `comanda_item_restaurante_id_cobro_id_cliente_id_fkey` | **409** | "Esa línea ya está facturada: desfactúrala antes de reasignarla" |
| `23514` | `cobro_no_vacio` | **409** | "Esa cuenta ya la cobró otro cajero, o la factura se quedó sin líneas (una factura sin líneas se anula)" — detectada en el COMMIT |
| `23514` | `cobro_pagos_cuadran` | 422 | "Los pagos no cuadran con el nuevo total: registra el cobro o la devolución de la diferencia" |
| `23514` | `cobro_anulado_inmutable` | **409** | "Esa factura está anulada" |
| `23514` | `cobro_pago_inmutable` | **409** | "Un pago registrado no se edita: registra una devolución" |
| `23514` | `cobro_pago_monto_valido` | 422 | "El monto no puede ser 0" |
| `23514` | `comanda_item_comanda_fija`, `comanda_item_total_coherente`, `cobro_subtotal_coherente`, `cobro_total_coherente`, `cobro_fecha_inmutable`, `bitacora_sin_autor`, `bitacora_inmutable` | **500** | Bug del servidor: nunca debería verlo un usuario |
| — | ~~`comanda_item_solo_pendiente`~~, ~~`cobro_dia_abierto`~~ | — | **Ya no existen**: se editan líneas después de despachar y se corrigen facturas de cualquier día |
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
| `23514` | `usuario_credenciales_coherentes` | 422 | "Un acceso temporal no puede tener clave ni PIN, y el personal permanente debe tener clave" |
| `23514` | `usuario_acceso_temporal_es_mesero` | 422 | "Un acceso temporal sólo puede tener el rol mesero" |
| `23514` | `usuario_modulos_segun_rol` | 422 | "Configuración y Meseros son sólo del administrador, y al administrador no se le asignan pantallas" |
| `23514` | `invitacion_acceso_enlace_es_hash` / `invitacion_acceso_codigo_es_argon2` | 422 | El enlace / código debe guardarse como hash. Bug del backend si aparece |
| `23514` | `invitacion_acceso_fallos_validos` | 422 | "El contador de intentos fallidos no puede ser negativo" |
| `23514` | `invitacion_acceso_solo_temporal` (trigger) | 422 | "Ese acceso ya no está vigente: crea uno nuevo" |
| `23503` | `invitacion_acceso_restaurante_id_usuario_id_fkey` | 422 | "El acceso no existe o no pertenece a este restaurante" |
| `23505` | `invitacion_acceso_enlace_unico` | **500** | Bug: token regenerado mal (160 bits no colisionan) |

---

## 5 · Endpoints esperados (sólo firmas)

Prefijo `/api/v1`. Todo lo que no cuelga de `/publico` exige sesión y resuelve
`restauranteId` **desde el token**, nunca desde el body o un header.

### 5.1 Autorización por pantalla (módulos)          *(añadido 2026-09-18)*

Además de la sesión, **toda ruta** declara qué pantallas la usan, y el guard
global `ModulosGuard` lo aplica en cada petición (relee `modulos` de la base:
quitar un módulo surte efecto en el siguiente clic). Falla cerrado: una ruta sin
declarar responde 403 a todo el mundo, y `src/comun/guards/rutas-cubiertas.spec.ts`
impide que eso llegue a producción.

- `@Publico` — sin sesión.
- `@Comun` — cualquier sesión válida: lo que usa el shell en TODAS las pantallas.
- `@Modulo(a, b, …)` — hace falta **al menos uno** de esos módulos. El
  administrador pasa siempre.
- `@Roles(...)` se suma donde hace falta (no lo sustituye).

**Sin permiso de pantalla → 403**, igual que sin rol.

Lista **cerrada** de `@Comun` (el frontend construye contra ella):
`GET /auth/yo`, `GET /restaurante`, `GET /tasa/vigente`, todo `/push/*`,
`GET /salones`, `GET /salones/:salonId/plantillas`, `GET /plantillas/:id`,
`GET /plano`, `GET /mesas`. Más dos escrituras que el shell (`TasaBar`) usa en
todas las pantallas y que el ROL restringe: `POST /tasa` y
`POST /tasa/actualizar` → `@Comun + @Roles('administrador','encargado')`.

| Método | Ruta | Quién |
|---|---|---|
| GET | /accesos | `@Modulo('meseros')` + `@Roles('administrador')` |
| POST | /accesos | `@Modulo('meseros')` + `@Roles('administrador')` |
| DELETE | /accesos/:id | `@Modulo('meseros')` + `@Roles('administrador')` |
| PATCH | /accesos/:id | `@Modulo('meseros')` + `@Roles('administrador')` |
| POST | /accesos/:id/regenerar | `@Modulo('meseros')` + `@Roles('administrador')` |
| GET | /accesos/vencimientos | `@Modulo('meseros')` + `@Roles('administrador')` |
| POST | /auth/acceso | `@Publico` |
| POST | /auth/acceso/consultar | `@Publico` |
| POST | /auth/login | `@Publico` |
| POST | /auth/pin | `@Publico` |
| GET | /auth/yo | `@Comun` |
| POST | /clientes | `@Modulo('mesero','mesas')` |
| GET | /clientes | `@Modulo('mesero','mesas','por_cobrar')` |
| GET | /clientes/deudas | `@Modulo('por_cobrar','mesas')` |
| GET | /clientes/:id | `@Modulo('mesero','mesas','por_cobrar')` |
| POST | /clientes/:id/sentar | `@Modulo('mesas','mesero')` |
| POST | /clientes/:id/liberar | `@Modulo('mesas','mesero')` |
| POST | /clientes/:id/cerrar | `@Modulo('mesas','por_cobrar')` |
| POST | /clientes/:id/reabrir | `@Modulo('mesas','por_cobrar')` |
| POST | /clientes/:id/reasignar | `@Modulo('mesero','mesas','por_cobrar')` |
| POST | /clientes/:id/cobrar | `@Modulo('mesas','por_cobrar')` |
| GET | /categorias | `@Modulo('mesero','productos')` |
| POST | /categorias | `@Modulo('productos')` |
| DELETE | /categorias/:id | `@Modulo('productos')` |
| PATCH | /categorias/:id | `@Modulo('productos')` |
| GET | /cobros?fecha= | `@Modulo('ventas')` |
| GET | /cobros/:id | `@Modulo('mesas','por_cobrar','ventas')` |
| POST | /cobros/:id/anular | `@Modulo('por_cobrar')` |
| POST | /cobros/:id/corregir | `@Modulo('por_cobrar','ventas')` |
| POST | /comandas | `@Modulo('mesero')` |
| GET | /comandas/:id | `@Modulo('mesero','despacho','mesas','por_cobrar','ventas')` |
| POST | /comandas/:id/anular | `@Modulo('despacho')` |
| POST | /comandas/:id/despachar | `@Modulo('despacho')` |
| POST | /comandas/:id/items | `@Modulo('mesero','por_cobrar')` |
| DELETE | /comandas/:id/items/:itemId | `@Modulo('despacho','mesero','por_cobrar')` |
| PATCH | /comandas/:id/items/:itemId | `@Modulo('mesero','por_cobrar')` |
| GET | /cuentas-por-cobrar | `@Modulo('por_cobrar')` |
| GET | /despacho/cola | `@Modulo('despacho')` |
| GET | /mesas | `@Comun` |
| POST | /mesas | `@Modulo('mesas')` |
| DELETE | /mesas/:id | `@Modulo('mesas')` |
| GET | /mesas/:id | `@Modulo('mesas')` |
| PATCH | /mesas/:id | `@Modulo('mesas')` |
| GET | /mesas/:mesaId/cuenta | `@Modulo('mesas','por_cobrar','mesero')` |
| GET | /plano | `@Comun` |
| DELETE | /plantillas/:id | `@Modulo('mesas')` |
| GET | /plantillas/:id | `@Comun` |
| PATCH | /plantillas/:id | `@Modulo('mesas')` |
| POST | /plantillas/:id/activar | `@Modulo('mesas')` |
| POST | /plantillas/:id/clonar | `@Modulo('mesas')` |
| POST | /plantillas/:id/mesas | `@Modulo('mesas')` |
| PUT | /plantillas/:id/mesas | `@Modulo('mesas')` |
| DELETE | /plantillas/:id/mesas/:mesaId | `@Modulo('mesas')` |
| PATCH | /plantillas/:id/mesas/:mesaId | `@Modulo('mesas')` |
| GET | /productos | `@Modulo('mesero','productos')` |
| POST | /productos | `@Modulo('productos')` |
| DELETE | /productos/:id | `@Modulo('productos')` |
| GET | /productos/:id | `@Modulo('mesero','productos')` |
| PATCH | /productos/:id | `@Modulo('productos')` |
| PATCH | /productos/:id/disponibilidad | `@Modulo('productos')` |
| GET/POST | /publico/* (5 rutas) | `@Publico` |
| POST, GET, PATCH, DELETE | /push/* (6 rutas) | `@Comun` |
| GET | /reportes/cierre-caja, /reportes/dia, /reportes/productos, /reportes/ventas | `@Modulo('ventas')` |
| GET | /reservaciones | `@Modulo('reservaciones')` |
| POST | /reservaciones | `@Modulo('reservaciones')` |
| GET | /reservaciones/:id | `@Modulo('reservaciones','checkin','escanear')` |
| PATCH | /reservaciones/:id | `@Modulo('reservaciones')` |
| POST | /reservaciones/:id/cancelar | `@Modulo('reservaciones')` |
| POST | /reservaciones/:id/confirmar | `@Modulo('reservaciones')` |
| POST | /reservaciones/:id/no-show | `@Modulo('reservaciones')` |
| GET | /reservaciones/:id/qr | `@Modulo('reservaciones')` |
| POST | /reservaciones/:id/sentar | `@Modulo('reservaciones','checkin','escanear')` |
| GET | /reservaciones/huerfanas | `@Modulo('reservaciones','mesas')` |
| GET | /restaurante | `@Comun` |
| PATCH | /restaurante | `@Modulo('configuracion')` + `@Roles('administrador')` |
| GET | /salones | `@Comun` |
| POST | /salones | `@Modulo('mesas')` |
| DELETE | /salones/:id | `@Modulo('mesas')` |
| GET | /salones/:id | `@Modulo('mesas')` |
| PATCH | /salones/:id | `@Modulo('mesas')` |
| GET | /salones/:salonId/plantillas | `@Comun` |
| POST | /salones/:salonId/plantillas | `@Modulo('mesas')` |
| POST | /tasa | `@Comun` + `@Roles('administrador','encargado')` |
| POST | /tasa/actualizar | `@Comun` + `@Roles('administrador','encargado')` |
| GET | /tasa/vigente | `@Comun` |
| POST | /uploads/logo | `@Modulo('configuracion')` + `@Roles('administrador')` |
| POST | /uploads/productos | `@Modulo('productos')` |

> ⚠️ **Para el frontend:** `AppShell` monta `useComandaBootstrap`, que sondea
> `GET /despacho/cola` y `GET /cuentas-por-cobrar` en TODAS las pantallas para
> los contadores del menú (y `useAlertaCocina` lee la cola). Ninguna de las dos
> es `@Comun`: hay que pedirlas sólo si la persona tiene `despacho` /
> `por_cobrar`, o cada sondeo devuelve 403.

### Sesión
```
POST   /auth/login                 { usuario, clave }            -> { token, usuario }
POST   /auth/pin                   { usuario, pin }              -> { token, usuario }
GET    /auth/yo                                                  -> Usuario
```

`usuario` (aquí y en el canje) lleva `modulos` EFECTIVOS y `accesoHasta`.
Login y PIN **nunca** aceptan un acceso temporal (responden 401 como a un
usuario inexistente).

### Accesos temporales (menú "Meseros")          *(añadido 2026-09-18)*

Canje, **público**. El frontend ramifica por **código HTTP**, nunca por texto.
El enlace es `<URL_PUBLICA>/acceso/<slug>#<TOKEN>`: el token viaja en el
**fragmento** (no llega a ningún servidor ni a los logs); la página lo lee de
`location.hash` y lo manda en el body.
```
POST   /auth/acceso/consultar   { restaurante: slug, token }
         200 { restaurante: { nombre, logoUrl }, nombre, accesoHasta }
         404 enlace inválido · 410 acceso vencido           (no cuenta como intento)
POST   /auth/acceso             { restaurante: slug, token, codigo: /^\d{4}$/ }
         200 { token, usuario }   (usuario sanitizado, con modulos y accesoHasta)
         401 código incorrecto · 404 enlace inválido · 410 acceso vencido
         400 si `codigo` no son 4 dígitos
```
- Sin bloqueo por intentos (decisión del dueño). Al 10.º fallo seguido se manda
  un push `acceso_sospechoso` al administrador (sólo en el 10.º, no en cada
  uno). El aparato del dueño tiene que estar suscrito a ese tema.
- Sin `@Throttle` propio: sin `trust proxy`, detrás de Railway todas las
  peticiones comparten IP y un límite estricto bloquearía a todos los meseros.
- Un enlace **revocado** responde 404 (su credencial se borra); uno que venció
  solo, 410.
- El JWT de un acceso temporal dura `min(12 h, lo que le queda de acceso)`.

Gestión: `@Modulo('meseros') + @Roles('administrador')`.
```
GET    /accesos/vencimientos            -> { hoy, dosDias, unaSemana, unMes }     (ISO)
GET    /accesos                         -> AccesoVivo[]   (sólo vivos, por accesoHasta asc)
POST   /accesos   { nombre (1-40), duracion, modulos (≥1) }
         201 { acceso: { id, nombre, modulos, accesoHasta, creadoEn }, enlace, codigo }
PATCH  /accesos/:id  { nombre?, modulos?, duracion? }        -> AccesoVivo | 404
POST   /accesos/:id/regenerar  { enlace?: bool, codigo?: bool }
         200 { enlace?, codigo? }                                           | 404
DELETE /accesos/:id                                          -> 204 | 404

duracion   = 'hoy' | '2_dias' | '1_semana' | '1_mes'
AccesoVivo = { id, nombre, modulos, accesoHasta, ultimoAccesoEn,
               fallosConsecutivos, ultimoFalloEn }
```
- **`enlace` y `codigo` salen UNA sola vez** (crear / regenerar). Ninguna otra
  respuesta los trae, ni sus hashes.
- Ninguna ruta acepta un `accesoHasta` libre: sólo los 4 atajos. Son días
  OPERATIVOS: vencen en la hora de corte del restaurante (05:00 por defecto).
  "hoy" pedido a las 04:59 dura un minuto: por eso existe `/vencimientos`.
- `modulos` no admite `configuracion` ni `meseros` (400).
- `PATCH` con `duracion` recalcula desde AHORA (extiende o acorta). Sobre un
  acceso vencido o revocado: 404 — se crea uno nuevo.
- `regenerar`: sin cuerpo (o sin ninguno de los dos campos) regenera **ambos**;
  si viene alguno, sólo lo que venga en `true` (`{ codigo: true }` cambia el
  código y el mesero conserva su enlace). Los dos en `false` → 400. Pone
  `fallosConsecutivos` a 0 y `ultimoFalloEn` a null.
- `DELETE` revoca: `accesoHasta = ahora`, borra la credencial y sus aparatos
  push. El usuario no se borra: sus comandas y cobros siguen a su nombre.

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
POST   /reservaciones/:id/cancelar { motivo }                    -> Reservacion   // si estaba 'sentada', cierra a su cliente (409 si debe)
POST   /reservaciones/:id/no-show                                -> Reservacion   // ídem
POST   /reservaciones/:id/sentar   { mesaId?, comensales? }      -> { reservacion, cliente }   // abre el CLIENTE sentado (nombre = el de la reserva); doble toque -> 409
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
POST   /publico/reserva/:codigoPublico/checkin                   -> ReservacionPublica   // abre el cliente sentado; no lo expone
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

### Clientes, comandas, despacho y cobro          *(reescrito 2026-11-05)*

Se cobra al **CLIENTE** (una visita), por **líneas**. Léelo así:

```
cliente ─┬─ 1..N comandas (lo que pidió; la cocina las despacha)
         └─ N líneas = lo que DEBE   (comanda_item.clienteId, cobroId = null)
                                      └─ al cobrar, las elegidas pasan a una factura (cobroId)
```

- La **mesa** es sólo dónde está sentado el cliente (opcional). La mesa está
  ocupada ⟺ hay un cliente ABIERTO sentado en ella; se libera al cerrarlo, moverlo
  o liberarlo. Dos clientes en la misma mesa son legales (cuentas separadas).
- **Deuda** = líneas vivas sin factura, de comandas no anuladas. Lo que sigue en
  cocina cuenta como deuda pero **no se puede cobrar** hasta que se despache.
- Todo lo que se escribe aquí queda con **autor** en la bitácora (el servidor lo
  fija desde la sesión; el frontend no manda nada para eso).

#### Formas

```ts
interface Cliente {
  id: string; restauranteId: string;
  nombre: string;                 // trim, 1-120
  mesaId: string | null;          // dónde está sentado AHORA (null = sin mesa)
  reservacionId: string | null;   // la reserva que lo trajo
  fechaOperativa: string;         // día operativo de apertura
  creadoPorId: string | null; creadoEn: string;
  cerradoEn: string | null; cerradoPorId: string | null;   // cerrado ⟺ cerradoEn != null
}

/** Fila de `v_cuenta_cliente` (snake_case, igual que el plano): UN cliente ABIERTO. */
interface CuentaCliente {
  restaurante_id: string; cliente_id: string; cliente_nombre: string;
  mesa_id: string | null; mesa_etiqueta: string | null; salon_id: string | null; salon_nombre: string | null;
  sentado: boolean; reservacion_id: string | null; fecha_operativa: string;
  mesero_id: string | null; ocupada_desde: string; minutos_ocupada: number;
  comandas: number; comandas_por_cobrar: number; comandas_en_cocina: number;
  lineas_por_cobrar: number;
  cuenta_total: string;       // toda su deuda viva (cocina + despachado)
  total_por_cobrar: string;   // lo facturable YA (despachado)
  total_en_cocina: string;
  comensales: number;
  facturas: number; total_cobrado: string;   // facturas vivas de esta visita
}

interface Comanda {            // ComandaItem en `items`
  id: string; tipo: 'mesa' | 'para_llevar';
  clienteId: string;           // OBLIGATORIO
  mesaId: string | null; salonId: string | null; plantillaId: string | null;  // FOTO al pedir; null si no estaba sentado
  numeroDia: number; fechaOperativa: string; turno: TurnoServicio; comensales: number; meseroId: string | null;
  estado: 'pendiente' | 'despachada' | 'cobrada_parcial' | 'cobrada' | 'anulada';   // DERIVADO
  despachadaEn: string | null; anuladaEn: string | null;
  total: string;               // suma de sus líneas vivas (facturadas o no)
  notas: string | null;
  /* LEGADO (sólo lectura, no decidir con ellos): reservacionId, clienteNombre */
}
interface ComandaItem {
  id: string; comandaId: string; productoId: string; orden: number;
  clienteId: string;           // el DEUDOR (= el de la comanda salvo reasignación)
  cobroId: string | null;      // la factura que la cubre; null = deuda viva
  nombreSnap: string; precioUnitarioSnap: string; destinoSnap: DestinoPreparacion;
  cantidad: string; descuentoLinea: string; totalLinea: string; nota: string | null;
  canceladoEn: string | null; canceladoPorId: string | null; motivoCancelacion: string | null;
}

/** `cobroId` NUNCA existe en Comanda: la factura vive en la línea. */
interface Cobro {
  id: string; clienteId: string;          // OBLIGATORIO
  mesaId: string | null; salonId: string | null;   // dónde estaba sentado al cobrar (foto)
  numeroDia: number; fechaOperativa: string; turno: TurnoServicio; comensales: number;
  clienteNombre: string | null;           // CONGELADO en la factura; null = "Consumidor final"
  subtotal: string; descuento: string; impuesto: string; propina: string; total: string;   // USD
  tasaId: string; tasaValor: string; totalBs: string;
  cobradoEn: string; cobradoPorId: string | null;
  anuladoEn: string | null; anuladoPorId: string | null; motivoAnulacion: string | null;
}
/** Lo que devuelven GET /cobros, GET /cobros/:id, el cobro y la corrección. */
type CobroDetalle = Cobro & {
  pagos: CobroPago[];                       // en orden; las devoluciones son pagos con monto < 0
  lineas: (ComandaItem & { comanda: { id: string; numeroDia: number } })[];   // incluye las anuladas después (canceladoEn != null: ya no suman)
  cliente: { id: string; nombre: string; mesaId: string | null; cerradoEn: string | null };
  mesa: Mesa | null;
};

interface PagoInput { metodo: MetodoPago; moneda: Moneda; monto: number; referencia?: string }   // monto > 0
```

#### Clientes

```
POST   /clientes                   { nombre, mesaId? }                    -> Cliente            201
       // mesaId = sentarlo (mesa viva, en la distribución ACTIVA, no bloqueada); omitido = sin mesa.
GET    /clientes?mesaId=&sinMesa=true                                     -> CuentaCliente[]    // abiertos, por orden de llegada
GET    /clientes/deudas                                                   -> CuentaCliente[]    // abiertos con cuenta_total > 0 (incluye lo que está en cocina)
GET    /clientes/:id                                                      -> { cliente, cuenta: CuentaCliente | null, lineas: (ComandaItem & { comanda }) [], facturas: FacturaResumen[] }
       // `lineas` = lo que DEBE (sin factura, sin cancelar). `cuenta` es null si ya cerró.
POST   /clientes/:id/sentar        { mesaId }                             -> Cliente            201
       // Sienta (si no tenía mesa) o MUEVE (si tenía). Sus comandas que siguen en cocina se mudan con él;
       // las ya despachadas conservan la mesa donde se sirvieron.
POST   /clientes/:id/liberar                                              -> Cliente            201   // se levanta; sigue abierto (y debiendo)
POST   /clientes/:id/cerrar                                               -> Cliente            201   // 409 si debe algo (incluso en cocina)
POST   /clientes/:id/reabrir                                              -> Cliente            201   // para anotarle consumo a quien ya cerró
POST   /clientes/:id/reasignar     { lineas: [{ lineaId, cantidad? }],
                                     clienteDestinoId?  |  nuevoCliente?: { nombre, mesaId? } }
                                                                          -> { origenId, destino: Cliente, lineas: ComandaItem[] }   201
GET    /mesas/:mesaId/cuenta                                              -> { mesa, clientes: CuentaCliente[] }   // quiénes están sentados y qué debe cada uno
GET    /cuentas-por-cobrar                                                -> CuentaCliente[]    // total_por_cobrar > 0: el menú del cajero
```

- **`cerrar`**: cierra la visita (y pasa la reserva de origen de `sentada` a `completada`).
  No se cierra con deuda: **409** `"<nombre> todavía debe N línea(s) por X USD: cóbralas, reasígnalas o cancélalas antes de cerrarlo"`.
  Cobrar **no** cierra solo (ver `cerrarCliente` en el cobro): un cliente que ya pagó pero sigue sentado mantiene la mesa ocupada.
- **`reasignar`**: exactamente UNO de `clienteDestinoId` / `nuevoCliente` (si no, **400**). Se reasignan líneas SIN factura
  (también las que siguen en cocina). `cantidad` menor que la de la línea la PARTE: la porción pasa al destino, el resto
  se queda. `nuevoCliente` sin `mesaId` se sienta donde estaba el origen. Línea ya facturada / cancelada / de otro cliente →
  **409**; destino cerrado → **409** `"Ese cliente ya cerró su cuenta: reábrelo para anotarle consumo"`.
  "Facturar a otro nombre" **no** es reasignar: es `clienteNombre` al cobrar.
- Sentar una reserva (`POST /reservaciones/:id/sentar`) y el check-in público **crean** el cliente (nombre = el de la reserva).

#### Cobrar (reemplaza a `POST /mesas/:mesaId/cobrar`)

```
POST   /clientes/:id/cobrar        { lineas?: [{ lineaId, cantidad? }],      // omitido = TODO lo facturable (despachado y sin factura)
                                     clienteNombre?: string | null,           // se congela en la factura
                                     descuento?: number, propina?: number,    // USD, >= 0
                                     cerrarCliente?: boolean,                 // cierra al cliente (y libera la mesa) si no queda deuda
                                     pagos: PagoInput[] }                     // mixtos: la suma en USD debe cuadrar con el total
                                                                              -> CobroDetalle   201
```

- **Parcial por línea.** `cantidad` omitida = la línea entera. `cantidad` menor = **parte la línea**: se cobra esa porción
  (línea nueva, ya con `cobroId`) y el resto queda como deuda del mismo cliente. La suma de unidades se conserva y cada
  unidad se factura una sola vez. En la respuesta, `lineas[]` son las líneas FACTURADAS (la porción cobrada es una línea
  nueva: su `id` ≠ el `lineaId` enviado).
- **Nombre en la factura** (`clienteNombre`): ausente = el del cliente; `""`/`null` = "Consumidor final" (se guarda `null`);
  texto = ese nombre con trim (máx. 120, si no **400**). No cambia de cliente ni su nombre.
- **Pagos**: Σ(`monto` en USD; los `BS` se convierten con la tasa del dólar vigente, que se congela) = `total` ± 0,01, si
  no **400** `"Los pagos no cuadran con el total de la cuenta"`. `pago_movil` y `transferencia` exigen `referencia` (**400**).
- **Lo que sigue en cocina nunca entra** (aunque se pida su `lineaId`: **409**). Sin nada facturable: **409**.
- **Dos cajeros a la vez**: el servidor bloquea las líneas (`FOR UPDATE`); uno cobra (201) y el otro recibe **409**
  `"... ya se facturó ..."` / `"Ese cliente no tiene nada despachado por cobrar"`.
- `cerrarCliente: true` sólo cierra si NO queda deuda de ninguna clase; si queda, se ignora (la factura sí se emite).
  Mira `cliente.cerradoEn` en la respuesta.
- Totales, tasa, número de factura y día operativo los calcula el servidor (el cliente no manda ninguno).

Ejemplo — "cobro 2 de 3 cafés, mitad efectivo mitad pago móvil":

```jsonc
POST /api/v1/clientes/0190…/cobrar
{ "lineas": [{ "lineaId": "0190…a1", "cantidad": 2 }],
  "propina": 1,
  "pagos": [ { "metodo": "efectivo_usd", "moneda": "USD", "monto": 11 },
             { "metodo": "pago_movil", "moneda": "BS", "monto": 8100, "referencia": "004512" } ] }   // 8100 / 900 = 9 USD
// 201
{ "id": "0190…c1", "clienteId": "0190…", "numeroDia": 7, "clienteNombre": "Ana", "subtotal": "20.0000", "propina": "1.0000",
  "total": "21.0000", "tasaValor": "900.00000000", "totalBs": "18900.0000",
  "lineas": [ { "id": "0190…b2", "cantidad": "2.000", "totalLinea": "20.0000", "cobroId": "0190…c1", "comanda": { "id": "0190…", "numeroDia": 14 } } ],
  "pagos": [ { "metodo": "efectivo_usd", "monto": "11.0000", "montoUsd": "11.0000" }, { "metodo": "pago_movil", "monto": "8100.0000", "montoUsd": "9.0000" } ],
  "cliente": { "id": "0190…", "nombre": "Ana", "mesaId": "0190…", "cerradoEn": null } }
// El 1 café restante sigue en GET /clientes/:id → lineas (cobroId null) y la comanda queda 'cobrada_parcial'.
```

#### Comandas y despacho

```
POST   /comandas                   { clienteId, tipo?: 'mesa'|'para_llevar', comensales?, notas?,
                                     items: [{ productoId, cantidad, nota? }] }   -> Comanda & { items, cliente }   201
       // items OBLIGATORIO (min 1): nace ya en la cola. `mesaId`, `reservacionId` y `clienteNombre` YA NO se aceptan
       // (se descartan en silencio): la mesa sale del cliente sentado. `tipo` por defecto 'mesa', también sin mesa.
       // 'para_llevar' nunca lleva mesa. Cliente cerrado -> 409.
GET    /comandas/:id                                             -> Comanda & { items, mesa, cliente }
POST   /comandas/:id/items         { items: [{ productoId, cantidad, nota? }] }   -> ComandaItem[]   201
PATCH  /comandas/:id/items/:itemId { cantidad?, nota? }          -> ComandaItem
DELETE /comandas/:id/items/:itemId { motivo }                    -> 204   (canceladoEn; no borra)
POST   /comandas/:id/despachar                                   -> Comanda & { items }   201
POST   /comandas/:id/anular        { motivo }                    -> Comanda   201
GET    /despacho/cola                                            -> ColaDespacho[]   (v_cola_despacho; + cliente_id, cliente_nombre; mesa_id puede ser null)
```

- **Editar después de despachar** (nuevo): `items` (agregar), `PATCH` y `DELETE` funcionan en comandas `pendiente`,
  `despachada`, `cobrada_parcial` y `cobrada` (no en una `anulada`: **409**). Una línea **agregada a una comanda ya
  despachada NO vuelve a cocina**: se considera servida y queda como deuda del cliente de la comanda (si éste ya cerró:
  **409**, `reabrir` primero). Agregarle una línea a una comanda `cobrada` la deja `cobrada_parcial`.
- **Líneas ya facturadas** no se tocan aquí: `PATCH`/`DELETE` responden **409** con la ruta
  `POST /cobros/:cobroId/corregir`.
- `anular` una comanda con alguna línea facturada → **409** (corrige la factura primero).
- `comanda.estado`/`total` se derivan solos; `cobrada_parcial` = despachada con algunas líneas facturadas y otras vivas
  sin factura. **El frontend debe tolerar ese estado.**
- Cambios posteriores al despacho quedan en la bitácora (autor = la sesión; `DELETE` guarda su `motivo`).

#### Facturas (cobros)

```
GET    /cobros?fecha=                                            -> CobroDetalle[]   (día operativo de la FACTURA; sin fecha = hoy)
GET    /cobros/:id                                               -> CobroDetalle
POST   /cobros/:id/corregir        CorregirCobroDto              -> CobroDetalle   201
POST   /cobros/:id/anular          { motivo }                    -> CobroDetalle   201
```

```ts
interface CorregirCobroDto {
  motivo: string;                                         // OBLIGATORIO: va a la bitácora
  cambios?: { lineaId: string; cantidad?: number; nota?: string; anular?: boolean }[];   // sobre líneas de ESTA factura
  agregar?: { comandaId: string; productoId: string; cantidad: number; nota?: string }[]; // líneas nuevas, directo en la factura
  descuento?: number; propina?: number;                  // USD; ausente = sin cambio
  clienteNombre?: string | null;                         // ausente = sin cambio; ""/null = Consumidor final
  pagos?: { metodo: MetodoPago; moneda: Moneda; monto: number; referencia?: string }[];   // monto NEGATIVO = devolución
}
```

- **Se corrige una factura de cualquier día** (decisión del dueño), siempre con bitácora. Lo que nunca cambia es su
  `fechaOperativa` y su `numeroDia`. Una factura **anulada** no se corrige (**409**).
- El servidor recalcula `subtotal` (Σ líneas vivas), `total` y `totalBs` (con la tasa **congelada** de la factura). La
  **diferencia** `total nuevo − Σ pagos ya registrados` tiene que venir compensada en `pagos` en la MISMA petición:
  cobro adicional (`monto > 0`) si subió, **devolución** (`monto < 0`) si bajó. Si no cuadra → **422**
  `{ message, diferenciaUsd }` (`"-10.0000"` = hay que devolver 10 USD; positivo = cobrar de más). Con total igual, `pagos`
  es opcional (o netea cero: p. ej. "fue punto, no efectivo" = devolución + pago).
- Los **pagos nunca se editan ni se borran**: el libro es de sólo agregar. Cada movimiento se fecha con el día en que
  OCURRE. Devolución en Bs = tasa de la factura. No se devuelve por un método/moneda más de lo cobrado por él (**422**).
  `pago_movil` / `transferencia` exigen `referencia` también en devoluciones (**400**).
- Una factura no se queda sin líneas vivas: si se le quitan todas → **409** (anúlala).
- `agregar`: la comanda debe estar despachada, no anulada y ser **del cliente de la factura** (si no, **409**).
- Anular (`/anular`): se puede cualquier día, sigue como antes (las líneas siguen cubiertas por la factura anulada; **no**
  registra devolución: saca la factura de las ventas de su día y sus pagos del cuadre de los días en que entraron).

Ejemplo — devolución por bajar 3 → 2 unidades:

```jsonc
POST /api/v1/cobros/0190…c1/corregir
{ "motivo": "se devolvió una", "cambios": [{ "lineaId": "0190…b2", "cantidad": 2 }],
  "pagos": [{ "metodo": "efectivo_usd", "moneda": "USD", "monto": -10 }] }
// 201 → total 20, pagos: [ +30, -10 ] ; sin `pagos` → 422 { "diferenciaUsd": "-10.0000", "message": "El total bajó 10.0000 USD: registra la devolución (monto negativo)" }
```

**Errores específicos (además de los de §4)**: `404` cliente/comanda/línea/cobro inexistente (o de otro restaurante);
`409` conflictos de estado (cliente cerrado, comanda anulada, línea facturada, ya cobrado por otro cajero, cliente con
deuda al cerrar); `400` DTO inválido o pagos que no cuadran al cobrar; `422` pagos que no cuadran al corregir, devolver más
de lo cobrado, o un CHECK de datos.

**Rutas retiradas** (el frontend viejo las llama):

| Se fue | Qué usar | Por qué |
|---|---|---|
| `POST /mesas/:mesaId/cobrar` | `POST /clientes/:id/cobrar` | **2026-11-05.** Se cobra al cliente, por líneas; la mesa ya no es la unidad de cobro. Antes `{ comandaIds }`, ahora `{ lineas: [{ lineaId, cantidad? }] }` |
| `POST /comandas/:id/mover` | `POST /clientes/:id/sentar { mesaId }` | **2026-11-05.** La mesa es del cliente; mover al cliente muda sus comandas que siguen en cocina |
| `GET /mesas/:mesaId/cuenta` → `{ mesa, cuenta, comandas, clienteNombreSugerido }` | misma ruta, **nueva forma** `{ mesa, clientes: CuentaCliente[] }`; el detalle por cliente es `GET /clientes/:id` | **2026-11-05.** `clienteNombreSugerido` desaparece: el nombre es `cliente.nombre` |
| `GET /cuentas-por-cobrar` (filas `v_cuenta_mesa`) | misma ruta, **filas `v_cuenta_cliente`** (`CuentaCliente`: una por cliente, no por mesa) | **2026-11-05.** `v_cuenta_mesa` ya no existe |
| campo `cobroId` de `Comanda`, `comandas` de `Cobro` | `ComandaItem.cobroId`, `Cobro.lineas` | **2026-11-05.** La factura vive en la línea |
| `POST /comandas { tipo, mesaId, reservacionId, clienteNombre }` | `POST /comandas { clienteId }` | **2026-11-05.** `mesaId`/`reservacionId`/`clienteNombre` ya no se leen |
| `GET /comandas/activas` | `GET /cuentas-por-cobrar` + `GET /despacho/cola` | La vista `v_comanda_activa` ya no existe |
| `POST /comandas/:id/enviar` | nada: `POST /comandas` ya encola | No hay borrador |
| `PATCH /comandas/:id/items/:itemId/estado` | nada | No hay workflow por ítem |
| `POST /comandas/:id/cuenta` | nada | No existe el estado `por_cobrar` |
| `POST /comandas/:id/cobrar` | `POST /clientes/:id/cobrar` | Se cobra al cliente |
| `GET /cocina/cola?destino=` | `GET /despacho/cola` | Una sola cola global, por comanda |

> `POST /reservaciones/:id/sentar` devuelve ahora **`{ reservacion, cliente }`** (antes `{ reservacion }`; antes aún
> `{ reservacion, comanda }`): sentar **abre el cliente** (`nombre` = el de la reserva, `mesaId` = la mesa,
> `reservacionId`). El check-in público (`POST /publico/reserva/:codigo/checkin`) también lo abre, pero responde
> `ReservacionPublica` sin exponerlo. Ninguno abre comanda: el mesero pide con `POST /comandas { clienteId }`.
> El doble toque en "sentar" → **409** (la segunda vez la reserva ya está `sentada`).
>
> ⭐ **La mesa queda ocupada desde el escaneo/sentado**, porque ocupada ⟺ cliente abierto sentado (`v_mesa_estado`, que
> conserva todas sus columnas y suma `clientes` (int) y `clientes_detalle` (`[{ id, nombre }]`)). Se libera **cerrando al
> cliente** (`POST /clientes/:id/cerrar`, o `cerrarCliente: true` al cobrar), moviéndolo/liberándolo, o cancelando la
> reserva / marcándola no-show (`cancelar` y `no-show` cierran al cliente de esa reserva; si debe algo → **409**).

### Reportes y tasa
```
GET    /reportes/ventas?periodo=dia|mes|anio&fecha=              -> ReporteVentas
GET    /reportes/productos?periodo=&fecha=&desde=&hasta=&orden=cantidad|ingreso&limite=
                                                                 -> ProductoVendido[]
GET    /reportes/dia?fecha=                                      -> { porTurno: VentaDia[], total: VentaDia }
GET    /reportes/cierre-caja?fecha=                              -> CierreCaja
GET    /tasa/vigente                                             -> TasasVigentes
        (POST /tasa y POST /tasa/actualizar: sólo administrador y encargado, 403 al resto — 2026-09-18)
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

#### `GET /reportes/cierre-caja` — la caja de UN día, con devoluciones          *(reescrito 2026-11-05)*

```ts
interface CierreCaja {
  fecha: string;                         // día operativo resuelto, 'YYYY-MM-DD'
  porMetodo: VentaMetodo[];              // filas crudas de v_venta_dia_metodo (snake_case), una por método × moneda
  devoluciones: Devolucion[];            // cada SALIDA de dinero del día (pagos con monto < 0)
  descuadres: Descuadre[];               // v_cobro_descuadre: debe ser []
  resumen: {
    cajaUsd: string;                     // Σ monto_usd del día, con signo
    ventaDelDiaUsd: string;              // cajaUsd − ajustesOtrosDiasUsd
    ajustesOtrosDiasUsd: string;         // la parte de la caja que corrige facturas de OTRO día
  };
}
interface VentaMetodo {                  // snake_case
  metodo: MetodoPago; moneda: Moneda; fecha_operativa: string;
  pagos: number;                         // movimientos positivos
  devoluciones: number;                  // movimientos negativos
  monto_moneda: string; monto_usd: string;           // SUMAN CON SIGNO: ya descuentan las devoluciones
  ajustes_otros_dias_usd: string;        // parte de monto_usd que corrige facturas de otro día
}
interface Devolucion {                   // snake_case
  pago_id: string; cobro_id: string; factura_numero_dia: number; factura_fecha_operativa: string;
  metodo: MetodoPago; moneda: Moneda; monto: string; monto_usd: string;   // negativos
  referencia: string | null; recibido_en: string; registrado_por_id: string | null;
}
```

- La caja se agrupa por el día en que el dinero **entró o salió** (`cobro_pago.fechaOperativa`), no por el de la
  factura; los pagos son de sólo agregar y una devolución es un pago negativo. Así cada método cuadra solo.
- ⭐ **Corregir HOY una factura de un día D anterior** mueve la caja de **hoy** (el cobro adicional o la devolución entran
  hoy) y la venta del día **D** (`/reportes/ventas`, `/reportes/dia`, `/reportes/productos` agrupan por la fecha de la
  factura y reflejan siempre su versión corregida; ese día ya no es inmutable). La caja de D no cambia.
  Por eso `ajustes_otros_dias_usd` es una **línea propia del cierre**: **caja de hoy = venta de hoy + ajustes de otros
  días**. El frontend debe mostrarla aparte ("ajustes de facturas de días anteriores"); si no, la caja parece descuadrada
  contra la venta del día.
- Anular una factura la saca de las ventas de su día y sus pagos de la caja de los días en que entraron, **sin** registrar
  devolución (comportamiento de siempre).
- `descuadres` sigue en `[]`: cada factura cuadra con TODOS sus pagos, sean del día que sean.

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
| ¿Por qué está ocupada esta mesa? | `v_mesa_estado`: `clientes > 0` (hay un cliente abierto sentado; `clientes_detalle` = `[{ id, nombre }]`). `comandas`/`cuenta_total` = su deuda viva; `sentada_*` = el primer cliente sentado |
| Cola de cocina / barra (KDS) | `SELECT * FROM v_cola_despacho WHERE restaurante_id = $1 ORDER BY creada_en` — FIFO global, líneas embebidas en jsonb |
| Cuentas por cobrar / ficha de un cliente o de una mesa | `SELECT * FROM v_cuenta_cliente WHERE restaurante_id = $1 [AND total_por_cobrar > 0 \| AND cliente_id = $2 \| AND mesa_id = $3]` (sustituye a `v_cuenta_mesa`) |
| Ventas del día y por turno | `SELECT * FROM v_venta_dia WHERE restaurante_id=$1 AND fecha_operativa=$2` |
| **Ventas del mes / del año** | La MISMA vista con `fecha_operativa BETWEEN $2 AND $3`. El mes es la suma de sus días operativos: no hay vista nueva ni `date_trunc` sobre `creado_en` |
| Cierre de caja por método de pago | `v_venta_dia_metodo` (agrupa por el día del MOVIMIENTO; suma con signo; `ajustes_otros_dias_usd`) |
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
| ~~Dividir la cuenta entre comensales~~ | **Hecho (2026-11-05)**: cobro por cliente y por líneas, con partición de cantidades y reasignación de deuda |
| Modificadores con precio ("extra queso +1$") | `comanda_item_modificador`; el snapshot ya está en la línea |
| Rollup `resumen_dia` | La tabla ya está modelada. Se llena al emitir/anular un **cobro** y el dashboard histórico cambia de vista a tabla. **Todavía no hace falta**: medido abajo. ⚠️ Su columna `comandas` pasaría a contar cobros, como `v_venta_dia` |
| Vista materializada de reportes | Sólo si `v_producto_vendido_dia` pasa de ~300 ms. Ver `docs/DECISIONES-DATOS.md §Reportes` |
| Vistas `v_venta_mes` / `v_venta_anio` | **Descartadas.** Serían una segunda definición de "qué cuenta como venta", capaz de quedarse atrás respecto a `v_venta_dia`, a cambio de un `GROUP BY` que ya es barato |
| Multi-sucursal / SaaS | `restauranteId` ya está en todo: se activa `prisma/sql/03_rls.sql` |
| Inventario y recetas | Tablas nuevas; `comanda_item` ya tiene el consumo por producto |
| Auditoría completa | Hoy hay `bitacora` (líneas posteriores al despacho, correcciones de facturas, cambios de cliente), pero **sin endpoint de lectura todavía** |

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
