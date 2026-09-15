# HAYAI Comandas · Decisiones de modelado

> Autor: **J.O.R.B.I** (data-engineer) · 2026-09-12
> Ampliado el 2026-09-13 con §D13/§D14 y §10 (tasa del euro).
> Ampliado el 2026-09-14 con §D15 y §11 (ventas por mes y por año).
> Acompaña a `prisma/schema.prisma`, `prisma/sql/` y `CONTRACT.md`.
>
> ⚠️ **§D5, §4 y parte de §6/§7 quedaron SUPERADOS el 2026-09-15** por el
> rediseño de *comandas múltiples por mesa + cobro consolidado* (migración
> `20260915183000_comandas_multiples_y_cobro`, diseño de J.O.R.B.I verificado
> contra Postgres 17 con 43 aserciones). Una comanda ya no es la cuenta de la
> mesa sino UN pedido; la cuenta es la suma de las comandas vivas y se factura
> con la entidad nueva `Cobro`. Se conservan tal cual porque explican por qué el
> modelo era así y qué obligó a cambiarlo; los apartados afectados llevan una
> nota al principio. Lo vigente está en `CONTRACT.md` §0, §2.9-§2.12 y §3.
>
> **Estado de verificación:** el esquema completo (DDL de Prisma + los 5 archivos
> de `prisma/sql/`) se aplicó sobre **PostgreSQL 17.10** en un contenedor
> efímero y se ejecutó una batería de 22 aserciones sobre los invariantes
> (solape de reservas, doble comanda, plantilla activa, coherencia de salón,
> día operativo, pagos, RLS). Todas pasaron. No es un esquema "sobre el papel".

---

## 0 · Resumen de decisiones

| # | Decisión | Alternativa descartada | Motivo en una línea |
|---|---|---|---|
| D1 | `restaurante_id` en todas las tablas desde el día 1 | Esquema de un solo restaurante | La columna hoy cuesta nada; añadirla después obliga a rehacer cada PK, índice y consulta |
| D2 | RLS escrito pero **de activación diferida** | RLS desde el primer commit / nunca | Con un restaurante y un backend no compra nada; el día del 2º tenant o del enlace público es obligatorio, y ya está escrito |
| D3 | `salon` (espacio físico) separado de `plantilla` (distribución) | Sólo plantillas | Terraza y salón operan A LA VEZ; "Normal" y "Evento boda" son alternativas del mismo salón. Sin los dos niveles, uno de los dos casos es imposible |
| D4 | La mesa es identidad; posición/forma/capacidad viven en `plantilla_mesa` | Mesa con `pos_x`/`pos_y` propios | La Mesa 5 sigue siendo la Mesa 5 al reorganizar el salón: reservas, comandas e histórico sobreviven al rediseño del plano |
| D5 | Una comanda **es** la ocupación de la mesa | Tabla `mesa_sesion` aparte + comandas | El invariante que importa ("una cuenta viva por mesa") se expresa como índice único parcial; las rondas se modelan con `comanda_item.ronda` |
| D6 | Doble reserva impedida por `EXCLUDE` sobre `tstzrange` | Comprobar solape en el servicio | En aplicación exige SERIALIZABLE o advisory locks y falla justo el sábado a las 8pm con dos peticiones simultáneas |
| D7 | El ítem no tiene estado `pagado` | `pagado` en la línea | El pago es de la cuenta. Si algún día se divide, entra `comanda_cuenta` sin tocar la línea |
| D8 | `fecha_operativa` materializada al abrir | `creado_en::date` en los reportes | Un restaurante que cierra a las 2am factura al día anterior; derivarlo del UTC parte además la cena en dos días |
| D9 | Número visible por `contador_comanda` con UPSERT atómico | `MAX(numero_dia)+1` | Dos meseros abriendo a la vez leen el mismo máximo y duplican el número |
| D10 | Precios en USD; Bs nunca persistido salvo lo ya cobrado | Precio en Bs | La tasa BCV se mueve a diario; sólo se congela cuando el dinero entró, para reimprimir el ticket con la tasa real |
| D11 | Reportes por vistas SQL, rollup sólo cuando duela | Vista materializada desde el día 1 | El día en curso tiene que ser exacto y una MV no se refresca en tiempo real |
| D12 | FKs compuestas `(restaurante_id, id)` | FK simple por `id` | Referenciar datos de otro restaurante deja de ser un bug de permisos y pasa a ser una violación de constraint |
| D13 | Enum `Divisa` ('USD','EUR') **aparte** de `Moneda` ('USD','BS') | Añadir `EUR` al enum `Moneda` | `Moneda` es el dominio del COBRO; un `EUR` ahí lo aceptaría el DTO de pago y el cálculo lo trataría como bolívares |
| D14 | `tasa_cambio.divisa` con `DEFAULT 'USD'`; el cobro sólo admite USD, y lo impide un trigger | Tabla aparte para el euro / confiar en que el código filtre | Una tabla gemela se fusionaría el día que el euro se cobre; y un filtro olvidado cuesta ~8-15 % en cada bolívar cobrado |
| D15 | Mes y año como `GROUP BY` sobre `v_venta_dia`, sin vistas nuevas | `v_venta_mes` / `v_venta_anio` | El mes ES la suma de sus días operativos; una vista aparte sería una segunda definición de "qué cuenta como venta", y el año ya se agrega en ~77 ms con 73k comandas |

