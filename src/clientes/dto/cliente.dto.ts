import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { SeleccionLineaDto } from '../../comandas/dto/comanda.dto';

const recortar = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** `POST /clientes` — abrir una visita. `mesaId` = sentarlo; omitido = sin mesa. */
export class CrearClienteDto {
  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nombre!: string;

  @IsOptional()
  @IsUUID()
  mesaId?: string;
}

export class SentarClienteDto {
  @IsUUID()
  mesaId!: string;
}

export class ListarClientesQueryDto {
  @IsOptional()
  @IsUUID()
  mesaId?: string;

  /** 'true' = sólo los que no tienen mesa. (String a propósito: con la conversión implícita, 'false' sería `true`.) */
  @IsOptional()
  @IsIn(['true', 'false'])
  sinMesa?: string;
}

/** Cliente nuevo al que se pasa la deuda. Sin `mesaId` se sienta donde estaba el cliente de origen. */
export class NuevoClienteDestinoDto {
  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nombre!: string;

  @IsOptional()
  @IsUUID()
  mesaId?: string;
}

/**
 * `POST /clientes/:id/reasignar` — pasa líneas SIN FACTURA a otro cliente.
 * Exactamente uno de `clienteDestinoId` o `nuevoCliente`.
 */
export class ReasignarLineasDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SeleccionLineaDto)
  lineas!: SeleccionLineaDto[];

  @IsOptional()
  @IsUUID()
  clienteDestinoId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NuevoClienteDestinoDto)
  nuevoCliente?: NuevoClienteDestinoDto;
}
