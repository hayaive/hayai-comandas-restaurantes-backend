# HAYAI Comandas · Contrato de entidades y API

> Autor: **J.O.R.B.I** (data-engineer). Producido antes de implementar.
> Fuente de verdad del esquema: `prisma/schema.prisma` + `prisma/sql/`.
> El porqué de cada decisión: `docs/DECISIONES-DATOS.md`.
>
> Este documento es el contrato que **D.A.N.I** (fullstack) implementa en
> backend y frontend en paralelo. Nombres de campo en el wire = camelCase,
> exactamente como los expone Prisma. En la base son snake_case.

---

## 0 · Mapa mental en una pantalla

```
restaurante
  └── salon ("Salón principal", "Terraza")         ← espacio FÍSICO
        ├── mesa ("5", "T-2")                      ← IDENTIDAD estable
        └── plantilla ("Normal", "Evento boda")    ← DISTRIBUCIÓN, 1 activa por salón
              └── plantilla_mesa                   ← posición + tamaño + sillas
                     (plantilla × mesa)

reservacion ── (al llegar) ──> comanda ──> comanda_item ──> comanda_pago
                                   │
                              producto ← categoria
```

Las tres ideas que hay que entender antes de tocar código:

1. **La mesa y su sitio en el plano son dos cosas distintas.** `mesa` es la
   identidad ("Mesa 5"); `plantilla_mesa` es dónde está dibujada, cuánto mide y
   cuántas sillas tiene *en esa distribución*. Así la misma mesa puede ser de 4
   sillas en la distribución normal y de 10 en un banquete, y el histórico de
   ventas de la Mesa 5 sobrevive a cualquier rediseño del salón.
2. **La comanda ES la ocupación.** No hay tabla de "sesión de mesa": una mesa
   está ocupada si y solo si tiene una comanda en estado `abierta` o
   `por_cobrar`. La base garantiza que no puede haber dos.
3. **El día operativo no es `creado_en::date`.** Es `fecha_operativa`, calculada
   al abrir la comanda con la hora de corte del restaurante. Todos los reportes
   agrupan por ahí — y el mes y el año son la **suma de esos días**, no un rango
   de timestamps (§5, `GET /reportes/ventas`).

---

## 1 · Enumeraciones

```ts
type RolUsuario        = 'administrador' | 'encargado' | 'mesero' | 'cocina' | 'caja';
type FormaMesa         = 'redonda' | 'cuadrada' | 'rectangular' | 'barra';
type EstadoReservacion = 'pendiente' | 'confirmada' | 'sentada' | 'completada'
                       | 'cancelada' | 'no_show';
type OrigenReservacion = 'personal' | 'enlace_publico';
type TipoComanda       = 'mesa' | 'para_llevar';
type EstadoComanda     = 'abierta' | 'por_cobrar' | 'cobrada' | 'anulada';
type EstadoComandaItem = 'pendiente' | 'en_preparacion' | 'servido' | 'cancelado';
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

### 2.9 Comanda

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `restauranteId` | uuid | |
| `tipo` | TipoComanda | `mesa` exige `mesaId`+`salonId`+`plantillaId`; `para_llevar` exige `mesaId` NULL |
| `salonId`, `mesaId`, `plantillaId` | uuid? | |
| `reservacionId` | uuid? | La reserva que se sentó aquí (1:1) |
| `numeroDia` | int | Número visible. Único por `(restaurante, fechaOperativa)` |
| `fechaOperativa` | date | Día contable. **Se calcula al abrir** |
| `turno` | TurnoServicio | Ídem |
| `comensales` | int | |
| `meseroId` | uuid? | |
| `estado` | EstadoComanda | |
| `abiertaEn`, `cerradaEn?` | datetime | |
| `subtotal`, `descuento`, `impuesto`, `propina`, `total` | decimal | USD. Los recalcula **el servidor** |
| `tasaId?`, `tasaValor?`, `totalBs?` | | Congelados **al cobrar**, no antes |
| `anuladaPorId?`, `motivoAnulacion?` | | |

### 2.10 ComandaItem

`id`, `restauranteId`, `comandaId`, `productoId`, `ronda` (1 = entradas, 2 =
principales…), `orden`, `nombreSnap`, `precioUnitarioSnap`, `destinoSnap`,
`cantidad`, `descuentoLinea`, `totalLinea`, `estado: EstadoComandaItem`,
`nota?`, `enviadoEn?`, `servidoEn?`, `canceladoPorId?`, `motivoCancelacion?`.

> Los `*Snap` son **obligatorios**: el ticket de hoy tiene que poder
> reimprimirse idéntico dentro de un año aunque el producto haya cambiado de
> precio o de nombre. Nunca leer el precio actual del producto para un reporte
> histórico.
>
> `estado` **no tiene `pagado`**: el pago es de la comanda completa, no de la
> línea. Ver `docs/DECISIONES-DATOS.md §D7`.

### 2.11 ComandaPago

`id`, `restauranteId`, `comandaId`, `metodo: MetodoPago`, `moneda: Moneda`,
`monto` (en esa moneda), `tasaAplicada?`, `montoUsd`, `referencia?`,
`recibidoEn`, `registradoPorId?`.

Reglas que **la base** hace cumplir:
- `pago_movil` y `transferencia` exigen `referencia` no vacía (conciliación bancaria).
- `moneda = 'BS'` exige `tasaAplicada`; `moneda = 'USD'` exige que sea NULL.
- Varias filas por comanda: el pago mixto (mitad efectivo USD, mitad pago móvil)
  es lo normal, no la excepción.

### 2.12 TasaCambio / ContadorComanda / ResumenDia

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
- Una comanda sólo puede congelar una tasa con `divisa='USD'`, la moneda base.
  El euro es **informativo**: hoy nadie paga en euros. Lo impide el trigger
  `comanda_tasa_base`, no el código.
- La `divisa` de una tasa ya registrada es **inmutable** (`tasa_divisa_inmutable`).
  Corregir el `valor` sí se permite; cambiar de dólar a euro, no.

- `ContadorComanda`: `(restauranteId, fechaOperativa)` → `ultimo`. Infraestructura
  del número visible; el frontend no la ve.
- `ResumenDia`: rollup por `(restaurante, fechaOperativa, turno)`. **Fase 2**:
  no se implementa hasta que el dashboard lo pida (ver §7).

---

## 3 · Flujos que tocan varias tablas

Todos van en **una transacción**.

### 3.1 Abrir comanda en una mesa

```
1. Resolver fechaOperativa y turno:
     SELECT hayai_fecha_operativa(now(), r.zona_horaria, r.hora_corte_dia),
            hayai_turno(now(), r.zona_horaria)
   (usar las funciones SQL, NO reimplementar la regla en TypeScript)