---

## 1 · Multi-restaurante: por qué sí la columna y todavía no el RLS

La pregunta era si el tenant es sobre-ingeniería para un MVP. Hay que separarla
en dos, porque tienen respuestas distintas:

**La columna `restaurante_id`: sí, desde el día 1.** No es una funcionalidad, es
la forma de las claves. Añadirla después significa reescribir cada índice (el
tenant va delante), cada constraint de unicidad ("Mesa 5" pasa de única a única
*por restaurante*), cada consulta y cada FK. Es la migración más cara que
existe y nunca hay un buen momento. Hoy cuesta 16 bytes por fila.

**La maquinaria RLS: todavía no.** Obliga a que cada request abra transacción y
emita `SET LOCAL`, con el riesgo de que un `$queryRaw` olvidado devuelva datos
de otro tenant si se hace a medias. Con **un** restaurante no protege de nada.
`prisma/sql/03_rls.sql` está escrito, probado y con el criterio de activación en
su encabezado: **el segundo restaurante, o la publicación del enlace público de
reservas** — lo que ocurra primero. El enlace público cuenta porque atiende
peticiones sin sesión.

Lo que **no** se copió de `hayai-saas`: planes, suscripciones, límites por
trigger, matriz de 23 permisos, sync offline. Eso es el SaaS, no un MVP de
comandas. El rol de usuario aquí es un enum de 5 valores.

---

## 2 · El plano: la decisión de la que cuelga todo lo demás

El requisito dice "plantillas, cada una con su propio set de mesas, posiciones y
capacidades". Leído literal, lleva a poner las mesas **dentro** de la plantilla.
Ese modelo se rompe en cuanto se usa:

- La reserva del sábado apunta a una mesa de la plantilla "Normal". El sábado se
  activa "Evento boda" → la mesa reservada deja de existir.
- "¿Cuánto factura la mesa 5?" no tiene respuesta: hay una mesa 5 por plantilla.
- Clonar una plantilla duplica las mesas, y cada copia acumula su propia
  historia inconexa.

El modelo elegido separa **identidad** (`mesa`) de **presentación**
(`plantilla_mesa`), y da exactamente la misma UX:

| Lo que el usuario hace en el editor | Lo que pasa en la base |
|---|---|
| Arrastra una mesa | `UPDATE plantilla_mesa SET pos_x, pos_y` |
| Cambia las sillas de 4 a 10 | `UPDATE plantilla_mesa SET capacidad` (sólo en esa plantilla) |
| Agrega una mesa nueva | `INSERT mesa` + `INSERT plantilla_mesa` |
| Borra una mesa del plano | `DELETE plantilla_mesa` (la mesa y su historia siguen) |
| Clona la plantilla | `INSERT ... SELECT` de `plantilla_mesa` |

La capacidad y la forma viven en `plantilla_mesa` y son **NOT NULL**, no
opcionales con *fallback* a la mesa. Un `COALESCE(pm.capacidad, m.capacidad)` en
cada consulta de disponibilidad es una fuente de errores silenciosos; la verdad
operativa es la de la distribución vigente, y punto. `mesa.capacidad_default`
existe sólo como valor que el editor copia al añadirla a una plantilla nueva.

**Coherencia salón ↔ mesa ↔ plantilla.** Una FK no puede comprobar que la mesa y
la plantilla sean del *mismo* salón, así que lo hace un trigger (probado: meter
una mesa de la terraza en el plano del salón principal da 23514). Se resolvió con
trigger y no duplicando `salon_id` en `plantilla_mesa` porque una columna copiada
crea un segundo problema — mantenerla sincronizada cuando una mesa se muda.

**El caso feo, resuelto:** si se activa una plantilla que no incluye mesas ya
reservadas, esas reservas quedan huérfanas. No se bloquea el cambio (es una
decisión del dueño), pero la vista `v_reservacion_huerfana` las lista y
`POST /plantillas/:id/activar` las devuelve para avisar en pantalla.

---

## 3 · Reservaciones: el solape lo impide Postgres

