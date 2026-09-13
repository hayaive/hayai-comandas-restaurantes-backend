# HAYAI Comandas · Decisiones de modelado

> Autor: **J.O.R.B.I** (data-engineer) · 2026-09-12
> Acompaña a `prisma/schema.prisma`, `prisma/sql/` y `CONTRACT.md`.
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
| `comanda_mesa_activa_unica` | Panel lateral + invariante | Sólo mesas ocupadas: índice diminuto y constante |
| `plantilla_activa_unica` | Resolver la plantilla vigente | Una fila por salón |
| `comanda_item_cocina_idx` | Cola de cocina/barra | Sólo lo no despachado; lo servido no se consulta más |
| `reservacion_agenda_idx` | Agenda del día | Canceladas y no-show no estorban |
| `comanda_por_cobrar_idx` | Cola del cajero | Suelen ser 2 o 3 filas |
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
| A9 | ¿De dónde sale la tasa BCV? | Tabla `tasa_cambio`, carga manual o job | Bajo |
| A10 | Inventario / recetas / descuento de insumos | Fuera de alcance | Alto: módulo nuevo (existe el precedente de `hayai-saas`) |

**Dos avisos en voz alta para D.A.N.I:**

1. Los totales de la comanda **se recalculan en el servidor** a partir de
   `comanda_item`, nunca se toman del cliente. El frontend los muestra; no los
   decide.
2. `restaurante_id` sale **siempre del token verificado**, jamás del body, de un
   query param o de un header — también en los endpoints públicos de reserva,
   donde sale del `slug` de la ruta resuelto contra la tabla `restaurante`.
