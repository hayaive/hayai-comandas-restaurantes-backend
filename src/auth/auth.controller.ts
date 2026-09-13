import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LoginPinDto } from './dto/login-pin.dto';
import { Publico } from '../comun/decoradores/public.decorator';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Publico()
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.usuario, dto.clave);
  }

  @Publico()
  @HttpCode(200)
  @Post('pin')
  loginPin(@Body() dto: LoginPinDto) {
    return this.auth.loginPin(dto.usuario, dto.pin);
  }

  @Get('yo')
  yo(@UsuarioActual() usuario: UsuarioSesion) {
    return this.auth.yo(usuario.id, usuario.restauranteId);
  }
}