Una reserva es un **rango de tiempo sobre una mesa**, y el bug clásico es
aceptar dos que se pisan. Comprobarlo con un `SELECT` previo no funciona: entre
el SELECT y el INSERT cabe otra transacción, y con el enlace público de
reservas eso deja de ser teórico.

```sql
EXCLUDE USING gist (restaurante_id WITH =, mesa_id WITH =, periodo WITH &&)
  WHERE (mesa_id IS NOT NULL AND estado IN ('pendiente','confirmada','sentada'))
```

Verificado: solape → `23P01`; reserva **adyacente** (21:30 justo cuando la
anterior termina) → permitida, porque el rango es `[)`; cancelar una reserva
**libera el hueco** automáticamente, sin borrar nada, porque el predicado sólo
mira los estados vivos.

Dos detalles que costaron una corrección cada uno:

1. **`periodo` no puede ser una columna generada.** `timestamptz + interval` es
   `STABLE`, no `IMMUTABLE` (depende del huso por el horario de verano), y
   Postgres rechaza la definición. Se mantiene con un trigger, y `inicia_en` /
   `termina_en` son columnas reales.
2. **El rango invertido daba `22000`, no `23514`.** `tstzrange(a, b)` con `b < a`
   revienta en el trigger *antes* de que el CHECK se evalúe, con un error
   genérico que el backend no puede distinguir de cualquier otro fallo de datos.
   El trigger ahora valida primero y lanza `23514` con el nombre del constraint.

**El código del QR** (`codigo_publico`) es aleatorio de ≥64 bits y viaja en la
URL. No se guarda hasheado a propósito: el anfitrión tiene que poder reenviar el
QR al cliente, y lo que autoriza es limitado (ver la propia reserva y elegir mesa
entre las libres). A cambio, el endpoint público **exige rate-limit** y nunca
devuelve datos de otras reservas. `codigo_corto` es para cantarlo en la puerta y
no autoriza nada.

---

## 4 · Comandas: una cuenta viva por mesa, garantizada

> ⚠️ **SUPERADO (2026-09-15).** Este apartado describe el modelo anterior. El
> índice `comanda_mesa_activa_unica` ya no existe: cada envío a cocina es una
> comanda propia y una mesa tiene N vivas a la vez. Lo que sí sobrevive es el
> razonamiento —el invariante que de verdad importa se expresa en la base, no en
> la aplicación—; lo que cambió es CUÁL es el invariante. Su sucesor sin el
> UNIQUE es `comanda_cuenta_abierta_idx`, que conserva los beneficios 2 y 3 de
> la lista de abajo (liberación automática y panel barato) y suelta el 1, que
> dejó de ser cierto. La unicidad que sí quedó es la de la factura:
> `cobro_numero_dia_unico`, más el trigger diferido `cobro_no_vacio` contra la
> factura fantasma de dos cajeros concurrentes.

```sql
CREATE UNIQUE INDEX comanda_mesa_activa_unica
  ON comanda (restaurante_id, mesa_id)
  WHERE mesa_id IS NOT NULL AND estado IN ('abierta','por_cobrar');
```

Un índice, tres beneficios:

1. **Integridad**: dos meseros abriendo la misma mesa a la vez → el segundo
   recibe `23505` (verificado). Sin esto se crean dos comandas y el cliente paga
   una sola.
2. **Liberación automática**: al cobrar, la fila sale del índice. No hay columna
   `mesa.estado` que mantener sincronizada — y por tanto no hay mesas que se
   quedan "ocupadas" para siempre porque un proceso murió a medias.
3. **Rendimiento del panel lateral**: el índice contiene **sólo** las mesas
   ocupadas ahora mismo. "Listar comandas activas" no toca la tabla histórica.

Por eso no existe una tabla `mesa_sesion` separada: no aportaría un invariante
que este índice no dé, y añadiría una entidad más que mantener en sincronía.
Las rondas (entradas, luego principales, luego postres) se modelan con
`comanda_item.ronda` + `enviado_en`, que es como funciona un KDS real.

**Lo que la base también impide** (todo verificado):
- Comanda de tipo `mesa` sin mesa → `23514`.
- Cobrar sin congelar la tasa (`tasa_valor` y `total_bs`) → `23514`. Reimprimir
  un ticket un mes después tiene que dar el mismo monto en bolívares.
- `pago_movil` o `transferencia` sin referencia bancaria → `23514`. Un pago que
  no se puede conciliar con el banco no debería poder guardarse.
- `moneda = 'BS'` sin tasa aplicada, o `USD` con tasa → `23514`.

---

## 5 · Día operativo y turno

`fecha_operativa` es una columna real, calculada **al abrir** la comanda:

```sql
hayai_fecha_operativa(now(), 'America/Caracas', '05:00')
```

