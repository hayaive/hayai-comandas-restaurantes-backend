import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginPinDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  usuario!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  pin!: string;
}
