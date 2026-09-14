import { Type } from 'class-transformer';
import {
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
import { EstadoComandaItem, MetodoPago, Moneda, TipoComanda } from '../../generated/prisma/enums';

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
}

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

export class AgregarItemsDto {
  @IsArray()
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

export class EnviarRondaDto {
  @IsInt()
  @Min(1)
  ronda!: number;
}

export class CambiarEstadoItemDto {
  @IsEnum(EstadoComandaItem)
  estado!: EstadoComandaItem;
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

export class CobrarDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  propina?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  descuento?: number;

  @IsArray()
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