Verificado: las 02:30 del 13 de septiembre pertenecen al **12**; la 1:00 pm del
13, al 13. Si el día se derivara de `creado_en::date` en UTC, el corte caería a
las 20:00 hora de Caracas y partiría el servicio de la cena en dos días — el
reporte del día quedaría mal para el turno que más factura.

La regla vive **una sola vez**, en SQL, y el backend la llama en vez de
reimplementarla en TypeScript. Si se duplica, tarde o temprano divergen y el
cuadre de caja deja de cerrar por unas pocas comandas de madrugada.

---

## 6 · Reportes: ventas del día y producto más vendido

`comanda_item` con `producto_id` + snapshots es la tabla que sostiene ambas
preguntas. Las respuestas están en vistas (`v_venta_dia`, `v_venta_dia_metodo`,
`v_producto_vendido_dia`), no en consultas repartidas por el código.

**Por qué vistas normales y no materializadas, hoy.** Un restaurante genera
cientos de comandas al día, no millones. El dashboard del día en curso tiene que
ser **exacto** — una MV refrescada cada N minutos muestra ventas viejas justo
cuando el dueño está mirando. Con `comanda (restaurante_id, fecha_operativa,
estado)` el día actual se agrega en milisegundos.

**Cuándo pasar a rollup** (`resumen_dia`, ya modelado, vacío): cuando
`v_producto_vendido_dia` sobre un rango largo pase de ~300 ms, o el histórico
supere ~50k líneas/mes. Entonces se llena `resumen_dia` en la misma transacción
que cierra o anula la comanda, y **sólo el histórico** se lee de ahí; el día en
curso se sigue calculando en vivo. Ese orden importa: primero medir, después
desnormalizar.

**"Producto más vendido" tiene dos respuestas** y la vista devuelve las dos. En
la prueba con datos reales: Empanada gana por cantidad (6 unidades, 9 USD),
Pabellón gana por ingreso (2 unidades, 25 USD). La UI debe decir cuál muestra;
elegir una en silencio sería decidir por el negocio.

**`v_comanda_descuadre`** lista comandas cobradas donde la suma de pagos no
cuadra con el total. No se puede expresar como CHECK (cruza dos tablas) y debe
dar 0 filas siempre: si aparece una, hay un bug de cobro. Es la consulta del
cierre de caja.

---

## 7 · Índices, y por qué cada uno

Regla general heredada de `hayai-saas`: **`restaurante_id` primero en todo índice
compuesto**, o el día que se active RLS la política fuerza escaneos.

| Índice | Para qué | Por qué parcial |
|---|---|---|
| ~~`comanda_mesa_activa_unica`~~ → `comanda_cuenta_abierta_idx` | Plano + cuentas por cobrar | Sólo comandas vivas: índice diminuto. Perdió el UNIQUE en el rediseño de 2026-09-15 |
| `comanda_cola_despacho_idx` | Cola del KDS, FIFO global | Sólo lo que la cocina no ha sacado; ya viene ordenado por `creada_en` |
| `plantilla_activa_unica` | Resolver la plantilla vigente | Una fila por salón |

| `reservacion_agenda_idx` | Agenda del día | Canceladas y no-show no estorban |

| `mesa_etiqueta_unica` | "Mesa 5" única | Por expresión (`lower`) y sólo entre las vivas: permite reutilizar el número de una mesa borrada |
| `comanda (restaurante_id, fecha_operativa, estado)` | Reporte del día | — |
| `comanda_item (restaurante_id, producto_id)` | Producto más vendido | — |

Todas las FK tienen índice: Postgres **no** lo crea solo, y sin él un `DELETE` en
el padre escanea la hija entera.

Lo que **no** se indexó: nada por especulación. Cuando aparezca una consulta
lenta, `EXPLAIN ANALYZE` primero y el índice que el plan justifique después. Un
índice que nadie usa se paga en cada escritura.

---

## 8 · La trampa de Prisma que hay que tener presente

Prisma modela tablas, columnas, índices y FKs. **No** modela índices parciales o
por expresión, CHECKs, EXCLUDE, triggers, funciones ni vistas.

- Lo que no modela, lo ignora: sobrevive solo a `migrate dev`.
- Los índices **sí** los modela: uno que está en la base y no en `schema.prisma`
  le parece basura y emite `DROP INDEX`.

Si ese `DROP INDEX` se aplica sin leerlo, el sistema pierde **en silencio** la
prohibición de doble comanda o de doble reserva. Nada falla; simplemente, unas
semanas después, una mesa aparece reservada dos veces.

Contramedidas, las tres juntas:
1. Generar siempre con `prisma migrate dev --create-only`, **leer** el SQL y
   borrar a mano cualquier `DROP INDEX` de la lista de `prisma/sql/`.