2. Reservar número visible, atómico:
     INSERT INTO contador_comanda (restaurante_id, fecha_operativa, ultimo)
     VALUES ($1, $2, 1)
     ON CONFLICT (restaurante_id, fecha_operativa)
     DO UPDATE SET ultimo = contador_comanda.ultimo + 1
     RETURNING ultimo;
   (nunca MAX(numero_dia)+1: duplica números con dos meseros a la vez)
3. INSERT comanda (estado='abierta', plantillaId = plantilla activa del salón)
   → si viola `comanda_mesa_activa_unica` (23505): 409 "la mesa ya tiene comanda".
4. Si viene de reserva: UPDATE reservacion SET estado='sentada', sentada_en=now().
```

### 3.2 Enviar una ronda a cocina

```
1. UPDATE comanda_item SET estado='en_preparacion', enviado_en=now()
   WHERE comanda_id=$1 AND ronda=$2 AND estado='pendiente';
2. La cola de cocina es GET /cocina/cola (índice comanda_item_cocina_idx).
```

### 3.3 Cobrar

```
1. Recalcular totales en el servidor desde comanda_item (jamás confiar en el cliente).
2. Leer la tasa vigente DEL DÓLAR y CONGELARLA: comanda.tasaId, tasaValor, totalBs.
   ⚠️ `where: { restauranteId, divisa: 'USD' }`, `orderBy: [{ fecha: 'desc' },
   { creadaEn: 'desc' }]`. Sin el filtro de divisa la consulta puede devolver
   la cotización del EURO y convertir cada bolívar con un ~8-15 % de error.
   La base lo rechaza (trigger `comanda_tasa_base`), pero el cobro entero
   revienta con un 500: el filtro no es opcional.
3. INSERT de N comanda_pago. La suma de montoUsd debe cuadrar con total.
4. UPDATE comanda SET estado='cobrada', cerradaEn=now()
   → libera la mesa automáticamente (sale del índice parcial).
5. Si había reserva: estado='completada'.
6. Verificación: la vista v_comanda_descuadre debe seguir devolviendo 0 filas.
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

Nunca `DELETE FROM mesa`: hay comandas y reservas históricas apuntando ahí, y la
FK es `RESTRICT` precisamente para que ese error salte en desarrollo.

---

## 4 · Errores de base que hay que traducir

El backend **debe** capturarlos; son reglas de negocio, no fallos técnicos.

