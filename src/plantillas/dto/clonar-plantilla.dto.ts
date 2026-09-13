import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ClonarPlantillaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  nombre!: string;
}