2. `prisma/sql/99_verificar_objetos.sql` en CI: comprueba los 10 índices, 8
   constraints, 3 triggers, 5 funciones y 7 vistas críticas, y además que
   ninguna vista haya perdido `security_invoker`. Convierte el fallo silencioso
   en un build roto.
3. `periodo` se declara en Prisma como `Unsupported("tstzrange")` — así Prisma
   la ve y no intenta borrarla, pero no la expone al cliente: la llena el trigger.

Detalle relacionado: **ninguna FK compuesta usa `onDelete: SetNull`**. Postgres
anularía *todas* las columnas de la FK, incluida `restaurante_id`, que es NOT
NULL, y el DELETE fallaría en producción con un error incomprensible. Todas son
`Restrict`, que además es la semántica correcta: a un usuario que firmó comandas
se le desactiva, no se le borra.

---

## 9 · Decisiones abiertas (con default aplicado salvo aviso)

| # | Pregunta para el negocio | Default aplicado | Coste de cambiarlo |
|---|---|---|---|
| A1 | ¿Se cobra impuesto (IVA 16%) o el precio ya lo incluye? | Columna `comanda.impuesto` existe y queda en 0 | Bajo: una regla de cálculo |
| A2 | ¿La propina es sugerida (10%), fija o libre? | Columna libre, la fija el cajero | Bajo |
| A3 | ¿Hace falta dividir la cuenta entre comensales? | No en v1 | Medio: tabla `comanda_cuenta` + `item.cuenta_id` |
| A4 | ¿Modificadores de plato con precio ("extra queso")? | No en v1; hay `item.nota` libre | Medio: tabla nueva |
| A5 | Duración por defecto de una reserva | 90 min, configurable por restaurante | Cero: es un dato |
| A6 | ¿Puede el cliente reservar sin elegir mesa? | Sí (`mesa_id` nullable); la asigna el anfitrión | Cero |
| A7 | ¿Comanda para llevar / delivery? | Modelado (`tipo = 'para_llevar'`), sin pantalla | Bajo |
| A8 | ¿El ticket debe mostrar el total en Bs siempre? | Sí: al cobrar se exige `total_bs` | Si algún restaurante opera sólo en USD, relajar el CHECK `comanda_tasa_congelada` |
| A9 | ¿De dónde salen las tasas (BCV dólar y euro)? | Tabla `tasa_cambio` por divisa, carga manual o job (§10) | Bajo |
| A10 | Inventario / recetas / descuento de insumos | Fuera de alcance | Alto: módulo nuevo (existe el precedente de `hayai-saas`) |

**Dos avisos en voz alta para D.A.N.I:**

1. Los totales de la comanda **se recalculan en el servidor** a partir de
   `comanda_item`, nunca se toman del cliente. El frontend los muestra; no los
   decide.
2. `restaurante_id` sale **siempre del token verificado**, jamás del body, de un
   query param o de un header — también en los endpoints públicos de reserva,
   donde sale del `slug` de la ruta resuelto contra la tabla `restaurante`.

---

## 10 · Dos tasas: el dólar y el euro          *(añadido 2026-09-13)*

> **Estado de verificación:** la migración `20260913101500_tasa_por_divisa` se
> aplicó sobre un PostgreSQL real y se corrieron **22 aserciones** sobre los
> invariantes de este apartado. Todas pasan, y `npm run db:verify` reconoce los
> objetos nuevos. El `migrate diff` contra la base no reporta deriva.

El pedido del cliente fue: *"ver un apartado donde se aprecie a qué valor está
el BCV y el EURO a la tasa central, y que los precios en dólares puedan ver su
correlativo en bolívares, o viceversa"*.

Es un pedido de **visualización**. Los precios del menú se siguen fijando en
USD (§D10) y el cobro sigue siendo USD/Bs. Nadie paga en euros. Lo único que
falta en la base es poder guardar una segunda cotización.

### 10.1 Por qué `Divisa` es un enum nuevo y no `EUR` dentro de `Moneda`

Lo obvio era `enum Moneda { USD BS EUR }`. Es la decisión que había que evitar,
porque `Moneda` no significa "una moneda cualquiera": es **el dominio del
cobro**. Aparece en `comanda_pago.moneda` y en `restaurante.moneda_base`, y el
cálculo del cobro está escrito así:

```ts
const montoUsd = p.moneda === 'USD' ? monto : monto.div(tasa.valor);
```

