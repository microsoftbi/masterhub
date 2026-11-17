import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { CurrentUser, Public, AuthUser } from '../../common/decorators';

class LoginDto {
  @IsString()
  username: string;

  @IsString()
  @MinLength(4, { message: '密码至少 4 位' })
  password: string;
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: any) {
    return this.auth.login(dto.username, dto.password, req.ip);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.profile(user.id);
  }

  @Public()
  @Post('refresh')
  refresh(@Body('token') token: string) {
    return this.auth.refresh(token);
  }
}