| Código PG | Objeto | HTTP | Mensaje sugerido |
|---|---|---|---|
| `23P01` | `reservacion_sin_solape` | 409 | "Esa mesa ya está reservada en ese horario" |
| `23505` | `comanda_mesa_activa_unica` | 409 | "La mesa ya tiene una comanda abierta" |
| `23505` | `plantilla_activa_unica` | 409 | "Ese salón ya tiene una plantilla activa" |
| `23505` | `mesa_etiqueta_unica` | 409 | "Ya existe una mesa con ese número" |
| `23505` | `comanda_numero_dia_unico` | 500 | Bug: el número se pidió sin el contador |
| `23514` | cualquier CHECK | 422 | Según el constraint (ver `01_constraints_y_triggers.sql`) |
| `23503` | cualquier FK | 422 | "El registro referenciado no existe" |
| `23514` | `plantilla_mesa_mismo_salon` | 422 | "Esa mesa pertenece a otro salón" |
| `23505` | `tasa_cambio_dia_unica` | 409 | "Ya existe una tasa para esa divisa, fecha y fuente" — **no debería verse**: `POST /tasa` es upsert |
| `23514` | `comanda_tasa_base` | **500** | Bug: se cobró con una tasa que no es la del dólar. Es un error del backend, no del usuario |
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
DELETE /plantillas/:id                                           -> 204
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

### Comandas
```
GET    /comandas/activas                                         -> ComandaActiva[]  (panel lateral, vista v_comanda_activa)
POST   /comandas                   { tipo, mesaId?, comensales?, reservacionId? } -> Comanda
GET    /comandas/:id                                             -> Comanda & { items, pagos }
POST   /comandas/:id/items         { items: [{ productoId, cantidad, nota? }] } -> ComandaItem[]
PATCH  /comandas/:id/items/:itemId { cantidad?, nota? }          -> ComandaItem
DELETE /comandas/:id/items/:itemId { motivo }                    -> 204   (estado='cancelado', no borra)
POST   /comandas/:id/enviar        { ronda }                     -> ComandaItem[]
PATCH  /comandas/:id/items/:itemId/estado { estado }             -> ComandaItem
POST   /comandas/:id/mover         { mesaIdDestino }             -> Comanda
POST   /comandas/:id/cuenta                                      -> Comanda   (estado='por_cobrar')
POST   /comandas/:id/cobrar        { propina?, descuento?, pagos: PagoInput[] } -> Comanda
POST   /comandas/:id/anular        { motivo }                    -> Comanda
GET    /cocina/cola?destino=cocina|barra                         -> ItemCola[]
```

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
  comandas: number;
  comensales: number;
  totalUsd: string;
  /** Total SIN propina: la propina es del mesero, no ingreso del local. */
  ventasUsd: string;
  propinasUsd: string;
  descuentosUsd: string;
  impuestosUsd: string;
  /** totalUsd / comandas. '0.0000' si el tramo no tuvo ventas. */
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
cuelga que el reporte sea correcto: `comanda.fecha_operativa` se materializa al
abrir con `hayai_fecha_operativa(now(), zona, hora_corte)` (§3.1,
`docs/DECISIONES-DATOS.md §5`), y el mes y el año son la **suma de esos días**,
no un `BETWEEN` sobre `creado_en`. Con corte a las 05:00, una comanda cobrada
la 01:00 del 1 de octubre entra en **septiembre**. Verificado en
`test/reportes-periodo.e2e-spec.ts`.

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
| Panel lateral de comandas activas | `SELECT * FROM v_comanda_activa WHERE restaurante_id = $1 ORDER BY abierta_en` |
| Ventas del día y por turno | `SELECT * FROM v_venta_dia WHERE restaurante_id=$1 AND fecha_operativa=$2` |
| **Ventas del mes / del año** | La MISMA vista con `fecha_operativa BETWEEN $2 AND $3`. El mes es la suma de sus días operativos: no hay vista nueva ni `date_trunc` sobre `creado_en` |
| Cierre de caja por método de pago | `v_venta_dia_metodo` |
| **Producto más vendido** | `SELECT * FROM v_producto_vendido_dia WHERE ... ORDER BY cantidad DESC LIMIT 10` (o `ingreso_usd DESC`) |
| Cola de cocina | `comanda_item` con `estado IN ('pendiente','en_preparacion')` y `destino_snap = $1` |
| Reservas que quedaron fuera del plano | `v_reservacion_huerfana` |
| Cuadre de cobros | `v_comanda_descuadre` — debe dar 0 filas siempre |

> "Producto más vendido" tiene **dos respuestas distintas** y la vista devuelve
> las dos: por `cantidad` gana la empanada, por `ingreso_usd` gana el solomo. La
> UI debe decir cuál está mostrando.

---

## 7 · Lo que NO está en el MVP (y cómo entra después sin romper nada)

| Funcionalidad | Cómo se añade |
|---|---|
| Dividir la cuenta entre comensales | Tabla `comanda_cuenta` + `comanda_item.cuenta_id`. No toca lo existente |
| Modificadores con precio ("extra queso +1$") | `comanda_item_modificador`; el snapshot ya está en la línea |
| Rollup `resumen_dia` | La tabla ya está modelada. Se llena al cerrar/anular comanda y el dashboard histórico cambia de vista a tabla. **Todavía no hace falta**: medido abajo |
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