Es decir: **todo lo que no es USD se trata como bolívares**. Un pago marcado
`EUR` habría entrado por esa rama y se habría dividido entre la tasa del dólar.
El `CHECK pago_tasa_coherente` tampoco ayuda — está escrito como
`(moneda='USD' AND tasa IS NULL) OR (moneda='BS' AND tasa IS NOT NULL)`, así que
un `EUR` no encaja en ninguna rama y sería rechazado con un 422 incomprensible.
Añadir `EUR` a `Moneda` habría creado un valor **tecleable en todas partes y
guardable en ninguna**.

`Divisa` se llama así y no `MonedaTasa` porque la exclusión de `BS` deja de ser
arbitraria y pasa a ser semántica: una tasa es siempre *"bolívares por 1 unidad
de la divisa"*, así que el denominador es fijo y `BS` no puede ser miembro.
Con `MonedaTasa`, el primer lector se preguntaría por qué falta `BS`.

Verificado: el enum `moneda` sigue siendo exactamente `USD,BS`, y un
`INSERT INTO comanda_pago ... moneda='EUR'` ni siquiera llega a evaluarse
(`22P02`: el valor no existe en el tipo).

### 10.2 Una sola tabla con discriminador, no dos tablas

La alternativa era dejar `tasa_cambio` intacta (sólo dólar) y crear una tabla
para el euro. Se descartó: serían dos tablas de forma idéntica que habría que
fusionar el día que el euro se cobre de verdad, y cada consulta de "las tasas
de hoy" tendría que hacer `UNION`. Una tabla con `divisa` es la forma normal
de esto, y absorbe sin cambios la tercera divisa que pidan.

El `DEFAULT 'USD'` no es comodidad: es el **backfill exacto**. Las filas que ya
existen se escribieron cuando la columna no existía y `valor` significaba, por
definición, bolívares por dólar. No hay que adivinar nada. Verificado: una fila
insertada sin nombrar la divisa queda en `USD`.

El único a favor de extender `Moneda` era no crear un tipo más. El coste de
equivocarse en la dirección contraria es dinero mal cobrado, y no es simétrico.

### 10.3 El índice: uno solo hace los dos trabajos

`tasa_cambio_dia_unica` pasa de `(restaurante_id, fecha, fuente)` a
`(restaurante_id, divisa, fecha, fuente)`.

`divisa` va en **segunda** posición a propósito: el prefijo
`(restaurante_id, divisa)` convierte al propio índice de unicidad en el que
resuelve *"la tasa vigente del euro"* (`ORDER BY fecha DESC LIMIT 1` lo recorre
hacia atrás). Verificado con `EXPLAIN`: el plan usa `tasa_cambio_dia_unica` y no
hizo falta ningún índice nuevo.

Con todo, seamos honestos sobre la magnitud: esta tabla acumula del orden de
**dos mil filas al año** por restaurante. Cualquier índice serviría. La decisión
que importa aquí es la de **unicidad** —qué combinación es "la misma tasa"—, no
el rendimiento. El índice histórico `(restaurante_id, fecha DESC)` se deja como
estaba: sirve a la gráfica del panel, que mezcla divisas.

### 10.4 ⭐ El riesgo real, y por qué se cierra en la base

Este es el motivo por el que este cambio no es sólo "una columna más".

Las dos consultas que eligen la tasa **no filtraban divisa**:

```ts
// comandas.service.ts §cobrar
tx.tasaCambio.findFirst({ where: { restauranteId }, orderBy: { fecha: 'desc' } })
// tasa.service.ts §vigente
this.prisma.tasaCambio.findFirst({ where: { restauranteId }, orderBy: [...] })
```

El día que exista una fila de euro, esas consultas pueden devolverla. El
escenario no es rebuscado: basta con que el dueño cargue hoy el euro y el
último dólar sea de ayer — o con que el job del euro corra y el del dólar falle.
Reproducido en la verificación:

```
Consulta VIEJA (sin filtro):  divisa=EUR valor=990.00000000
Consulta NUEVA (divisa=USD):  divisa=USD valor=915.00000000
→ cada bolívar cobrado se convertiría con un 8,2 % de error
```

Y es un error **silencioso**: no lanza excepción, no rompe el cuadre de la
comanda (los pagos se comparan contra el mismo total mal convertido), y sólo se
manifiesta días después como un cierre de caja que no da. Entre el dólar y el
euro hay un 8-15 %; sobre la facturación de un mes, eso es mucho dinero.

Arreglar las dos consultas es obligatorio, pero **no es suficiente**: la
prohibición no puede depender de que nadie olvide un `where` en el futuro. Se
pone en la base, como el resto de invariantes de este esquema:

| Objeto | Qué impide |
|---|---|
| trigger `comanda_tasa_base` | Que una comanda congele una tasa cuya divisa no sea USD |
| trigger `tasa_divisa_inmutable` | Que una tasa ya congelada por una comanda se convierta *después* en euro con un `UPDATE` |

