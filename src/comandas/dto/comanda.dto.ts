import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  NotEquals,
  ValidateNested,
} from 'class-validator';
import { MetodoPago, Moneda, TipoComanda } from '../../generated/prisma/enums';

export class ItemEntradaDto {
  @IsUUID()
  productoId!: string;

  @IsNumber()
  @IsPositive()
  cantidad!: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  nota?: string;
}

/**
 * `POST /comandas` — el pedido nace YA en la cola de despacho, con sus líneas,
 * en una sola transacción.
 *
 * Es de un CLIENTE (`clienteId`, obligatorio): la mesa, el salón y la
 * distribución de la comanda son la FOTO de donde está sentado en ese momento.
 * Un cliente sin mesa también pide (`tipo` queda `mesa`, sin mesa). `para_llevar`
 * nunca lleva mesa, aunque el cliente esté sentado.
 *
 * `items` es obligatorio y con al menos uno: no existe el estado borrador ni un
 * `POST /comandas/:id/enviar` que lo saque después. Una comanda vacía en la
 * cola sería un ticket en blanco en la pantalla de cocina.
 */
export class CrearComandaDto {
  @IsUUID()
  clienteId!: string;

  @IsOptional()
  @IsEnum(TipoComanda)
  tipo?: TipoComanda;

  @IsOptional()
  @IsInt()
  @Min(1)
  comensales?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notas?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ItemEntradaDto)
  items!: ItemEntradaDto[];
}

/** `POST /comandas/:id/items` — también en comandas ya despachadas o cobradas (no vuelven a cocina). */
export class AgregarItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ItemEntradaDto)
  items!: ItemEntradaDto[];
}

export class ActualizarItemDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  cantidad?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  nota?: string;
}

export class CancelarItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  motivo!: string;
}

/** Una línea elegida para cobrarla o reasignarla; `cantidad` omitida = la línea entera. */
export class SeleccionLineaDto {
  @IsUUID()
  lineaId!: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  cantidad?: number;
}

export class PagoInputDto {
  @IsEnum(MetodoPago)
  metodo!: MetodoPago;

  @IsEnum(Moneda)
  moneda!: Moneda;

  @IsNumber()
  @IsPositive()
  monto!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;
}

/**
 * `POST /clientes/:id/cobrar` — el cobro es del CLIENTE, por líneas.
 *
 * `lineas` omitido = todo lo facturable (lo despachado y sin factura). Con
 * `lineas`, una `cantidad` menor que la de la línea la PARTE: se cobra esa
 * parte y el resto queda como deuda del mismo cliente. Lo que sigue en cocina
 * NUNCA entra.
 */
export class CobrarClienteDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  propina?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  descuento?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SeleccionLineaDto)
  lineas?: SeleccionLineaDto[];

  /**
   * Nombre que sale en la factura (se congela). Omitido (undefined) = el del
   * cliente. `null` o en blanco = "Consumidor final" (se guarda NULL). Texto =
   * ese nombre, con trim: se puede facturar a otro nombre sin cambiar de cliente.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  clienteNombre?: string | null;

  /** Si tras este cobro el cliente no debe nada (ni lo que está en cocina), lo cierra y libera la mesa. */
  @IsOptional()
  @IsBoolean()
  cerrarCliente?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PagoInputDto)
  pagos!: PagoInputDto[];
}

/** Un pago (monto > 0) o una devolución (monto < 0) sobre una factura emitida. */
export class PagoCorreccionDto {
  @IsEnum(MetodoPago)
  metodo!: MetodoPago;

  @IsEnum(Moneda)
  moneda!: Moneda;

  @IsNumber()
  @NotEquals(0)
  monto!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;
}

/** Cambio sobre una línea YA facturada. */
export class CambioLineaDto {
  @IsUUID()
  lineaId!: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  cantidad?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  nota?: string;

  /** true = anular la línea (el motivo es el `motivo` de la corrección). */
  @IsOptional()
  @IsBoolean()
  anular?: boolean;
}

/** Línea nueva que entra directo en la factura, en una comanda ya despachada del mismo cliente. */
export class AgregarLineaFacturaDto {
  @IsUUID()
  comandaId!: string;

  @IsUUID()
  productoId!: string;

  @IsNumber()
  @IsPositive()
  cantidad!: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  nota?: string;
}

/**
 * `POST /cobros/:id/corregir` — corrige una factura emitida (de cualquier día)
 * y deja la diferencia asentada en la MISMA transacción: si el total sube,
 * `pagos` lleva el cobro adicional; si baja, la devolución (monto negativo).
 * Todo queda en la bitácora con el `motivo`.
 */
export class CorregirCobroDto {
  /** Opcional: si no viene, la bitácora guarda la corrección sin motivo. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  motivo?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CambioLineaDto)
  cambios?: CambioLineaDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgregarLineaFacturaDto)
  agregar?: AgregarLineaFacturaDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  descuento?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  propina?: number;

  /** Mismo criterio que al cobrar: `null`/blanco = Consumidor final; texto = ese nombre. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  clienteNombre?: string | null;

  /** Cobro adicional (+) o devolución (−) que compensa la diferencia. Opcional si el total no cambia. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PagoCorreccionDto)
  pagos?: PagoCorreccionDto[];
}

export class AnularDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  motivo!: string;
}
