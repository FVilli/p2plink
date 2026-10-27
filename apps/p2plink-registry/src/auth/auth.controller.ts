import { Body, Controller, Post } from "@nestjs/common";
import { IsString, MinLength } from "class-validator";
import { AuthService } from "./auth.service.js";
class LoginDto {
  @IsString() username!: string;
  @IsString() @MinLength(1) password!: string;
}
class TokenDto {
  @IsString() @MinLength(1) refreshToken!: string;
}
@Controller("v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post("login") login(@Body() body: LoginDto) {
    return this.auth.login(body.username, body.password);
  }
  @Post("refresh") refresh(@Body() body: TokenDto) {
    return this.auth.refresh(body.refreshToken);
  }
  @Post("logout") logout(@Body() body: TokenDto) {
    return this.auth.logout(body.refreshToken);
  }
}