El segundo existe porque sin él el primero tiene una puerta trasera: el chequeo
ocurre al escribir en `comanda`, así que un `UPDATE tasa_cambio SET divisa`
posterior pasaría desapercibido. Además es la regla correcta por sí sola —una
cotización del dólar no se *convierte* en una del euro, se registra otra fila.

**Por qué triggers y no una columna `comanda.tasa_divisa` + FK compuesta.** La
FK compuesta `(restaurante_id, tasa_id, tasa_divisa)` → `tasa_cambio` con un
`CHECK tasa_divisa = 'USD'` también funcionaría, y de forma declarativa. Se
descartó por la misma razón que en §2 con `salon_id`: **una columna copiada crea
un segundo problema**, mantenerla sincronizada. Y aquí tiene un coste extra —
`Comanda` es una entidad del contrato con el frontend, y le añadiría un campo
redundante que nadie usa. Los triggers dan la misma garantía sin tocar
`Comanda` ni `ComandaPago`.

El trigger de `comanda` sale temprano si `tasa_id` es NULL o no cambió, así que
el `SELECT` extra ocurre **una vez por cobro**, no en cada recálculo de totales
al agregar una ronda. Verificado que ni el `UPDATE` de totales ni el de `notas`
lo disparan.

### 10.5 Qué se permite y qué no (verificado)

| Caso | Resultado |
|---|---|
| Dólar y euro, mismo día y misma fuente | ✅ conviven |
| Dos tasas del mismo día, divisa y fuente | ❌ `23505 tasa_cambio_dia_unica` |
| Misma divisa y día, fuente distinta (BCV vs Binance) | ✅ permitido |
| Congelar la tasa del **euro** al cobrar | ❌ `23514 comanda_tasa_base` |
| Congelar la tasa del **dólar** al cobrar | ✅ sin falso positivo |
| `UPDATE tasa SET divisa='EUR'` | ❌ `23514 tasa_divisa_inmutable` |
| `UPDATE tasa SET valor=...` (corregir un tipeo) | ✅ y **no** reescribe la ya congelada en la comanda |
| Un pago en euros | ❌ imposible de expresar (`22P02`) |

La penúltima fila es la que hace seguro que `POST /tasa` sea un **upsert**:
corregir la tasa de hoy es una operación normal y no toca ningún ticket ya
emitido, porque el cobro **copia** el valor a `comanda.tasa_valor`. Ese es
exactamente el trabajo que hacen las columnas congeladas (§D10).

### 10.6 Un desempate que faltaba desde antes

Al verificar apareció un problema **anterior** a las divisas: con dos fuentes
para el mismo día (BCV y Binance), `ORDER BY fecha DESC LIMIT 1` no es
determinista — Postgres devuelve la fila que le conviene y el resultado puede
cambiar entre ejecuciones. `vigente()` ya desempataba con `creada_en DESC`;
`cobrar()` no.

Queda fijado en el contrato: **`ORDER BY fecha DESC, creada_en DESC`** en las
dos. `fuente` es metadato para mostrar de dónde salió el número, no un selector:
gana la última registrada.

### 10.7 Orden de despliegue

Aplicar la migración sola es seguro: no crea ninguna fila de euro. Lo que no es
seguro es **exponer el alta de euro con el backend viejo**. El orden es:

1. Migración (`prisma migrate deploy`) + `npm run db:verify`.
2. Backend con el filtro `divisa: 'USD'` en `cobrar()` y en `vigente()`.
3. Recién entonces, la UI que registra la tasa del euro.

Si se invierten 2 y 3, el trigger evita el cobro equivocado —pero convirtiendo
cada cobro en un 500. La red de seguridad no sustituye al orden correcto.

---

## 11 · Ventas por mes y por año          *(añadido 2026-09-14)*

> **Estado de verificación:** el esquema se aplicó sobre **PostgreSQL 17.5** y
> `GET /reportes/ventas` se ejercitó de punta a punta contra esa base
> (`test/reportes-periodo.e2e-spec.ts`, 12 aserciones, todas pasan). Dos
> defectos aparecieron ahí y no antes; están explicados abajo.

El pedido fue: *"en ventas debo ver un apartado con filtro de lo que se hizo en
el día, lo que se hizo en el mes y lo que va en el año"*.

### 11.1 Sin objetos nuevos en la base

No se creó ninguna vista. El mes **es** la suma de sus días operativos, y esa
suma es un `GROUP BY` sobre `v_venta_dia` filtrando `fecha_operativa BETWEEN`.
Una `v_venta_mes` sería una **segunda definición de "qué cuenta como venta"**
—hoy: `estado = 'cobrada'`, `ventas_usd` sin propina— capaz de quedarse atrás
el día que la primera cambie. Es el mismo argumento de §2 contra duplicar
`salon_id`: una copia crea el problema de mantenerla sincronizada.

