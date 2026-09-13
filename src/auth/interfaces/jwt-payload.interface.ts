import { RolUsuario } from '../../generated/prisma/enums';

export interface JwtPayload {
  sub: string; // usuario.id
  restauranteId: string;
  rol: RolUsuario;
}
