import { Body, Controller, Post } from "@nestjs/common";
import { IsEmail, IsString, MinLength } from "class-validator";
class RegisterDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) password!: string;
}
class EmailDto {
  @IsEmail() email!: string;
}
class VerifyDto {
  @IsEmail() email!: string;
  @IsString() token!: string;
}
class ResetDto {
  @IsEmail() email!: string;
  @IsString() token!: string;
  @IsString() @MinLength(12) newPassword!: string;
}
import { AuthService } from "./auth.service.js";
class LoginDto {
  @IsString() username!: string;
  @IsString() @MinLength(1) password!: string;
}
class TokenDto {
  @IsString() @MinLength(1) refreshToken!: string;
  @IsString() peerId?: string;
}
@Controller("v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post("register") register(@Body() body: RegisterDto) {
    return this.auth.register(body.email, body.password);
  }
  @Post("resend-verification") resend(@Body() body: EmailDto) {
    return this.auth.resendVerification(body.email);
  }
  @Post("verify-email") verify(@Body() body: VerifyDto) {
    return this.auth.verifyEmail(body.email, body.token);
  }
  @Post("password/forgot") forgot(@Body() body: EmailDto) {
    return this.auth.forgotPassword(body.email);
  }
  @Post("password/reset") reset(@Body() body: ResetDto) {
    return this.auth.resetPassword(body.email, body.token, body.newPassword);
  }
  @Post("login") login(@Body() body: LoginDto) {
    return this.auth.login(body.username, body.password);
  }
  @Post("refresh") refresh(@Body() body: TokenDto) {
    return this.auth.refresh(body.refreshToken);
  }
  @Post("logout") logout(@Body() body: TokenDto) {
    return this.auth.logout(body.refreshToken, body.peerId);
  }
}