Y no compra rendimiento: medido con 73.000 comandas y 219.000 líneas de un año
(200 comandas diarias, por encima del caso real), el total del año responde en
**~77 ms** sobre un Postgres wasm de 32 bits. El predicado
`(restaurante_id, fecha_operativa)` son columnas de agrupación de la vista, así
que Postgres lo empuja al índice
`comanda (restaurante_id, fecha_operativa, estado)` en vez de agregar la tabla
entera.

Cero DDL tiene además un beneficio que este esquema valora: no añade objetos a
la lista de `99_verificar_objetos.sql` ni superficie a la trampa de §8.

### 11.2 El calendario se calcula en SQL, no en TypeScript

`GET /reportes/ventas` recibe un día ancla opcional y resuelve el rango **en la
base**, por tres razones:

1. El día operativo sale de `hayai_fecha_operativa(now(), zona, corte)`, la
   misma función que materializa `comanda.fecha_operativa` (§5). Calcularlo en
   el backend sería la segunda implementación de la regla.
2. Fin de mes y bisiestos los sabe el calendario de Postgres:
   `date '2026-03-31' - interval '1 month'` es el 28 de febrero, sin casos
   especiales. `setMonth()` en JavaScript da el 3 de marzo.
3. El proceso Node corre con la zona del servidor, que no es la del restaurante.

Esto **cierra un agujero anterior**: el frontend calculaba el día operativo en
el navegador asumiendo corte a las 05:00 y zona local (`useSalesReport.ts`, con
un comentario admitiendo que habría que alimentarlo desde el backend). Ahora
`fecha` es opcional en los cuatro endpoints de reporte y la respuesta trae el
día resuelto.

### 11.3 Los dos defectos que sólo aparecieron al verificar

**El promedio de promedios.** `v_venta_dia.ticket_promedio_usd` es un `avg` por
día y turno. Re-agregarlo con otro `avg` da el promedio de los promedios: con
un día de 3 comandas (100+200+50) y otro de 2 (40+60) sale 83,33, que no es el
ticket de nadie. El ticket del período se calcula `sum(total)/sum(comandas)` =
90,00. Por el mismo motivo **no se devuelve `comensalesPromedio`**: la vista lo
define como `avg(NULLIF(comensales,0))` y esa definición no se puede re-agregar
sin exponer `comandas_con_comensales`. Si la pantalla lo pide, se añade esa
columna a la vista; inventarle otra fórmula daría dos verdades para el mismo
número.

**La comparación entre meses de distinto largo.** La regla intuitiva —restar un
mes a `hasta`— rompe en silencio: junio cerrado tiene `hasta = 30-jun`, y
`30-jun - 1 mes` es el **30 de mayo**, así que la comparación perdía el 31 de
mayo. La regla correcta distingue: período cerrado → el anterior **completo**;
período en curso → el **mismo número de días transcurridos**. El fin del
período anterior es siempre `desde - 1`, porque `desde` es el propio día, el
día 1 del mes o el 1 de enero. No hace falta un `CASE`.

### 11.4 Detalles que el contrato fija

- **Dinero como texto.** Las columnas son `numeric(14,4)`; se devuelven con
  `round(...,4)::text`. Un float de JavaScript mete error de redondeo justo
  donde se cuadra la caja.
- **Serie densa.** Los turnos sin venta, los días cerrados y los meses que aún
  no llegaron se devuelven en cero (`generate_series` / `enum_range` +
  `LEFT JOIN`). Una serie con huecos hace que una gráfica comprima el eje y
  dibuje un mes sin domingos como si se hubiera vendido todos los días.
- **`periodo` se valida.** Entra en un `CASE` cuya rama `ELSE` es el año: sin
  `@IsIn`, un `?periodo=semana` devolvería el año sin avisar de nada.
- **El cierre de caja sigue siendo diario.** `v_venta_dia_metodo` por rango
  sería trivial de añadir, pero cuadrar caja es una operación de un día; un
  acumulado mensual por método es otra pregunta y entrará cuando se pida.

### 11.5 Un efecto colateral que vale la pena conocer

El parche que hace serializable `BigInt` (los `count(*)` de las vistas llegan
como BigInt por el driver adapter) vivía en `main.ts`, que **los tests e2e no
ejecutan**: arrancan `AppModule` + `configurarApp`. Resultado: cualquier
endpoint de reportes respondía 200 en producción y 500 en los tests. Se movió a
`src/comun/json-bigint.ts` y se llama desde `configurarApp`, que es
precisamente lo que existe para que producción y tests no diverjan.
