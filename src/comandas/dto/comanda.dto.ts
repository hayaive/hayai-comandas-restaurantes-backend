import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
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
 * Por eso `items` es obligatorio y con al menos uno: no existe el estado
 * borrador ni un `POST /comandas/:id/enviar` que lo saque después. Una comanda
 * vacía en la cola sería un ticket en blanco en la pantalla de cocina.
 */
export class CrearComandaDto {
  @IsEnum(TipoComanda)
  tipo!: TipoComanda;

  @IsOptional()
  @IsUUID()
  mesaId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  comensales?: number;

  @IsOptional()
  @IsUUID()
  reservacionId?: string;

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

/** `POST /comandas/:id/items` — sólo mientras la comanda siga sin despachar. */
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

export class MoverComandaDto {
  @IsUUID()
  mesaIdDestino!: string;
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
 * `POST /mesas/:mesaId/cobrar` — el cobro es de la MESA, no de una comanda.
 *
 * `comandaIds` es el cobro parcial: si se omite, se cobra todo lo despachado y
 * no cobrado de la mesa. Se decide aquí, a nivel de API, y no en el esquema
 * (`comanda.cobro_id` es una FK simple, no hay tabla puente).
 *
 * Lo que está en cocina y todavía no salió NUNCA entra, se pidan sus ids o no:
 * lo impide el CHECK `comanda_cobro_tras_despacho`. Esa comanda se queda viva y
 * arranca la cuenta siguiente de la mesa.
 */
export class CobrarMesaDto {
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
  @IsUUID('all', { each: true })
  comandaIds?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PagoInputDto)
  pagos!: PagoInputDto[];
}

export class AnularDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  motivo!: string;
}
